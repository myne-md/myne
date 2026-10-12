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
use crate::note_nonce::NonceManifest;
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
    use crate::note_nonce::MYN_CONTENT_NONCE_LEN;
    use crate::plugins::vault_indices::state::{
        BlockAnchor, HeadingEntry, PropertyEntry, TagEntry, TaskRecord, WikilinkEdge,
    };

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
            block_anchors: vec![BlockAnchor {
                block_id: "intro".to_string(),
                preview: "The introduction paragraph.".to_string(),
            }],
            // MYND-612: opaque verbatim task fields. The round-trip below is the
            // whole contract on the Rust side — the values must come back
            // byte-identical, because nothing here is allowed to interpret them.
            tasks: vec![TaskRecord {
                line_index: 7,
                raw_line: "- [ ] pay the rent [due:: 2026-08-01] [priority:: high]".to_string(),
                completed: false,
                oversized: false,
                due: Some("2026-08-01".to_string()),
                repeat: None,
                done: None,
                priority: Some("high".to_string()),
                remind: None,
            }],
            // myne#216: headings ride the same snapshot, so the round-trip below
            // covers them too — a postcard field that encodes but does not
            // decode would strand the `[[##` picker on an empty set after every
            // unlock, which no other assertion here would catch.
            headings: vec![
                HeadingEntry {
                    text: "Overview".to_string(),
                    level: 1,
                },
                HeadingEntry {
                    text: "Details".to_string(),
                    level: 2,
                },
            ],
            // myne-md/myne#848: rides the same snapshot, so the round-trip below
            // covers it, a postcard field that encoded but did not decode would
            // reset every note to LIVE after each unlock, which is the one
            // direction of this field's failure no other assertion here catches.
            live: true,
        }
    }

    fn records() -> BTreeMap<String, NoteRecord> {
        let mut m = BTreeMap::new();
        m.insert("a".to_string(), record_with_property("Alpha"));
        // `b` is a HIDDEN note (myne-md/myne#848) on purpose: with both records
        // live, the round-trip below would prove only that `true` survives
        // postcard, and a field that came back `true` for every record would
        // pass it. The false side is the one the agent's scope depends on.
        m.insert(
            "b".to_string(),
            NoteRecord {
                live: false,
                ..record_with_property("Beta")
            },
        );
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
        // …and so did the working-set verdict, on both sides of it.
        assert!(r2["a"].live);
        assert!(!r2["b"].live, "a hidden note must not come back live");
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

    /// A record as it was serialized BEFORE a trailing field was added: the
    /// same shape as [`NoteRecord`] minus `headings`. Only ever written, never
    /// read, which is what lets it stand in for a snapshot an older build left
    /// on disk.
    #[derive(Serialize)]
    struct PreHeadingsRecord {
        title: Option<String>,
        folder: Option<String>,
        title_key: Option<String>,
        edges: Vec<WikilinkEdge>,
        tags: Vec<TagEntry>,
        properties: Vec<PropertyEntry>,
        block_anchors: Vec<BlockAnchor>,
        tasks: Vec<TaskRecord>,
    }

    #[derive(Serialize)]
    struct PreHeadingsSnapshot<'a> {
        manifest: &'a NonceManifest,
        records: &'a BTreeMap<String, PreHeadingsRecord>,
    }

    /// A record as it was serialized AFTER `headings` landed and BEFORE `live`
    /// did, which is the shape a vault that persisted in between holds.
    ///
    /// **This is the fixture the `live` question is actually about** (review
    /// finding). `PreHeadingsRecord` above cannot reach the NEW last field: its
    /// read dies on `headings` and never arrives, so the pin built on it proves
    /// something about the field before the one under test.
    #[derive(Serialize)]
    struct PreLiveRecord {
        title: Option<String>,
        folder: Option<String>,
        title_key: Option<String>,
        edges: Vec<WikilinkEdge>,
        tags: Vec<TagEntry>,
        properties: Vec<PropertyEntry>,
        block_anchors: Vec<BlockAnchor>,
        tasks: Vec<TaskRecord>,
        headings: Vec<HeadingEntry>,
    }

    #[derive(Serialize)]
    struct PreLiveSnapshot<'a> {
        manifest: &'a NonceManifest,
        records: &'a BTreeMap<String, PreLiveRecord>,
    }

    fn pre_live_record(title: &str) -> PreLiveRecord {
        let full = record_with_property(title);
        PreLiveRecord {
            title: full.title,
            folder: full.folder,
            title_key: full.title_key,
            edges: full.edges,
            tags: full.tags,
            properties: full.properties,
            block_anchors: full.block_anchors,
            tasks: full.tasks,
            headings: full.headings,
        }
    }

    fn pre_headings_record(title: &str) -> PreHeadingsRecord {
        let full = record_with_property(title);
        PreHeadingsRecord {
            title: full.title,
            folder: full.folder,
            title_key: full.title_key,
            edges: full.edges,
            tags: full.tags,
            properties: full.properties,
            block_anchors: full.block_anchors,
            tasks: full.tasks,
        }
    }

    /// **`#[serde(default)]` does NOT make an older snapshot readable, and the
    /// spec depends on it not doing so.**
    ///
    /// postcard is non-self-describing and positional: `deserialize_struct`
    /// hands serde a `SeqAccess` sized to the TARGET struct's field count, so
    /// the reader always attempts an Nth field and `#[serde(default)]` never
    /// fires at end of input. A snapshot written before a trailing field existed
    /// therefore fails to decode, `decode_snapshot` answers `None`, and the load
    /// path falls to the §9.8.4 rebuild.
    ///
    /// That is the ONLY reason `index_format_version` could stay at `0x02` when
    /// myne#216 added `headings`: the serializer already forces the rebuild a
    /// version bump would have forced. `docs/spec/protocol.md` §9.8.2 and
    /// `docs/decisions/protocol/0594` both rest on it, and §9.8.2 says in as
    /// many words that this is an implementation property of the serializer
    /// rather than a guarantee of the format. So it is pinned here rather than
    /// believed: if a postcard or serde-derive change ever makes `next_element`
    /// return `Ok(None)` at end of input, this test goes red and the two
    /// documents have to be revisited before anything ships.
    ///
    /// Both shapes are covered because they fail for different reasons. With one
    /// record the buffer simply ends; with two, the reader consumes the NEXT
    /// record's leading bytes as the missing field and desynchronises, which is
    /// the case that could in principle decode into garbage rather than erroring.
    #[test]
    fn a_snapshot_missing_a_trailing_field_fails_to_decode_rather_than_defaulting() {
        for count in [1usize, 2] {
            let mut recs: BTreeMap<String, PreHeadingsRecord> = BTreeMap::new();
            for i in 0..count {
                recs.insert(format!("note-{i}"), pre_headings_record("Alpha"));
            }
            let manifest = NonceManifest::new();
            let plaintext = postcard::to_allocvec(&PreHeadingsSnapshot {
                manifest: &manifest,
                records: &recs,
            })
            .expect("the pre-headings snapshot serializes");
            let blob = encode_vault_indices_blob(&KEY, &ACCOUNT_HASH, &plaintext)
                .expect("the blob envelope encodes");

            assert!(
                decode_snapshot(&KEY, &ACCOUNT_HASH, &blob).is_none(),
                "a {count}-record snapshot missing its trailing `headings` field decoded instead \
                 of failing. `#[serde(default)]` is filling it, so an older blob now loads with \
                 an empty heading set and reports itself complete. protocol.md §9.8.2 and \
                 decision 0594 both argue the opposite and must be corrected before this ships"
            );
        }
    }

    /// The shape the per-note trailing-field question is about in THIS change:
    /// a snapshot written between `headings` and `live`, so the read reaches the
    /// new last field rather than dying earlier.
    ///
    /// One record is the easy case, and it fails to decode at end of input, which
    /// is why the field can be trailing at all. Two records is the case
    /// `docs/spec/protocol.md` §9.8.2 warns about: the reader consumes the next
    /// record's bytes as the missing field, and `from_bytes` has no trailing-byte
    /// check, so a read whose remaining bytes satisfy the UTF-8 and discriminant
    /// checks can terminate successfully with a WRONG map. This test pins which
    /// of the two happens, because `live` is a permission input now rather than
    /// display data: a wrong map's `live` values are what an agent's scope
    /// resolves against.
    #[test]
    fn a_snapshot_written_before_the_live_field_does_not_load_as_a_complete_index() {
        for count in [1usize, 2] {
            let mut recs: BTreeMap<String, PreLiveRecord> = BTreeMap::new();
            for i in 0..count {
                recs.insert(format!("note-{i}"), pre_live_record("Alpha"));
            }
            let manifest = NonceManifest::new();
            let plaintext = postcard::to_allocvec(&PreLiveSnapshot {
                manifest: &manifest,
                records: &recs,
            })
            .expect("the pre-live snapshot serializes");
            let blob = encode_vault_indices_blob(&KEY, &ACCOUNT_HASH, &plaintext)
                .expect("the blob envelope encodes");

            assert!(
                decode_snapshot(&KEY, &ACCOUNT_HASH, &blob).is_none(),
                "a {count}-record snapshot missing its trailing `live` field decoded. That is \
                 protocol.md §9.8.2's residual for a per-note trailing field, and it is now a \
                 permission input: the map it produced is a wrong scope rather than a wrong \
                 heading list. Close it (a trailing-byte check, or an `index_format_version` \
                 bump, which §9.8.2 says would) before this field can be trusted"
            );
        }
    }

    /// The other direction, so the test above cannot pass by decoding nothing:
    /// the CURRENT shape through the same envelope decodes fine.
    #[test]
    fn the_current_snapshot_shape_decodes_through_the_same_envelope() {
        let recs = records();
        let manifest = manifest_of(&[("a", 1)]);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &manifest, &recs).expect("encode");
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob).is_some());
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
