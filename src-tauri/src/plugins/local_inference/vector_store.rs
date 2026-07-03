//! RAM chunk-vector store (semantic-search-qa task 2, SYNC-1/4/10) — one
//! `app.manage`d state holding every resident chunk embedding keyed to
//! `{note_id, byte-range}` (the `vault_indices` one-state-many-consumers
//! pattern), plus the RAM-only `{note_id → content_nonce}` staleness manifest
//! (§9.6.4) that task 4's re-embed reconciliation reads.
//!
//! ## Persisted as an encrypted rebuildable cache, zeroized on every slot-drop
//!
//! Embeddings are derived from decrypted note plaintext, so the RAM store is an
//! **AS1-class RAM artifact** and is **zeroized** at every slot-drop site
//! (manual lock, idle auto-lock, vault delete, credential-rotation relock),
//! wired into the same teardown the `VaultLifecycleHooks::zeroize_*` sites use.
//! [`AiVectorStore::zeroize`] overwrites every vector element before dropping so
//! a best-effort wipe holds regardless of allocator reuse.
//!
//! Since MYND-453 the store's contents ARE persisted between sessions — but only
//! as an **encrypted, `root_key`-derived, rebuildable cache**: the
//! `vault.embeddings` (`MYR1`) blob (`protocol.md` §9.17, codec
//! [`super::embeddings_persist`]). It is the `vault.search` posture applied to
//! embeddings: written on graceful lock / lazy flush, reconciled via
//! `content_nonce` on unlock, fall-to-rebuild on any mismatch (including a
//! model swap via the model-identity tuple), and **never synced / never
//! backed up** (`sync-protocol.md` §319, Class 3). The RAM store stays the
//! source of truth in-session; the blob is only its durable copy.
//!
//! Secret-handling: a vector is derived from plaintext — never log a vector, a
//! `content_nonce`, or a `note_id` (see `src-tauri/CLAUDE.md` "Secret-handling
//! logging discipline"; `note_id` is a vault-stable correlation tag).
//!
//! ## Scope of this slice
//!
//! The data structure + insert/lookup + zeroize semantics land here and are
//! unit-tested in isolation. Binding [`AiVectorStore::zeroize`] into the real
//! unlock-walk / teardown sites (a `VaultLifecycleHooks` method + `app.manage`
//! registration) is the integration remainder tracked in the feature's
//! `progress.md` — this module stays pure and independently testable.

// Forward-declared: the embed-on-unlock pipeline (task 3) is the first in-crate
// caller; until then the non-test build never touches these. Same `model_store`
// idiom used by the chunker.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashMap;
use std::ops::Range;
use std::sync::{Mutex, MutexGuard};

use myne_core::plugins::notes::note_id::NoteId;
use zeroize::Zeroize;

use super::chunker::Chunk;

/// Hashable key for a resident chunk vector: the source note plus the byte span
/// the chunk covers. `Range<usize>` is not `Hash`, so the span is stored as
/// `(start, end)` — [`ChunkKey::from_chunk`] bridges from [`Chunk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ChunkKey {
    pub note_id: NoteId,
    pub start: usize,
    pub end: usize,
}

impl ChunkKey {
    /// Build a key from a chunker [`Chunk`].
    pub fn from_chunk(chunk: &Chunk) -> Self {
        ChunkKey {
            note_id: chunk.note_id,
            start: chunk.byte_range.start,
            end: chunk.byte_range.end,
        }
    }

    /// The byte span as a `Range`, for resolving `source[range]`.
    pub fn byte_range(&self) -> Range<usize> {
        self.start..self.end
    }
}

