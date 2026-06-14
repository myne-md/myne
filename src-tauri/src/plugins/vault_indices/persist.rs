//! Encrypted persistence + Build-B reconcile-delta for the VaultIndices
//! (`vault.indices` / `MYI1`, MYND-271 Task 8; design MYND-31).
//!
//! The **testable core** of the persistence lifecycle, split from the impure
//! Tauri shell (`commands.rs`):
//! - serialize the in-RAM `{manifest, records}` snapshot into the opaque inner
//!   plaintext of the protocol `vault.indices` (`MYI1`) blob, and the reverse;
//! - compute the **reconcile delta** between a loaded snapshot's nonce manifest
//!   and the notes dir's current `content_nonce`s (the decryption-free
//!   staleness signal): which note ids are stale (changed / new → TS must
//!   re-apply) and which are deleted (gone from disk → drop from the store).
//!
//! Unlike the search index (which Rust rebuilds itself), VaultIndices is
//! Build-B: extraction is TS-side. So the load path here cannot re-extract a
//! changed note; instead it returns the stale ids to TS, which re-reads,
//! re-parses, and re-applies only those (the rebuild-on-unlock sweep, narrowed
//! to the delta). The persisted blob is a derived, rebuildable cache. An
//! absent, AEAD-failed, or unsupported-format blob decodes to an empty load,
//! every on-disk note becomes stale, and TS does a full rebuild; deleting the
//! blob loses nothing (spec §9.8.4 / SYNC-1).
//!
//! The `manifest` (note_id → content_nonce) and `records` (title / folder /
//! edges / tags / typed properties — all plaintext-derived) both ride INSIDE
//! the AEAD envelope; the protocol codec (`vault_indices_blob.rs`) treats the
//! whole snapshot as opaque bytes (AS3/AS4).

use super::state::NoteRecord;
use crate::search::persist::NonceManifest;
use protocol::{
    decode_vault_indices_blob, encode_vault_indices_blob, VaultIndicesBlobError, AEAD_KEY_LEN,
    VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The full index snapshot persisted inside the `MYI1` blob. `BTreeMap`s give a
/// deterministic serialization order (postcard is positional, but ordered keys
/// keep the bytes stable across runs for the same logical state).
#[derive(Serialize)]
struct SnapshotRef<'a> {
    manifest: &'a NonceManifest,
    records: &'a BTreeMap<String, NoteRecord>,
}

/// Owned snapshot for the decode side.
#[derive(Deserialize)]
struct SnapshotOwned {
    manifest: NonceManifest,
    records: BTreeMap<String, NoteRecord>,
}

/// Encrypt `{manifest, records}` into a `vault.indices` (`MYI1`) blob. The
/// caller `atomic_write`s the returned bytes to `<vault>/vault.indices`.
pub fn encode_snapshot(
    vault_indices_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    manifest: &NonceManifest,
    records: &BTreeMap<String, NoteRecord>,
) -> Result<Vec<u8>, VaultIndicesBlobError> {
    let plaintext = postcard::to_allocvec(&SnapshotRef { manifest, records }).unwrap_or_default();
    encode_vault_indices_blob(vault_indices_key, account_number_hash, &plaintext)
}

