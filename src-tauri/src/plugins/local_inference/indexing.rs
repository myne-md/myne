//! Embed-on-unlock walk + `content_nonce` reconciliation (semantic-search-qa
//! tasks 3 + 4). The machinery that populates the RAM vector store from resident
//! note bodies: chunk each note (task 1) → embed each chunk through the `Engine`
//! seam (task 2 store) → key by `{note_id, byte-range}`; and, incrementally,
//! diff the `{note_id → content_nonce}` manifest to re-embed only changed notes,
//! drop deleted ones, and add new ones (§9.6.4 — `content_nonce` is the
//! cleartext-header staleness signal, no decryption needed to detect it).
//!
//! Pure over provided inputs + injected seams — the "on unlock, walk every note"
//! / "on save, reconcile" **triggers** are the integration remainder (the same
//! unlock/save lifecycle wiring task 2's `app.manage` + teardown want). These
//! functions operate on a caller-supplied note list + an `embed` closure so they
//! are independently testable against a fake embedder + the real chunker/store.
//!
//! Secret-handling: `body` is decrypted plaintext — never log it (DENY-list).
//! Embedding goes ONLY through the `embed` closure (the `Engine::embed` seam);
//! no direct inference-crate dependency here.

#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashSet;

use myne_core::plugins::notes::note_id::NoteId;

use super::chunker::{chunk_note, ChunkParams};
use super::vector_store::{AiVectorStore, ChunkKey};

/// A note ready to index: its id, folder (for the exclusion check), decrypted
/// body, and current `content_nonce`.
#[derive(Debug, Clone)]
pub struct NoteForIndex {
    pub note_id: NoteId,
    /// Canonical trailing-slash folder (`""` = root) — checked against the
    /// exclusion predicate.
    pub folder: String,
    /// Already-decrypted, resident markdown body.
    pub body: String,
    /// The note's `content_nonce` (cleartext-header staleness signal).
    pub content_nonce: Vec<u8>,
}

/// Embed one note into the store: drop any stale vectors for it, chunk the body,
/// embed each chunk, insert keyed by `{note_id, byte-range}`, and record its
/// nonce. Replaces on change (the stale chunk vectors are removed first). Errors
/// from `embed` propagate; a partial embed leaves the note's old vectors already
/// dropped (the caller re-runs on the next pass).
pub fn embed_note<E>(
    store: &mut AiVectorStore,
    note: &NoteForIndex,
    params: ChunkParams,
    mut embed: impl FnMut(&str) -> Result<Vec<f32>, E>,
) -> Result<(), E> {
    store.remove_note(&note.note_id);
    let chunks = chunk_note(note.note_id, &note.body, params);
    for c in &chunks {
        let vector = embed(c.slice(&note.body))?;
        store.insert_vector(ChunkKey::from_chunk(c), vector);
    }
    store.set_nonce(note.note_id, note.content_nonce.clone());
    // Record the folder so `ai_excluded_folders` can be enforced against this
    // note later (query-time filter + on-exclusion-change purge), not just at
    // embed time (SYNC-14).
    store.set_folder(note.note_id, note.folder.clone());
    Ok(())
}

/// Embed-on-unlock walk (task 3): embed every **non-excluded** note into the
/// store. Notes whose folder is excluded (`is_excluded(folder)`) are skipped and
/// never embedded. Uses only the `embed` seam.
pub fn embed_all<E>(
    store: &mut AiVectorStore,
    notes: &[NoteForIndex],
    is_excluded: impl Fn(&str) -> bool,
    params: ChunkParams,
    mut embed: impl FnMut(&str) -> Result<Vec<f32>, E>,
) -> Result<(), E> {
    for note in notes {
        if is_excluded(&note.folder) {
            // A note whose folder is excluded must not just be skipped — if it
            // was embedded before the exclusion (or moved into an excluded
            // folder) its stale vectors must be dropped, not left resident
            // (SYNC-14). `remove_note` is a no-op when the note was never
            // embedded.
            store.remove_note(&note.note_id);
            continue;
        }
        embed_note(store, note, params, &mut embed)?;
    }
    Ok(())
}

/// The incremental plan from a `content_nonce` reconciliation (task 4).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReconcilePlan {
    /// Notes to (re-)chunk + (re-)embed: new notes + notes whose nonce changed.
    pub to_embed: Vec<NoteId>,
    /// Notes whose vectors must be dropped: present in the manifest but gone
    /// from the current set (deleted).
    pub to_drop: Vec<NoteId>,
}