/// One `app.manage`d RAM store: chunk vectors + the note→nonce staleness
/// manifest. Not `Sync`-wrapped here — the plugin wraps it in the same
/// `tokio::sync::Mutex` the vault-runtime state uses so an `.await`-held guard
/// stays `Send` (`src-tauri/CLAUDE.md` Gotchas).
#[derive(Debug, Default)]
pub struct AiVectorStore {
    /// `{note_id, byte-range}` → embedding. 384-dim in production (SYNC-1); the
    /// store is dimension-agnostic (the stub embeds shorter).
    vectors: HashMap<ChunkKey, Vec<f32>>,
    /// `note_id` → `content_nonce` (cleartext-header nonce, §9.6.4). RAM-only;
    /// task 4 compares it to detect a changed note without decrypting.
    nonces: HashMap<NoteId, Vec<u8>>,
    /// `note_id` → canonical trailing-slash folder (`""` = root). Recorded at
    /// embed time and persisted in the blob, so `ai_excluded_folders` can be
    /// enforced against ALREADY-embedded/reloaded notes (query-time filter +
    /// on-exclusion-change purge) — not just at embed time (SYNC-14). A folder
    /// is plaintext-derived metadata (AS3), so it is wiped on [`zeroize`].
    folders: HashMap<NoteId, String>,
    /// Live copy of `ai_excluded_folders` (canonical trailing-slash entries).
    /// The single in-RAM source of truth the query-time filter consults, so a
    /// search never re-reads `vault.prefs` from disk. Refreshed on unlock and on
    /// every `ai_excluded_folders` write.
    excluded: Vec<String>,
    /// Live copy of the `ai_enabled` opt-in. When `false` the store is kept
    /// empty and every query short-circuits to no results — a host-side opt-out
    /// enforcement that does not trust the WebView to stop calling.
    enabled: bool,
}

impl AiVectorStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace the vector for a chunk key.
    pub fn insert_vector(&mut self, key: ChunkKey, vector: Vec<f32>) {
        self.vectors.insert(key, vector);
    }

    /// Look up a chunk's vector.
    pub fn vector(&self, key: &ChunkKey) -> Option<&[f32]> {
        self.vectors.get(key).map(Vec::as_slice)
    }

    /// Record (or update) a note's `content_nonce` for staleness reconciliation.
    pub fn set_nonce(&mut self, note_id: NoteId, nonce: Vec<u8>) {
        self.nonces.insert(note_id, nonce);
    }

    /// The recorded `content_nonce` for a note, if embedded.
    pub fn nonce(&self, note_id: &NoteId) -> Option<&[u8]> {
        self.nonces.get(note_id).map(Vec::as_slice)
    }

    /// Record (or update) a note's canonical folder (for exclusion checks).
    pub fn set_folder(&mut self, note_id: NoteId, folder: String) {
        self.folders.insert(note_id, folder);
    }

    /// The recorded folder for a note, if embedded.
    pub fn folder(&self, note_id: &NoteId) -> Option<&str> {
        self.folders.get(note_id).map(String::as_str)
    }

    /// Whether the store is currently serving results (`ai_enabled`).
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Refresh the live policy (opt-in + excluded set) the query-time filter and
    /// purge consult. Canonicalizes the excluded entries (NFC + case-fold) so
    /// the comparison agrees with the frontend mirror and is diacritic/case
    /// robust on case-insensitive filesystems (SYNC-14).
    pub fn set_policy(&mut self, enabled: bool, excluded: &[String]) {
        self.enabled = enabled;
        self.excluded = excluded.iter().map(|e| canonical_folder(e)).collect();
    }

    /// Whether `note_id`'s recorded folder is under any excluded entry — the
    /// query-time defense-in-depth filter (a resident vector for a now-excluded
    /// note can never surface). An unknown note (no recorded folder) is treated
    /// as excluded (fail-closed): it should not be resident, and if it is we do
    /// not leak it.
    pub fn is_note_excluded(&self, note_id: &NoteId) -> bool {
        match self.folders.get(note_id) {
            Some(folder) => folder_matches_excluded(folder, &self.excluded),
            None => true,
        }
    }

    /// Drop every note whose recorded folder is now excluded (used by both the
    /// on-exclusion-change path and the unlock-walk purge). Returns the number of
    /// notes purged. Overwrites the removed vectors first (via [`remove_note`]).
    pub fn purge_excluded(&mut self) -> usize {
        let doomed: Vec<NoteId> = self
            .folders
            .iter()
            .filter(|(_, folder)| folder_matches_excluded(folder, &self.excluded))
            .map(|(id, _)| *id)
            .collect();
        for id in &doomed {
            self.remove_note(id);
        }
        doomed.len()
    }

    /// Every note currently represented in the `content_nonce` manifest (i.e.
    /// embedded at least once). The reconciliation diff (task 4) walks this to
    /// find notes that have since been deleted.
    pub fn embedded_note_ids(&self) -> Vec<NoteId> {
        self.nonces.keys().copied().collect()
    }

    /// Number of resident chunk vectors.
    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    /// True when no vectors are resident.
    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    /// Iterate `(&ChunkKey, &[f32])` over every resident vector — the retrieval
    /// service (task 5) scores against this.
    pub fn iter(&self) -> impl Iterator<Item = (&ChunkKey, &[f32])> {
        self.vectors.iter().map(|(k, v)| (k, v.as_slice()))
    }

    /// Drop every vector for a note (task 4: a changed/deleted note's stale
    /// chunks are replaced/removed). Overwrites the removed vectors first.
    pub fn remove_note(&mut self, note_id: &NoteId) {
        let keys: Vec<ChunkKey> = self
            .vectors
            .keys()
            .filter(|k| &k.note_id == note_id)
            .copied()
            .collect();
        for k in keys {
            if let Some(mut v) = self.vectors.remove(&k) {
                zeroize_vec(&mut v);
            }
        }
        // Overwrite the plaintext-derived nonce bytes + folder string before the
        // map drop frees them, matching `zeroize()` — a plain `.remove()` left
        // these AS3 correlation tags resident in the freed capacity.
        if let Some(mut n) = self.nonces.remove(note_id) {
            n.iter_mut().for_each(|b| *b = 0);
        }
        if let Some(mut f) = self.folders.remove(note_id) {
            f.zeroize();
        }
    }

    /// **Zeroize the entire store** (every slot-drop site). Overwrites every
    /// vector element and every nonce byte to zero before clearing the maps, so
    /// the wipe is best-effort-durable even if the freed capacity is reused.
    /// Idempotent — safe to call on an already-empty store.
    pub fn zeroize(&mut self) {
        for v in self.vectors.values_mut() {
            zeroize_vec(v);
        }
        self.vectors.clear();
        for n in self.nonces.values_mut() {
            n.iter_mut().for_each(|b| *b = 0);
        }
        self.nonces.clear();
        // Folder names are plaintext-derived metadata (AS3) — overwrite before
        // dropping. The policy (excluded set + opt-in) resets to fail-closed.
        for f in self.folders.values_mut() {
            f.zeroize();
        }
        self.folders.clear();
        for e in self.excluded.iter_mut() {
            e.zeroize();
        }
        self.excluded.clear();
        self.enabled = false;
    }
}

