//! Encrypted persistence for the AI embedding index (`vault.embeddings` /
//! `MYR1`, MYND-453; `protocol.md` §9.17).
//!
//! The **testable core** of the persistence lifecycle, split from the impure
//! Tauri shell (`commands.rs` / `hydrate.rs`):
//! - serialize the in-RAM [`AiVectorStore`] (chunk vectors + `{note_id →
//!   content_nonce}` manifest) plus the [`EmbeddingsIdentity`] tuple into the
//!   opaque inner plaintext of the protocol `vault.embeddings` (`MYR1`) blob,
//!   and the reverse;
//! - **fall-to-rebuild** on decode: `None` on absent / AEAD-fail /
//!   unsupported-format / malformed / **model-identity mismatch** (a model,
//!   dimension, or chunker change → the whole index is re-embedded, §9.17.4).
//!
//! The manifest and the dense vectors are both plaintext-derived (AS1); the
//! protocol codec (`embeddings_blob.rs`) treats the whole snapshot as opaque
//! bytes. Unlike `vault.search`, this blob also carries a trailing
//! model-identity tuple `{model_identity, embedding_dim, chunker_version}` — the
//! embeddings analogue of `vault.search`'s `extractor_version` (§9.17.2), which
//! rides INSIDE the payload (NOT the AAD, which stays vault-scoped like every
//! sibling blob).
//!
//! Secret-handling: a vector / `content_nonce` / `note_id` is plaintext-derived
//! — never log one (see `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline").

// Wired into hydrate/persist (tasks 4/5) as the first callers; keep the pure
// codec independently testable until then.
#![cfg_attr(not(test), allow(dead_code))]

use super::vector_store::{AiVectorStore, ChunkKey};
use myne_core::plugins::notes::note_id::NoteId;
use protocol::{
    decode_embeddings_blob, encode_embeddings_blob, EmbeddingsBlobError, AEAD_KEY_LEN,
    EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// WHICH embedder produced the vectors — a tagged union, because as of
/// `embeddings_format_version 0x02` the embedder need not be a file this
/// process can read (§9.17.2).
///
/// The tag is what makes the two derivations comparable at all: a snapshot
/// built by a side-loaded model and one built by a served model are never
/// equal, which is correct — their vectors are not comparable either.
///
/// **postcard is positional and non-self-describing**, so this enum's variant
/// ORDER is load-bearing: reordering re-interprets every already-written
/// snapshot's discriminant. Append; never insert or reorder. (The `0x01`
/// snapshots that predate the tag are refused at the envelope by
/// `EMBEDDINGS_BLOB_FORMAT_V2`, so they never reach this decoder.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelIdentity {
    /// A side-loaded model the client can hash: `SHA-256` over the selected
    /// embedding safetensors bytes, computed once at model-pick time
    /// (`model_store`). Unchanged in meaning from `0x01`'s bare `model_hash`.
    FileHash([u8; 32]),
    /// A model served by a runtime over an API (the Ollama arm). There is no
    /// file to hash, so the identity is what the runtime reports: the model
    /// **name** plus the **content digest** it publishes for that name.
    ///
    /// Before this arm existed the served case produced NO identity at all,
    /// and `hydrate.rs` skipped both the load and the persist — so the whole
    /// vault was re-embedded on **every** unlock, silently reinstating the
    /// cost `MYR1` exists to remove.
    ///
    /// Residual, stated rather than hidden: a user who re-tags a *different*
    /// model under the same name and digest defeats this, and only the
    /// independent `embedding_dim` check would then notice — and only if the
    /// dimensionality also changed. §9.17.4 bounds the damage to a slower
    /// unlock, never to a wrong answer surviving. A fixed-probe-vector
    /// identity would catch it and was rejected: floating-point variation
    /// across hardware and runtimes would trigger spurious full re-embeds
    /// (`decisions.md` 2026-08-09).
    Served { name: String, digest: String },
}