/// Diff the store's `content_nonce` manifest against the current note set.
/// Unchanged notes (same nonce) appear in neither list; changed/new notes go to
/// `to_embed`; deleted notes (in the manifest, absent from `current`) go to
/// `to_drop`. Pure; both lists are sorted for deterministic order.
pub fn reconcile(store: &AiVectorStore, current: &[(NoteId, Vec<u8>)]) -> ReconcilePlan {
    let mut to_embed = Vec::new();
    let current_ids: HashSet<NoteId> = current.iter().map(|(id, _)| *id).collect();

    for (id, nonce) in current {
        match store.nonce(id) {
            Some(prev) if prev == nonce.as_slice() => {} // unchanged → skip
            _ => to_embed.push(*id),                     // new or changed
        }
    }

    let mut to_drop: Vec<NoteId> = store
        .embedded_note_ids()
        .into_iter()
        .filter(|id| !current_ids.contains(id))
        .collect();

    to_embed.sort();
    to_drop.sort();
    ReconcilePlan { to_embed, to_drop }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nid(last: &str) -> NoteId {
        NoteId::parse(&format!("01970e83-4f2f-7000-8000-0000000000{last}")).unwrap()
    }

    /// Deterministic fake embedder: a 1-dim vector of the text's char count, so
    /// tests can assert distinct-per-content vectors without a model.
    fn fake_embed(text: &str) -> Result<Vec<f32>, ()> {
        Ok(vec![text.chars().count() as f32])
    }

    fn note(last: &str, folder: &str, body: &str, nonce: u8) -> NoteForIndex {
        NoteForIndex {
            note_id: nid(last),
            folder: folder.to_string(),
            body: body.to_string(),
            content_nonce: vec![nonce],
        }
    }

    #[test]
    fn embed_note_populates_vectors_and_nonce() {
        let mut store = AiVectorStore::new();
        let n = note("31", "Notes/", "# Title\n\nbody paragraph", 1);
        embed_note(&mut store, &n, ChunkParams::default(), fake_embed).unwrap();
        assert!(!store.is_empty(), "chunks embedded");
        assert_eq!(store.nonce(&nid("31")), Some([1u8].as_slice()));
    }

    #[test]
    fn embed_note_replaces_stale_vectors_on_change() {
        let mut store = AiVectorStore::new();
        let v1 = note("32", "Notes/", "short", 1);
        embed_note(&mut store, &v1, ChunkParams::default(), fake_embed).unwrap();
        let after_first = store.len();

        // Same note, longer body, new nonce → old vectors replaced.
        let v2 = note(
            "32",
            "Notes/",
            "a much longer body with more content here",
            2,
        );
        embed_note(&mut store, &v2, ChunkParams::default(), fake_embed).unwrap();
        // Only note 32's vectors are present (stale ones dropped, not accumulated).
        assert!(store.iter().all(|(k, _)| k.note_id == nid("32")));
        assert_eq!(store.nonce(&nid("32")), Some([2u8].as_slice()));
        // The single-paragraph bodies each chunk to one vector, so len stays 1.
        assert_eq!(store.len(), 1);
        let _ = after_first;
    }

    #[test]
    fn embed_all_skips_excluded_notes() {
        let mut store = AiVectorStore::new();
        let notes = vec![
            note("33", "Notes/", "keep me", 1),
            note("34", "Private/", "secret", 1),
        ];
        embed_all(
            &mut store,
            &notes,
            |folder| folder == "Private/",
            ChunkParams::default(),
            fake_embed,
        )
        .unwrap();
        // Only the non-excluded note is embedded.
        assert!(store.iter().all(|(k, _)| k.note_id == nid("33")));
        assert_eq!(store.nonce(&nid("33")), Some([1u8].as_slice()));
        assert_eq!(
            store.nonce(&nid("34")),
            None,
            "excluded note never embedded"
        );
    }

    #[test]
    fn embed_all_populates_nonce_for_every_embedded_note() {
        let mut store = AiVectorStore::new();
        let notes = vec![note("35", "A/", "one", 7), note("36", "B/", "two", 8)];
        embed_all(
            &mut store,
            &notes,
            |_| false,
            ChunkParams::default(),
            fake_embed,
        )
        .unwrap();
        assert_eq!(store.nonce(&nid("35")), Some([7u8].as_slice()));
        assert_eq!(store.nonce(&nid("36")), Some([8u8].as_slice()));
    }

    #[test]
    fn reconcile_skips_unchanged_reembeds_changed_adds_new_drops_deleted() {
        let mut store = AiVectorStore::new();
        // Manifest: A(nonce 1), B(nonce 1), C(nonce 1) embedded.
        for (id, nonce) in [("41", 1u8), ("42", 1), ("43", 1)] {
            store.set_nonce(nid(id), vec![nonce]);
        }
        // Current: A unchanged(1), B changed(2), C absent(deleted), D new(1).
        let current = vec![
            (nid("41"), vec![1u8]),
            (nid("42"), vec![2u8]),
            (nid("44"), vec![1u8]),
        ];
        let plan = reconcile(&store, &current);
        // Changed(B=42) + new(D=44) → embed; deleted(C=43) → drop; A unchanged.
        assert_eq!(plan.to_embed, vec![nid("42"), nid("44")]);
        assert_eq!(plan.to_drop, vec![nid("43")]);
        assert!(
            !plan.to_embed.contains(&nid("41")),
            "unchanged not re-embedded"
        );
    }

    #[test]
    fn reconcile_empty_manifest_embeds_all_current() {
        let store = AiVectorStore::new();
        let current = vec![(nid("45"), vec![1u8]), (nid("46"), vec![1u8])];
        let plan = reconcile(&store, &current);
        assert_eq!(plan.to_embed, vec![nid("45"), nid("46")]);
        assert!(plan.to_drop.is_empty());
    }

    #[test]
    fn reconcile_all_deleted_drops_all() {
        let mut store = AiVectorStore::new();
        store.set_nonce(nid("47"), vec![1u8]);
        store.set_nonce(nid("48"), vec![1u8]);
        let plan = reconcile(&store, &[]);
        assert!(plan.to_embed.is_empty());
        assert_eq!(plan.to_drop, vec![nid("47"), nid("48")]);
    }
}