/// Canonicalize a folder path for exclusion comparison: NFC-normalize then
/// case-fold (lowercase). Trailing-slash canonicalization already happened in
/// the prefs codec; this makes the match diacritic- and case-insensitive so a
/// note under `Private/` is still excluded when the entry was typed `private/`
/// on a case-insensitive filesystem (SYNC-14). Kept byte-for-byte identical to
/// the frontend mirror (`src/lib/aiExcludedFolders.ts`).
pub fn canonical_folder(folder: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    folder.nfc().collect::<String>().to_lowercase()
}

/// Whether a note's `folder` (RAW, un-canonicalized) is under any entry in the
/// ALREADY-canonicalized `excluded` set. Equal-or-nested test via a trailing-
/// slash prefix (an entry ends in `/`, so `Private/` matches `Private/Sub/` but
/// not `PrivateStuff/`). An empty entry is ignored (would exclude the whole
/// vault). `folder` is canonicalized here so callers pass raw folders.
pub fn folder_matches_excluded(folder: &str, excluded: &[String]) -> bool {
    let folder = canonical_folder(folder);
    excluded.iter().any(|ex| {
        !ex.is_empty() && (folder == *ex || (ex.ends_with('/') && folder.starts_with(ex.as_str())))
    })
}

/// Overwrite a vector's elements to `0.0` in place (best-effort RAM wipe). Not
/// `zeroize::Zeroize` because `f32` is not `DefaultIsZeroes`; a plain overwrite
/// is the equivalent for float embeddings and avoids widening the dep surface.
fn zeroize_vec(v: &mut Vec<f32>) {
    v.iter_mut().for_each(|x| *x = 0.0);
    v.clear();
}