/// The model-identity tuple bound into the snapshot (§9.17.2). A change to ANY
/// field invalidates the whole persisted index → fall-to-rebuild (§9.17.4),
/// because embedding vectors are model-specific and incomparable across models,
/// dimensions, or chunk boundaries.
///
/// - `model` — [`ModelIdentity`], the embedder itself (either derivation).
/// - `embedding_dim` — the vector dimensionality the model emits (384 for
///   MiniLM-L6); a mismatch is caught here rather than at cosine time. For a
///   served model this is the second, INDEPENDENT check — it comes from a live
///   `embed()` probe rather than from the runtime's own bookkeeping.
/// - `chunker_version` — the [`super::chunker::CHUNKER_VERSION`] generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingsIdentity {
    pub model: ModelIdentity,
    pub embedding_dim: u32,
    pub chunker_version: u16,
}

/// One resident chunk vector, flattened for deterministic serialization.
#[derive(Serialize, Deserialize)]
struct VectorRecord {
    note_id: String,
    start: usize,
    end: usize,
    vector: Vec<f32>,
}

/// Borrowed snapshot for the encode side. `BTreeMap` + a sorted `vectors` list
/// give a deterministic byte output for the same logical state (postcard is
/// positional; ordered inputs keep golden vectors stable).
#[derive(Serialize)]
struct SnapshotRef<'a> {
    manifest: &'a BTreeMap<String, Vec<u8>>,
    vectors: &'a [VectorRecord],
    identity: &'a EmbeddingsIdentity,
    /// `note_id → canonical folder`, so `ai_excluded_folders` can be enforced
    /// against reloaded (unchanged) notes after a warm unlock — the folder is
    /// otherwise unavailable without re-decrypting every note (SYNC-14).
    folders: &'a BTreeMap<String, String>,
}

/// Owned snapshot for the decode side.
#[derive(Deserialize)]
struct SnapshotOwned {
    manifest: BTreeMap<String, Vec<u8>>,
    vectors: Vec<VectorRecord>,
    identity: EmbeddingsIdentity,
    /// `note_id → canonical folder` (see [`SnapshotRef::folders`]). A blob
    /// written before this field existed fails postcard decode (positional
    /// format) and falls to a full rebuild (§9.17.4) — acceptable for a
    /// rebuildable cache, and there are no shipped `MYR1` blobs to migrate.
    folders: BTreeMap<String, String>,
}

/// The `{note_id → content_nonce}` staleness manifest, sorted for determinism.
fn build_manifest(store: &AiVectorStore) -> BTreeMap<String, Vec<u8>> {
    store
        .embedded_note_ids()
        .into_iter()
        .filter_map(|id| store.nonce(&id).map(|n| (id.to_string(), n.to_vec())))
        .collect()
}

/// The `{note_id → folder}` map, sorted for determinism.
fn build_folders(store: &AiVectorStore) -> BTreeMap<String, String> {
    store
        .embedded_note_ids()
        .into_iter()
        .filter_map(|id| store.folder(&id).map(|f| (id.to_string(), f.to_string())))
        .collect()
}

/// The resident vectors, sorted by `(note_id, start, end)` for determinism.
fn build_vectors_sorted(store: &AiVectorStore) -> Vec<VectorRecord> {
    let mut v: Vec<VectorRecord> = store
        .iter()
        .map(|(k, vec)| VectorRecord {
            note_id: k.note_id.to_string(),
            start: k.start,
            end: k.end,
            vector: vec.to_vec(),
        })
        .collect();
    v.sort_by(|a, b| {
        (a.note_id.as_str(), a.start, a.end).cmp(&(b.note_id.as_str(), b.start, b.end))
    });
    v
}

