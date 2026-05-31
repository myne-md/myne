//! Encrypted persistence + load/reconcile for the search index
//! (`search-index` feature, MYND-29 Task 7).
//!
//! This module owns the **testable core** of the persistence lifecycle:
//! - serialize `{manifest, index}` into the opaque inner plaintext of the
//!   protocol `vault.search` (`MYS1`) blob, and the reverse;
//! - read a `.myn` header's `content_nonce` WITHOUT decrypting it (the
//!   staleness signal — any save re-encrypts and changes the nonce);
//! - **reconcile** a loaded index against the notes dir's current nonces:
//!   re-index only the notes whose nonce changed, drop deleted, add new —
//!   producing an index identical to a full rebuild.
//!
//! The IO lifecycle that drives these (load+reconcile on unlock, persist on
//! graceful lock/quit + periodic flush, full rebuild via `note_read`) is the
//! impure shell wired into the unlock/lock paths; this core is pure +
//! injectable (`fetch` closure) so it unit-tests without a Tauri runtime.
//!
//! `manifest` and `index` both ride INSIDE the AEAD envelope: the manifest
//! holds `note_id`s + content nonces (DENY-list correlation tags), so it must
//! never sit in the cleartext blob header. The protocol codec
//! (`search_blob.rs`) is payload-agnostic and treats this whole snapshot as
//! opaque bytes.

use super::{Document, InvertedIndex, SearchIndex};
use protocol::{
    decode_search_index_blob, encode_search_index_blob, SearchBlobError, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, SEARCH_BLOB_ACCOUNT_HASH_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// `.myn` magic — sourced from `protocol::blob` (protocol.md §9.2 offset 0) so
/// a header-format change can't silently rot this decryption-free reader.
const MYN_MAGIC: [u8; 4] = *protocol::blob::MAGIC;
/// Offset of `content_nonce` in the `.myn` header — `protocol::blob` *derives*
/// it from the item-key-wrap sizes, so importing it (not a literal `112`)
/// tracks any future layout shift (protocol.md §9.2).
const MYN_CONTENT_NONCE_OFFSET: usize = protocol::blob::OFFSET_CONTENT_NONCE;
/// Length of `content_nonce` (the XChaCha20-Poly1305 nonce width).
pub const MYN_CONTENT_NONCE_LEN: usize = AEAD_NONCE_LEN;
/// Minimum `.myn` header bytes needed to read `content_nonce`.
pub const MYN_HEADER_PREFIX_FOR_NONCE: usize = MYN_CONTENT_NONCE_OFFSET + MYN_CONTENT_NONCE_LEN;

/// note_id → the note's `.myn` `content_nonce` recorded at index time. The
/// staleness manifest (decryption-free diffable).
pub type NonceManifest = BTreeMap<String, [u8; MYN_CONTENT_NONCE_LEN]>;

/// Borrowed snapshot for the encode side (avoids cloning the index).
#[derive(Serialize)]
struct SnapshotRef<'a> {
    manifest: &'a NonceManifest,
    index: &'a InvertedIndex,
}

/// Owned snapshot for the decode side.
#[derive(Deserialize)]
struct SnapshotOwned {
    manifest: NonceManifest,
    index: InvertedIndex,
}

/// Read a `.myn` file's `content_nonce` from its header bytes WITHOUT
/// decrypting (the decryption-free staleness signal). `header` must be at
/// least the first [`MYN_HEADER_PREFIX_FOR_NONCE`] bytes of the file; returns
/// `None` if too short or the magic is wrong (not a `.myn`).
pub fn read_myn_content_nonce(header: &[u8]) -> Option<[u8; MYN_CONTENT_NONCE_LEN]> {
    if header.len() < MYN_HEADER_PREFIX_FOR_NONCE {
        return None;
    }
    if header[0..4] != MYN_MAGIC {
        return None;
    }
    let mut nonce = [0u8; MYN_CONTENT_NONCE_LEN];
    nonce.copy_from_slice(&header[MYN_CONTENT_NONCE_OFFSET..MYN_HEADER_PREFIX_FOR_NONCE]);
    Some(nonce)
}

/// Encrypt `{manifest, index}` into a `vault.search` (`MYS1`) blob. The caller
/// `atomic_write`s the returned bytes to `<vault>/vault.search`.
pub fn encode_snapshot(
    search_index_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; SEARCH_BLOB_ACCOUNT_HASH_LEN],
    manifest: &NonceManifest,
    index: &InvertedIndex,
) -> Result<Vec<u8>, SearchBlobError> {
    let plaintext = postcard::to_allocvec(&SnapshotRef { manifest, index }).unwrap_or_default();
    encode_search_index_blob(search_index_key, account_number_hash, &plaintext)
}