/// App-managed handle to the RAM vector store (semantic-search-qa task 2) — the
/// structural twin of [`crate::plugins::vault_indices::VaultIndicesState`].
/// Registered via `app.manage` in the plugin `setup`; the lock-teardown sites
/// borrow it to [`clear`](Self::clear) on every slot-drop so the plaintext-
/// derived embeddings never outlive the `Slot::Unlocked` session.
///
/// `std::sync::Mutex` (not `tokio`) because every access — insert/lookup by the
/// embed pipeline + retrieval, and the sync `clear` on lock — completes without
/// an `.await` held across the guard (the model calls run under the command
/// layer's `spawn_blocking`, not while this guard is held).
#[derive(Debug, Default)]
pub struct LocalInferenceVectorState {
    store: Mutex<AiVectorStore>,
    /// Monotonic teardown counter, bumped on every [`clear`]. A detached embed
    /// walk captures it before its work and re-checks it (under the store lock)
    /// before publishing, so a lock/auto-lock that zeroized the store mid-walk
    /// makes the publish a no-op — teardown strictly wins the check-then-fill
    /// race that would otherwise leave plaintext-derived vectors resident for a
    /// locked vault (AS1).
    generation: std::sync::atomic::AtomicU64,
}

impl LocalInferenceVectorState {
    /// Borrow the inner store. A poisoned mutex recovers the guard — the store
    /// is a plaintext-derived cache, so a panic mid-mutation can't make it
    /// unsafe, only stale, and the next unlock rebuilds it.
    pub fn lock(&self) -> MutexGuard<'_, AiVectorStore> {
        self.store
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// Zeroize + empty the store on lock teardown. Sync + infallible — the twin
    /// of `VaultIndicesState::clear`. Bumps the teardown generation so an
    /// in-flight embed walk's publish becomes a no-op.
    pub fn clear(&self) {
        // Hold the store guard across BOTH the zeroize and the generation bump.
        // The publish path (hydrate.rs) reads generation() and swaps under this
        // same guard, so bumping the generation outside it left a window where a
        // publisher could read the pre-teardown generation, pass its staleness
        // check, and repopulate a just-cleared (locked-vault) store with fresh
        // plaintext-derived vectors. Bumping under the guard makes teardown win.
        let mut store = self.lock();
        store.zeroize();
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }

    /// The current teardown generation (see the field docs).
    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nid(last: &str) -> NoteId {
        NoteId::parse(&format!("01970e83-4f2f-7000-8000-0000000000{last}")).unwrap()
    }

    fn key(note: NoteId, start: usize, end: usize) -> ChunkKey {
        ChunkKey {
            note_id: note,
            start,
            end,
        }
    }

    #[test]
    fn insert_then_lookup_by_key() {
        let mut store = AiVectorStore::new();
        let k = key(nid("01"), 0, 10);
        store.insert_vector(k, vec![1.0, 2.0, 3.0]);
        assert_eq!(store.vector(&k), Some([1.0, 2.0, 3.0].as_slice()));
        assert_eq!(store.len(), 1);
        assert!(!store.is_empty());
    }

    #[test]
    fn chunk_key_round_trips_range() {
        let chunk = Chunk {
            note_id: nid("02"),
            byte_range: 5..17,
        };
        let k = ChunkKey::from_chunk(&chunk);
        assert_eq!(k.note_id, nid("02"));
        assert_eq!(k.byte_range(), 5..17);
    }

    #[test]
    fn distinct_ranges_of_same_note_are_distinct_keys() {
        let mut store = AiVectorStore::new();
        let n = nid("03");
        store.insert_vector(key(n, 0, 10), vec![1.0]);
        store.insert_vector(key(n, 10, 20), vec![2.0]);
        assert_eq!(store.len(), 2);
        assert_eq!(store.vector(&key(n, 0, 10)), Some([1.0].as_slice()));
        assert_eq!(store.vector(&key(n, 10, 20)), Some([2.0].as_slice()));
    }