/// Encrypt the store + identity into a `vault.embeddings` (`MYR1`) blob. The
/// caller `atomic_write`s the returned bytes to `<vault>/vault.embeddings`.
pub fn encode_snapshot(
    ai_embeddings_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN],
    store: &AiVectorStore,
    identity: &EmbeddingsIdentity,
) -> Result<Vec<u8>, EmbeddingsBlobError> {
    let manifest = build_manifest(store);
    let vectors = build_vectors_sorted(store);
    let folders = build_folders(store);
    let plaintext = postcard::to_allocvec(&SnapshotRef {
        manifest: &manifest,
        vectors: &vectors,
        identity,
        folders: &folders,
    })
    .unwrap_or_default();
    encode_embeddings_blob(ai_embeddings_key, account_number_hash, &plaintext)
}

/// Decrypt + deserialize a `vault.embeddings` blob back into an
/// [`AiVectorStore`]. `None` on ANY failure — absent / AEAD-fail /
/// unsupported-format / malformed / **model-identity mismatch** — which the
/// caller treats as fall-to-rebuild (re-embed the whole vault, §9.17.4).
///
/// `expect_identity` is the client's CURRENT model-identity tuple; a stored
/// tuple that differs (a model swap, a dimension change, or a
/// `CHUNKER_VERSION` bump) discards the whole index rather than serving
/// semantically-wrong vectors.
pub fn decode_snapshot(
    ai_embeddings_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
    expect_identity: &EmbeddingsIdentity,
) -> Option<AiVectorStore> {
    let plaintext = decode_embeddings_blob(ai_embeddings_key, account_number_hash, blob).ok()?;
    let snap: SnapshotOwned = postcard::from_bytes(&plaintext).ok()?;
    // Fall-to-rebuild on model-identity mismatch (§9.17.4): a model / dimension
    // / chunker change makes the stored vectors incomparable → discard.
    if snap.identity != *expect_identity {
        return None;
    }
    let mut store = AiVectorStore::new();
    for (id, nonce) in snap.manifest {
        if let Ok(nid) = NoteId::parse(&id) {
            store.set_nonce(nid, nonce);
        }
    }
    for (id, folder) in snap.folders {
        if let Ok(nid) = NoteId::parse(&id) {
            store.set_folder(nid, folder);
        }
    }
    for rec in snap.vectors {
        if let Ok(nid) = NoteId::parse(&rec.note_id) {
            store.insert_vector(
                ChunkKey {
                    note_id: nid,
                    start: rec.start,
                    end: rec.end,
                },
                rec.vector,
            );
        }
    }
    Some(store)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN] =
        [0x33; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN];

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

    fn identity(model_byte: u8, dim: u32, chunker: u16) -> EmbeddingsIdentity {
        EmbeddingsIdentity {
            model: ModelIdentity::FileHash([model_byte; 32]),
            embedding_dim: dim,
            chunker_version: chunker,
        }
    }

    /// The served (Ollama) derivation: the runtime's model name + the content
    /// digest it publishes for that name.
    fn served(name: &str, digest: &str, dim: u32, chunker: u16) -> EmbeddingsIdentity {
        EmbeddingsIdentity {
            model: ModelIdentity::Served {
                name: name.into(),
                digest: digest.into(),
            },
            embedding_dim: dim,
            chunker_version: chunker,
        }
    }

    fn sample_store() -> AiVectorStore {
        let mut store = AiVectorStore::new();
        let a = nid("01");
        let b = nid("02");
        store.insert_vector(key(a, 0, 10), vec![0.1, 0.2, 0.3]);
        store.insert_vector(key(a, 10, 20), vec![0.4, 0.5, 0.6]);
        store.insert_vector(key(b, 0, 8), vec![0.7, 0.8, 0.9]);
        store.set_nonce(a, vec![1u8; 24]);
        store.set_nonce(b, vec![2u8; 24]);
        store.set_folder(a, "Notes/".into());
        store.set_folder(b, "Private/".into());
        store
    }

    #[test]
    fn snapshot_round_trips_through_the_blob() {
        let store = sample_store();
        let id = identity(0xAA, 3, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        // Magic must be MYR1 (the codec's header).
        assert_eq!(&blob[0..4], b"MYR1");
        let out = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id).expect("decode");
        // Vectors + nonces reconstruct exactly.
        assert_eq!(out.len(), 3);
        assert_eq!(
            out.vector(&key(nid("01"), 0, 10)),
            Some([0.1, 0.2, 0.3].as_slice())
        );
        assert_eq!(
            out.vector(&key(nid("01"), 10, 20)),
            Some([0.4, 0.5, 0.6].as_slice())
        );
        assert_eq!(
            out.vector(&key(nid("02"), 0, 8)),
            Some([0.7, 0.8, 0.9].as_slice())
        );
        assert_eq!(out.nonce(&nid("01")), Some([1u8; 24].as_slice()));
        assert_eq!(out.nonce(&nid("02")), Some([2u8; 24].as_slice()));
        // Folders round-trip so exclusion can be enforced against reloaded notes.
        assert_eq!(out.folder(&nid("01")), Some("Notes/"));
        assert_eq!(out.folder(&nid("02")), Some("Private/"));
    }

    #[test]
    fn empty_store_round_trips() {
        let store = AiVectorStore::new();
        let id = identity(0x11, 384, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        let out = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id).expect("decode");
        assert!(out.is_empty());
    }

    #[test]
    fn decode_none_on_model_hash_mismatch() {
        // LOAD-BEARING (§9.17.4): a model swap (different model_hash) discards
        // the whole index rather than serving stale MiniLM vectors as fresh.
        let store = sample_store();
        let built = identity(0xAA, 384, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let swapped = identity(0xBB, 384, 1); // different model
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &swapped).is_none());
    }

    #[test]
    fn decode_none_on_embedding_dim_mismatch() {
        let store = sample_store();
        let built = identity(0xAA, 384, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let redim = identity(0xAA, 768, 1); // different dimension
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &redim).is_none());
    }

    #[test]
    fn decode_none_on_chunker_version_bump() {
        let store = sample_store();
        let built = identity(0xAA, 384, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let bumped = identity(0xAA, 384, 2); // chunker logic changed
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &bumped).is_none());
    }

    #[test]
    fn matching_identity_decodes_ok() {
        let store = sample_store();
        let id = identity(0x7C, 384, 3);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id).is_some());
    }

    #[test]
    fn decoded_store_reconciles_only_the_delta() {
        // The load-bearing value of persistence (§9.17.4): after a reload, an
        // UNCHANGED note is NOT re-embedded — only the changed/new/deleted delta.
        use crate::plugins::local_inference::indexing::reconcile;
        let store = sample_store(); // notes 01 (nonce 1×24), 02 (nonce 2×24)
        let id = identity(0xAA, 3, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        let loaded = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id).expect("decode");

        // Current on disk: 01 unchanged, 02 changed (new nonce), 03 new.
        let current = vec![
            (nid("01"), vec![1u8; 24]),
            (nid("02"), vec![9u8; 24]),
            (nid("03"), vec![5u8; 24]),
        ];
        let plan = reconcile(&loaded, &current);
        assert_eq!(plan.to_embed, vec![nid("02"), nid("03")]);
        assert!(plan.to_drop.is_empty());
        assert!(
            !plan.to_embed.contains(&nid("01")),
            "an unchanged note must not be re-embedded after a reload"
        );
    }

    #[test]
    fn served_identity_round_trips() {
        // The regression this whole change exists to fix: an Ollama-served
        // embedder has no file to hash, so before the tagged union it produced
        // NO identity — the snapshot was never written and every unlock
        // re-embedded the entire vault.
        let store = sample_store();
        let id = served("nomic-embed-text", "sha256:c2d1a9f0", 768, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        let out = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id).expect("decode");
        assert_eq!(out.len(), 3);
        assert_eq!(out.nonce(&nid("01")), Some([1u8; 24].as_slice()));
    }

    #[test]
    fn decode_none_on_served_model_name_change() {
        // Rejection case 1 of 3 (§9.17.4): the runtime now serves a DIFFERENT
        // model. Its vectors are incomparable → rebuild, not a wrong load.
        let store = sample_store();
        let built = served("nomic-embed-text", "sha256:c2d1a9f0", 768, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let other = served("mxbai-embed-large", "sha256:c2d1a9f0", 768, 1);
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &other).is_none());
    }

    #[test]
    fn decode_none_on_served_digest_change() {
        // Rejection case 2 of 3: same NAME, new content digest — the tag was
        // re-pointed at different weights. This is the case a name-only
        // identity would miss, which is why the digest is carried.
        let store = sample_store();
        let built = served("nomic-embed-text", "sha256:c2d1a9f0", 768, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let repointed = served("nomic-embed-text", "sha256:ffffffff", 768, 1);
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &repointed).is_none());
    }

    #[test]
    fn decode_none_on_served_dim_change() {
        // Rejection case 3 of 3: the INDEPENDENT check. `embedding_dim` comes
        // from a live embed() probe, not from the runtime's bookkeeping, so it
        // still fires when a substituted model lies about its name and digest.
        let store = sample_store();
        let built = served("nomic-embed-text", "sha256:c2d1a9f0", 768, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &built).expect("encode");
        let redim = served("nomic-embed-text", "sha256:c2d1a9f0", 384, 1);
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &redim).is_none());
    }

    #[test]
    fn decode_none_across_identity_arms() {
        // Switching between a side-loaded file and a served runtime is a model
        // change like any other, even if the two happened to agree on
        // dimension and chunker. The tag is what makes them comparable at all.
        let store = sample_store();
        let file_built = identity(0xAA, 768, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &file_built).expect("encode");
        let now_served = served("nomic-embed-text", "sha256:c2d1a9f0", 768, 1);
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &now_served).is_none());

        // And the reverse direction.
        let blob2 = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &now_served).expect("encode");
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, &blob2, &file_built).is_none());
    }

    #[test]
    fn a_superseded_snapshot_is_refused_at_the_envelope_not_at_postcard() {
        // The version bump, verified by BREAKING it rather than by running it
        // (repo-root AGENTS.md). The claim under test is the exact one in
        // §9.17.2: postcard is non-self-describing, so a `0x01` payload can
        // decode under a `0x02` reader into a GARBAGE identity — and a garbage
        // identity that happens to compare EQUAL serves semantically wrong
        // vectors. The envelope byte is what makes the rejection deterministic.
        #[derive(Deserialize)]
        struct LegacyIdentity {
            model_hash: [u8; 32],
            #[allow(dead_code)]
            embedding_dim: u32,
            #[allow(dead_code)]
            chunker_version: u16,
        }

        let current = identity(0xAA, 384, 1);

        // The exact bytes a 0x02 reader consumes as `current`.
        let bytes = postcard::to_allocvec(&current).expect("v2 identity encode");
        // Those SAME bytes are a well-formed 0x01 identity — a bare 32-byte
        // hash plus two varints — so this payload is one an older client could
        // really have written, not a synthetic shape.
        let as_legacy: LegacyIdentity =
            postcard::from_bytes(&bytes).expect("also a valid legacy identity");
        assert_ne!(
            as_legacy.model_hash, [0xAA; 32],
            "the two readings must disagree, or this proves nothing"
        );

        // A whole legacy payload: empty manifest, empty vectors, that identity,
        // empty folders (postcard writes an empty map/seq as a single 0x00).
        let mut legacy = vec![0x00, 0x00];
        legacy.extend_from_slice(&bytes);
        legacy.push(0x00);

        // Seal with the current codec, then stamp the header back to 0x01. The
        // version byte is outside the AEAD-bound region, so this is a faithful
        // stand-in for a blob written by an older client.
        let mut blob =
            protocol::encode_embeddings_blob(&KEY, &ACCOUNT_HASH, &legacy).expect("envelope");
        assert_eq!(blob[5], protocol::EMBEDDINGS_BLOB_FORMAT_V2);
        blob[5] = protocol::EMBEDDINGS_BLOB_FORMAT_V1;
        assert!(
            decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &current).is_none(),
            "a superseded-format snapshot must fall to rebuild"
        );

        // Now remove the guard the bump installed, and watch the hazard land:
        // the identical payload is ACCEPTED, its garbage identity comparing
        // equal to the current one. This is what shipping a compatible
        // widening instead of a version bump would have done on every vault.
        blob[5] = protocol::EMBEDDINGS_BLOB_FORMAT_V2;
        assert!(
            decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &current).is_some(),
            "the guard under test must be the version byte, not luck"
        );
    }

    #[test]
    fn a_served_embedder_persists_and_the_next_load_re_embeds_nothing() {
        // The behavioural proof, driven by the REAL Ollama engine against a
        // fake runtime — a struct-field assertion would not demonstrate it.
        // (The unlock → lock → unlock shell around this is ai-ollama-local
        // task 9's desktop E2E; what is provable without a Tauri runtime is the
        // persistence seam itself, which is where the regression lived.)
        use crate::plugins::local_inference::engine::Engine;
        use crate::plugins::local_inference::engine_ollama::tests::fake_server;
        use crate::plugins::local_inference::engine_ollama::OllamaEngine;
        use crate::plugins::local_inference::indexing::reconcile;

        let (port, _rx) =
            fake_server(r#"{"models":[{"name":"nomic-embed-text:latest","digest":"sha256:bbb"}]}"#);
        let engine = OllamaEngine::new("127.0.0.1".into(), port, "nomic-embed-text".into());
        let (name, digest) = engine
            .served_model_identity()
            .expect("a served model must yield an identity");
        let id = EmbeddingsIdentity {
            model: ModelIdentity::Served { name, digest },
            embedding_dim: 3,
            chunker_version: 1,
        };

        // Session 1: embed and persist.
        let store = sample_store();
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");

        // Session 2: same runtime, same model → the snapshot loads.
        let loaded = decode_snapshot(&KEY, &ACCOUNT_HASH, &blob, &id)
            .expect("persistence HIT: the snapshot must decode under the served identity");
        let current = vec![(nid("01"), vec![1u8; 24]), (nid("02"), vec![2u8; 24])];
        let plan = reconcile(&loaded, &current);
        assert!(
            plan.to_embed.is_empty(),
            "zero notes may be re-embedded on a persistence hit; got {:?}",
            plan.to_embed
        );
        assert!(plan.to_drop.is_empty());

        // The control arm — what this task fixes. Before the served identity
        // existed the tuple was `None`, so nothing was written and session 2
        // started from an empty store: the ENTIRE vault re-embedded, every
        // unlock, silently.
        let cold = reconcile(&AiVectorStore::new(), &current);
        assert_eq!(
            cold.to_embed.len(),
            2,
            "the control must show the whole corpus being re-embedded"
        );
    }

    #[test]
    fn decode_none_on_wrong_key_garbage_or_cross_vault() {
        let store = sample_store();
        let id = identity(0xAA, 384, 1);
        let blob = encode_snapshot(&KEY, &ACCOUNT_HASH, &store, &id).expect("encode");
        // Wrong KEK.
        let wrong = [0x43; AEAD_KEY_LEN];
        assert!(decode_snapshot(&wrong, &ACCOUNT_HASH, &blob, &id).is_none());
        // Garbage.
        assert!(decode_snapshot(&KEY, &ACCOUNT_HASH, b"not a blob", &id).is_none());
        // Cross-vault: a different account_number_hash fails the AAD bind.
        let other_hash = [0x44; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN];
        assert!(decode_snapshot(&KEY, &other_hash, &blob, &id).is_none());
    }
}