/// Decrypt + deserialize a `vault.search` blob back into `(manifest, index)`.
/// `None` on any failure (absent/AEAD-fail/unsupported-format/malformed) — the
/// caller falls to a full rebuild.
pub fn decode_snapshot(
    search_index_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; SEARCH_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Option<(NonceManifest, InvertedIndex)> {
    let plaintext = decode_search_index_blob(search_index_key, account_number_hash, blob).ok()?;
    let snap: SnapshotOwned = postcard::from_bytes(&plaintext).ok()?;
    Some((snap.manifest, snap.index))
}

/// Incrementally reconcile a loaded `index` + `manifest` against the notes
/// dir's current `on_disk` nonces, so the result is IDENTICAL to a full
/// rebuild but only touches changed notes:
///
/// - in manifest but not on disk → **deleted** → remove from index + manifest;
/// - on disk with a nonce differing from (or absent in) the manifest →
///   **changed/new** → `fetch` its (title, body), re-index, update manifest;
/// - nonce matches the manifest → **unchanged** → skipped (not fetched).
///
/// `fetch` returns the note's `(title, body)` (the desktop shell decrypts via
/// `note_read`); a `None` return (unreadable note) leaves that note untouched
/// this pass — it retries on the next reconcile.
///
/// A full rebuild is just this called with an empty `index`/`manifest` against
/// every on-disk note.
pub fn reconcile(
    index: &mut InvertedIndex,
    manifest: &mut NonceManifest,
    on_disk: &NonceManifest,
    mut fetch: impl FnMut(&str) -> Option<(String, String)>,
) {
    // Deleted notes: in the manifest but gone from disk.
    let removed: Vec<String> = manifest
        .keys()
        .filter(|id| !on_disk.contains_key(*id))
        .cloned()
        .collect();
    for id in removed {
        index.remove(&id);
        manifest.remove(&id);
    }

    // Changed or new notes: nonce differs from (or is absent in) the manifest.
    for (id, nonce) in on_disk {
        if manifest.get(id) == Some(nonce) {
            continue; // unchanged — skip (no decrypt)
        }
        if let Some((title, body)) = fetch(id) {
            index.add(Document {
                id: id.clone(),
                title,
                body,
            });
            manifest.insert(id.clone(), *nonce);
        }
    }
}

/// Build a fresh index + manifest from scratch (the full-rebuild fallback):
/// `fetch` + index every on-disk note. Equivalent to [`reconcile`] from empty.
pub fn rebuild(
    on_disk: &NonceManifest,
    fetch: impl FnMut(&str) -> Option<(String, String)>,
) -> (NonceManifest, InvertedIndex) {
    let mut index = InvertedIndex::default();
    let mut manifest = NonceManifest::new();
    reconcile(&mut index, &mut manifest, on_disk, fetch);
    (manifest, index)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; SEARCH_BLOB_ACCOUNT_HASH_LEN] = [0x7c; SEARCH_BLOB_ACCOUNT_HASH_LEN];

    fn nonce(b: u8) -> [u8; MYN_CONTENT_NONCE_LEN] {
        [b; MYN_CONTENT_NONCE_LEN]
    }

    fn ids(index: &InvertedIndex, query: &str) -> Vec<String> {
        index.query(query).into_iter().map(|h| h.id).collect()
    }

    // ---- .myn content_nonce reader ------------------------------------

    #[test]
    fn reads_content_nonce_from_valid_header() {
        let mut header = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE];
        header[0..4].copy_from_slice(&MYN_MAGIC);
        header[MYN_CONTENT_NONCE_OFFSET..].copy_from_slice(&nonce(0xAB));
        assert_eq!(read_myn_content_nonce(&header), Some(nonce(0xAB)));
    }

    #[test]
    fn rejects_wrong_magic_and_short_header() {
        let mut header = vec![0u8; MYN_HEADER_PREFIX_FOR_NONCE];
        header[0..4].copy_from_slice(b"XXXX");
        assert_eq!(read_myn_content_nonce(&header), None);
        assert_eq!(read_myn_content_nonce(b"MY01short"), None);
    }

    // ---- snapshot encrypt/decrypt round-trip --------------------------

    #[test]
    fn snapshot_round_trips_through_the_blob() {
        let mut index = InvertedIndex::default();
        index.add(Document {
            id: "a".into(),
            title: "Rust".into(),
            body: "rust async".into(),
        });
        let mut manifest = NonceManifest::new();
        manifest.insert("a".into(), nonce(1));

        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &manifest, &index).expect("encode");
        let (m2, i2) = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(m2, manifest);
        assert_eq!(ids(&i2, "rust"), vec!["a".to_string()]);
    }

    #[test]
    fn decode_snapshot_none_on_wrong_key_or_garbage() {
        let index = InvertedIndex::default();
        let manifest = NonceManifest::new();
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &manifest, &index).expect("encode");
        let wrong = [0x43; AEAD_KEY_LEN];
        assert!(decode_snapshot(&wrong, &ACCOUNT_HASH, &blob).is_none());
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, b"not a blob").is_none());
    }

    // ---- reconcile == rebuild ----------------------------------------

    /// Stub corpus: note_id → (content_nonce, title, body).
    fn corpus() -> Vec<(&'static str, u8, &'static str, &'static str)> {
        vec![
            ("a", 1, "Alpha", "rust async"),
            ("b", 1, "Beta", "python data"),
            ("c", 1, "Gamma", "rust tokio"),
        ]
    }

    fn on_disk_of(c: &[(&'static str, u8, &'static str, &'static str)]) -> NonceManifest {
        c.iter()
            .map(|(id, n, _, _)| ((*id).to_string(), nonce(*n)))
            .collect()
    }

    fn fetch_of(
        c: Vec<(&'static str, u8, &'static str, &'static str)>,
    ) -> impl FnMut(&str) -> Option<(String, String)> {
        move |id| {
            c.iter()
                .find(|(cid, _, _, _)| *cid == id)
                .map(|(_, _, t, b)| ((*t).to_string(), (*b).to_string()))
        }
    }

    #[test]
    fn reconcile_unchanged_skips_fetch_and_matches_rebuild() {
        let c = corpus();
        let (mut manifest, mut index) = rebuild(&on_disk_of(&c), fetch_of(c.clone()));

        // Reconcile against the SAME on-disk state: nothing changed → fetch
        // must not be called.
        let mut fetched = Vec::new();
        reconcile(&mut index, &mut manifest, &on_disk_of(&c), |id| {
            fetched.push(id.to_string());
            None
        });
        assert!(fetched.is_empty(), "unchanged notes must not be re-fetched");
        assert_eq!(ids(&index, "rust"), vec!["a".to_string(), "c".to_string()]);
    }

    #[test]
    fn reconcile_handles_changed_deleted_new_identically_to_rebuild() {
        let initial = corpus();
        let (mut manifest, mut index) = rebuild(&on_disk_of(&initial), fetch_of(initial.clone()));

        // New on-disk state: "a" edited (nonce 1→2, body changed), "b" deleted,
        // "d" added.
        let next: Vec<(&'static str, u8, &'static str, &'static str)> = vec![
            ("a", 2, "Alpha", "rust edited fresh"),
            ("c", 1, "Gamma", "rust tokio"),
            ("d", 1, "Delta", "rust new note"),
        ];

        reconcile(
            &mut index,
            &mut manifest,
            &on_disk_of(&next),
            fetch_of(next.clone()),
        );

        // Compare against a full rebuild from `next`.
        let (rebuilt_manifest, rebuilt_index) = rebuild(&on_disk_of(&next), fetch_of(next.clone()));
        assert_eq!(manifest, rebuilt_manifest);
        // Same query results as the rebuild.
        assert_eq!(ids(&index, "rust"), ids(&rebuilt_index, "rust"));
        // "b" (deleted) gone; "d" (new) present; "a" reflects edited content.
        assert!(ids(&index, "python").is_empty(), "deleted note b dropped");
        assert_eq!(ids(&index, "new"), vec!["d".to_string()]);
        assert_eq!(ids(&index, "edited"), vec!["a".to_string()]);
    }

    #[test]
    fn reconcile_drops_all_when_disk_empty() {
        let c = corpus();
        let (mut manifest, mut index) = rebuild(&on_disk_of(&c), fetch_of(c.clone()));
        reconcile(&mut index, &mut manifest, &NonceManifest::new(), |_| None);
        assert!(manifest.is_empty());
        assert!(index.query("rust").is_empty());
    }
}