/// Decrypt + deserialize a `vault.indices` blob back into `(manifest, records)`.
/// `None` on any failure (absent / AEAD-fail / unsupported-format / malformed)
/// — the caller falls to a full TS rebuild (every on-disk note is stale).
pub fn decode_snapshot(
    vault_indices_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Option<(NonceManifest, BTreeMap<String, NoteRecord>)> {
    let plaintext = decode_vault_indices_blob(vault_indices_key, account_number_hash, blob).ok()?;
    let snap: SnapshotOwned = postcard::from_bytes(&plaintext).ok()?;
    Some((snap.manifest, snap.records))
}

/// The Build-B reconcile delta between a loaded snapshot's `manifest` and the
/// notes dir's current `on_disk` nonces:
/// - **stale** = on disk with a nonce differing from (or absent in) the
///   manifest → changed / new → TS must re-read + re-parse + re-apply these.
/// - **deleted** = in the manifest but gone from disk → drop from the store.
///
/// Unchanged notes (nonce matches) are in neither list — their loaded record is
/// kept as-is (the whole point of the fast path: no re-extraction). A full
/// rebuild is just this with an empty `manifest` → every on-disk id is stale.
pub struct ReconcileDelta {
    pub stale: Vec<String>,
    pub deleted: Vec<String>,
}

pub fn reconcile_delta(manifest: &NonceManifest, on_disk: &NonceManifest) -> ReconcileDelta {
    let stale: Vec<String> = on_disk
        .iter()
        .filter(|(id, nonce)| manifest.get(*id) != Some(*nonce))
        .map(|(id, _)| id.clone())
        .collect();
    let deleted: Vec<String> = manifest
        .keys()
        .filter(|id| !on_disk.contains_key(*id))
        .cloned()
        .collect();
    ReconcileDelta { stale, deleted }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_indices::state::{PropertyEntry, TagEntry, WikilinkEdge};
    use crate::search::persist::MYN_CONTENT_NONCE_LEN;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN] =
        [0x33; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN];

    fn nonce(b: u8) -> [u8; MYN_CONTENT_NONCE_LEN] {
        [b; MYN_CONTENT_NONCE_LEN]
    }

    fn record_with_property(title: &str) -> NoteRecord {
        NoteRecord {
            title: Some(title.to_string()),
            folder: Some("Projects/".to_string()),
            title_key: Some(title.to_lowercase()),
            edges: vec![WikilinkEdge {
                target: "Other".to_string(),
                target_kind: "title".to_string(),
                title_key: "other".to_string(),
                anchor: None,
                block_id: None,
                alias: None,
                embed: false,
                byte_start: 0,
                byte_end: 7,
            }],
            tags: vec![TagEntry {
                folded: "area/proj".to_string(),
                display: "Area/Proj".to_string(),
            }],
            properties: vec![PropertyEntry {
                key: "status".to_string(),
                r#type: "string".to_string(),
                value: Some("in-progress".to_string()),
                elements: None,
            }],
        }
    }

    fn records() -> BTreeMap<String, NoteRecord> {
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), record_with_property("Alpha"));
        m.insert("b".to_string(), record_with_property("Beta"));
        m
    }

    fn manifest_of(pairs: &[(&str, u8)]) -> NonceManifest {
        pairs
            .iter()
            .map(|(id, n)| ((*id).to_string(), nonce(*n)))
            .collect()
    }

    #[test]
    fn snapshot_round_trips_through_the_blob_with_typed_properties() {
        let recs = records();
        let manifest = manifest_of(&[("a", 1), ("b", 1)]);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &manifest, &recs).expect("encode");
        // Magic must be MYI1 (the codec's header).
        assert_eq!(&blob[0..4], b"MYI1");
        let (m2, r2) = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(m2, manifest);
        assert_eq!(r2, recs);
        // The typed property survived the postcard round-trip.
        assert_eq!(r2["a"].properties[0].value.as_deref(), Some("in-progress"));
    }

    #[test]
    fn decode_none_on_wrong_key_or_garbage() {
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &NonceManifest::new(), &records())
            .expect("encode");
        let wrong = [0x43; AEAD_KEY_LEN];
        assert!(decode_snapshot(&wrong, &ACCOUNT_HASH, &blob).is_none());
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, b"not a blob").is_none());
        // Cross-vault: a different account_number_hash fails the AAD bind.
        let other_hash = [0x44; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN];
        assert!(decode_snapshot(&KEY, &other_hash, &blob).is_none());
    }

    #[test]
    fn reconcile_delta_flags_changed_new_and_deleted() {
        // Loaded manifest: a@1, b@1, c@1.
        let loaded = manifest_of(&[("a", 1), ("b", 1), ("c", 1)]);
        // On disk now: a@2 (changed), b@1 (unchanged), d@1 (new); c deleted.
        let on_disk = manifest_of(&[("a", 2), ("b", 1), ("d", 1)]);
        let delta = reconcile_delta(&loaded, &on_disk);
        let mut stale = delta.stale.clone();
        stale.sort();
        assert_eq!(stale, vec!["a".to_string(), "d".to_string()]);
        assert_eq!(delta.deleted, vec!["c".to_string()]);
    }

    #[test]
    fn empty_manifest_makes_every_on_disk_note_stale() {
        // The absent/undecodable-blob fallback: empty loaded manifest → every
        // on-disk note is stale → a full TS rebuild.
        let on_disk = manifest_of(&[("a", 1), ("b", 1)]);
        let delta = reconcile_delta(&NonceManifest::new(), &on_disk);
        let mut stale = delta.stale.clone();
        stale.sort();
        assert_eq!(stale, vec!["a".to_string(), "b".to_string()]);
        assert!(delta.deleted.is_empty());
    }
}