    #[test]
    fn insert_same_key_replaces() {
        let mut store = AiVectorStore::new();
        let k = key(nid("04"), 0, 4);
        store.insert_vector(k, vec![1.0]);
        store.insert_vector(k, vec![9.0, 9.0]);
        assert_eq!(store.vector(&k), Some([9.0, 9.0].as_slice()));
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn nonce_manifest_set_and_get() {
        let mut store = AiVectorStore::new();
        let n = nid("05");
        store.set_nonce(n, vec![7u8; 24]);
        assert_eq!(store.nonce(&n), Some([7u8; 24].as_slice()));
        assert_eq!(store.nonce(&nid("06")), None);
    }

    #[test]
    fn remove_note_drops_only_that_notes_vectors() {
        let mut store = AiVectorStore::new();
        let a = nid("07");
        let b = nid("08");
        store.insert_vector(key(a, 0, 5), vec![1.0]);
        store.insert_vector(key(a, 5, 10), vec![2.0]);
        store.insert_vector(key(b, 0, 5), vec![3.0]);
        store.set_nonce(a, vec![1, 2, 3]);
        store.set_nonce(b, vec![4, 5, 6]);

        store.remove_note(&a);

        assert_eq!(store.len(), 1);
        assert_eq!(store.vector(&key(b, 0, 5)), Some([3.0].as_slice()));
        assert_eq!(store.nonce(&a), None);
        assert_eq!(store.nonce(&b), Some([4, 5, 6].as_slice()));
    }

    #[test]
    fn zeroize_empties_vectors_and_nonces() {
        let mut store = AiVectorStore::new();
        store.insert_vector(key(nid("09"), 0, 5), vec![1.0, 2.0, 3.0]);
        store.set_nonce(nid("09"), vec![9u8; 24]);
        assert!(!store.is_empty());

        store.zeroize();

        assert!(store.is_empty());
        assert_eq!(store.len(), 0);
        assert_eq!(store.nonce(&nid("09")), None);
        assert!(store.iter().next().is_none());
    }

    #[test]
    fn zeroize_is_idempotent_on_empty_store() {
        let mut store = AiVectorStore::new();
        store.zeroize();
        store.zeroize();
        assert!(store.is_empty());
    }

    #[test]
    fn purge_excluded_drops_only_now_excluded_notes() {
        // SYNC-14: a note embedded BEFORE its folder was excluded must be purged
        // from the resident store when the exclusion set is applied.
        let mut store = AiVectorStore::new();
        let keep = nid("20");
        let secret = nid("21");
        store.insert_vector(key(keep, 0, 5), vec![1.0]);
        store.set_nonce(keep, vec![1]);
        store.set_folder(keep, "Notes/".into());
        store.insert_vector(key(secret, 0, 5), vec![2.0]);
        store.set_nonce(secret, vec![2]);
        store.set_folder(secret, "Private/Journal/".into());

        store.set_policy(true, &["Private/".to_string()]);
        let purged = store.purge_excluded();

        assert_eq!(purged, 1);
        assert_eq!(store.vector(&key(keep, 0, 5)), Some([1.0].as_slice()));
        assert_eq!(store.vector(&key(secret, 0, 5)), None);
        assert_eq!(store.nonce(&secret), None);
        assert_eq!(store.folder(&secret), None);
    }

    #[test]
    fn is_note_excluded_is_case_and_nfc_insensitive_and_fail_closed() {
        let mut store = AiVectorStore::new();
        let n = nid("22");
        store.set_folder(n, "Private/Notes/".into());
        // Entry typed with different case still matches (case-insensitive FS).
        store.set_policy(true, &["private/".to_string()]);
        assert!(store.is_note_excluded(&n));
        // A sibling that merely shares a prefix is NOT excluded.
        let sib = nid("23");
        store.set_folder(sib, "PrivateStuff/".into());
        assert!(!store.is_note_excluded(&sib));
        // An unknown note (no recorded folder) is fail-closed excluded.
        assert!(store.is_note_excluded(&nid("24")));
    }

    #[test]
    fn set_policy_disabled_and_zeroize_reset_policy() {
        let mut store = AiVectorStore::new();
        store.set_policy(true, &["Private/".to_string()]);
        assert!(store.is_enabled());
        store.set_policy(false, &[]);
        assert!(!store.is_enabled());
        store.set_policy(true, &["X/".to_string()]);
        store.zeroize();
        assert!(!store.is_enabled(), "lock resets opt-in to fail-closed");
    }

    #[test]
    fn iter_yields_all_resident_vectors() {
        let mut store = AiVectorStore::new();
        let n = nid("10");
        store.insert_vector(key(n, 0, 5), vec![1.0]);
        store.insert_vector(key(n, 5, 10), vec![2.0]);
        let count = store.iter().count();
        assert_eq!(count, 2);
    }

    #[test]
    fn managed_state_clear_zeroizes_the_store() {
        let state = LocalInferenceVectorState::default();
        {
            let mut store = state.lock();
            store.insert_vector(key(nid("11"), 0, 5), vec![1.0, 2.0]);
            store.set_nonce(nid("11"), vec![9u8; 24]);
            assert!(!store.is_empty());
        }
        // The lock-teardown call (hooks + auto_lock wire this into every
        // slot-drop site).
        state.clear();
        assert!(state.lock().is_empty());
        assert_eq!(state.lock().nonce(&nid("11")), None);
    }
}
