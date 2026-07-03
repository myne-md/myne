// SPDX-License-Identifier: AGPL-3.0

//! `vault.embeddings` 34-byte-header encrypted AI-embeddings codec —
//! see `docs/spec/protocol.md` § 9.17 (MYND-453).
//!
//! `vault.embeddings` is a vault-level singleton artifact holding the
//! on-device **AI embedding index**: the semantic-search / Q&A dense vectors,
//! a `{note_id → content_nonce}` staleness manifest, and a trailing
//! model-identity tuple `{model_hash, embedding_dim, chunker_version}`. It
//! lives next to `vault.meta` at `<vault-root>/vault.embeddings` and is
//! AEAD-encrypted under
//! `ai_embeddings_key = DeriveSubkey(root_key, SubkeyRole::AiEmbeddingsKey)`.
//!
//! The structural twin of `vault.search` (§ 9.6) and `vault.indices`
//! (§ 9.8): same envelope discipline, same engine-opaque inner plaintext,
//! same fall-to-rebuild posture. Unlike `vault.prefs` (§ 9.5), the inner
//! plaintext is **opaque to this layer** — the desktop client serializes the
//! (variable, evolving) vector store and hands the codec raw bytes. The codec
//! owns only the envelope: magic, versions, nonce, AEAD seal under
//! `ai_embeddings_key`, and the `aad_ai_embeddings_blob` binding. The
//! `embeddings_format_version` byte at offset 5 carries the client's
//! inner-schema version for forward-compat.
//!
//! **Model-swap invalidation is NOT this layer's job.** The model-identity
//! tuple rides inside the opaque payload; a model / dimension / chunker change
//! makes the desktop postcard decode fail (or compare-unequal), which the
//! caller treats as fall-to-rebuild — the `vault.search` `extractor_version`
//! precedent (§ 9.17.2/§ 9.17.4). The AAD stays vault-scoped like every
//! sibling blob (it does NOT bind the model identity).
//!
//! **Distinct from `vault.search` / `vault.indices`** (`MYS1` / `MYI1`): one
//! magic and one KEK per blob family — `vault.embeddings` never shares a key
//! or an AAD with another family.
//!
//! ## On-disk layout (spec § 9.17.1)
//!
//! ```text
//! Offset  Size  Field                      Notes
//! ------  ----  -------------------------  ----------------------------------
//! 0       4     magic                      ASCII "MYR1"
//! 4       1     protocol_version           0x01
//! 5       1     embeddings_format_version  0x01 = the v0.1 inner-plaintext
//!                                           schema; bumping it lets a client
//!                                           fall to rebuild on an unknown form
//! 6       24    nonce                      XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len             big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext                 AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! ## Migration-less semantic (spec § 9.17.4)
//!
//! The caller-side `read_or_rebuild` discipline (Tauri plugin layer)
//! collapses absent-file / truncated / AEAD-fail / unsupported-format to
//! "re-embed the index from the `.myn` files". This module emits **honest
//! errors** per failure mode; the caller applies fall-to-rebuild at the
//! boundary (parity with `search_blob.rs` / `vault_indices_blob.rs`).

use crate::aead::{aad_ai_embeddings_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_blob_envelope, encode_blob_envelope, encode_blob_envelope_raw, EnvelopeError,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0 — ASCII `"MYR1"` (Myne Retrieval/embeddings v1;
/// the natural `E`-for-embeddings letter was already taken by `MYE1`).
pub const EMBEDDINGS_BLOB_MAGIC: [u8; 4] = *b"MYR1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const EMBEDDINGS_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `embeddings_format_version` byte at offset 5 — the v0.1 inner-plaintext
/// schema. Distinct from `protocol_version`: the vector-store serialization may
/// change within v0.1, and a client that does not understand a newer form falls
/// to rebuild (§ 9.17.4) rather than mis-parsing. The model-identity tuple's own
/// drift is handled inside the payload, NOT by bumping this byte.
pub const EMBEDDINGS_BLOB_FORMAT_V1: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into
/// `AAD_ai_embeddings_blob` (spec § 9.17.3 + § 9.3 offset 6).
pub const EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
pub const EMBEDDINGS_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (256 MiB).
///
/// A few thousand 384-dimensional `f32` vectors (~1.5 KiB each) plus the
/// manifest sit well within this; 256 MiB is generous headroom while still
/// bounding the parser's pre-AEAD allocation (DoS-allocation defense, parallel
/// to the § 9.6.5 search cap). See spec § 9.17.5.
pub const MAX_EMBEDDINGS_PLAINTEXT_LEN: usize = 256 * 1024 * 1024;

/// Closed-enum failure surface for `vault.embeddings` encode / decode.
/// Mirrors `VaultIndicesBlobError` / `SearchBlobError`; callers collapse all
/// variants to fall-to-rebuild per spec § 9.17.4.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum EmbeddingsBlobError {
    /// Input shorter than [`EMBEDDINGS_BLOB_HEADER_LEN`] bytes.
    #[error("vault.embeddings blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYR1`.
    #[error("vault.embeddings blob magic mismatch (expected MYR1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.embeddings blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `embeddings_format_version` is not understood by this client → the
    /// caller falls to rebuild (re-embed) from the `.myn` files.
    #[error("vault.embeddings blob embeddings_format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_EMBEDDINGS_PLAINTEXT_LEN`] + 32.
    #[error("vault.embeddings ciphertext_len exceeds 256 MiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `EMBEDDINGS_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.embeddings blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX commitment tag (§ 6.4
    /// non-distinguishing rule).
    #[error("vault.embeddings AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_EMBEDDINGS_PLAINTEXT_LEN`].
    #[error("vault.embeddings plaintext exceeds 256 MiB cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.embeddings nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for EmbeddingsBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy §6.4, mirroring prefs/search/indices).
        EmbeddingsBlobError::CannotDecrypt
    }
}

impl From<EnvelopeError> for EmbeddingsBlobError {
    /// Map the shared-envelope error into this codec's public variant so the
    /// distinguishable-reject surface (and its vectors) stay unchanged.
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::HeaderTooShort => EmbeddingsBlobError::HeaderTooShort,
            EnvelopeError::MagicMismatch => EmbeddingsBlobError::MagicMismatch,
            EnvelopeError::ProtocolVersionMismatch => EmbeddingsBlobError::ProtocolVersionMismatch,
            EnvelopeError::FormatUnsupported => EmbeddingsBlobError::FormatUnsupported,
            EnvelopeError::CiphertextLenOverflow => EmbeddingsBlobError::CiphertextLenOverflow,
            EnvelopeError::CiphertextTruncated => EmbeddingsBlobError::CiphertextTruncated,
            EnvelopeError::CannotDecrypt => EmbeddingsBlobError::CannotDecrypt,
            EnvelopeError::PlaintextTooLarge => EmbeddingsBlobError::PlaintextTooLarge,
            EnvelopeError::RandomnessUnavailable => EmbeddingsBlobError::RandomnessUnavailable,
        }
    }
}

/// Encode a `vault.embeddings` blob from an opaque `plaintext` (the desktop
/// layer's serialized embedding store + manifest + model-identity tuple),
/// sealing under `ai_embeddings_key` with `nonce`.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse
/// under the same `ai_embeddings_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_embeddings_blob`].
pub fn encode_embeddings_blob_raw(
    ai_embeddings_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, EmbeddingsBlobError> {
    let aad = aad_ai_embeddings_blob(account_number_hash);
    encode_blob_envelope_raw(
        ai_embeddings_key,
        &EMBEDDINGS_BLOB_MAGIC,
        EMBEDDINGS_BLOB_FORMAT_V1,
        &aad,
        MAX_EMBEDDINGS_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(EmbeddingsBlobError::from)
}

/// Encode a `vault.embeddings` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_embeddings_blob_raw`].
pub fn encode_embeddings_blob(
    ai_embeddings_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, EmbeddingsBlobError> {
    let aad = aad_ai_embeddings_blob(account_number_hash);
    encode_blob_envelope(
        ai_embeddings_key,
        &EMBEDDINGS_BLOB_MAGIC,
        EMBEDDINGS_BLOB_FORMAT_V1,
        &aad,
        MAX_EMBEDDINGS_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(EmbeddingsBlobError::from)
}

/// Decode a `vault.embeddings` blob into its opaque inner plaintext (the
/// serialized embedding store + manifest + model-identity tuple, for the
/// desktop layer to deserialize). Magic / protocol_version /
/// embeddings_format_version are all checked BEFORE any decryption; AEAD
/// failure collapses to [`EmbeddingsBlobError::CannotDecrypt`].
pub fn decode_embeddings_blob(
    ai_embeddings_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, EmbeddingsBlobError> {
    let aad = aad_ai_embeddings_blob(account_number_hash);
    decode_blob_envelope(
        ai_embeddings_key,
        &EMBEDDINGS_BLOB_MAGIC,
        EMBEDDINGS_BLOB_FORMAT_V1,
        &aad,
        MAX_EMBEDDINGS_PLAINTEXT_LEN,
        blob,
    )
    .map_err(EmbeddingsBlobError::from)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use crate::test_vector_fmt::{hex_lower, json_escape};

    fn fixed_key() -> [u8; AEAD_KEY_LEN] {
        *derive_subkey(&[0x42; 32], SubkeyRole::AiEmbeddingsKey)
    }
    fn account_hash() -> [u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN]
    }
    fn nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }

    #[test]
    fn round_trip_opaque_plaintext() {
        let key = fixed_key();
        let h = account_hash();
        // A representative opaque payload: a couple of vectors + a manifest +
        // a trailing model-identity tuple (the codec is byte-transparent).
        let pt = b"\x00\x01\x02embeddings-store-opaque-bytes\xff\xfe";
        let blob = encode_embeddings_blob_raw(&key, &h, pt, &nonce()).unwrap();
        assert_eq!(&blob[0..4], b"MYR1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], 0x01);
        let out = decode_embeddings_blob(&key, &h, &blob).unwrap();
        assert_eq!(out.as_slice(), pt.as_slice());
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let key = fixed_key();
        let h = account_hash();
        let blob = encode_embeddings_blob_raw(&key, &h, b"", &nonce()).unwrap();
        let out = decode_embeddings_blob(&key, &h, &blob).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn magic_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_embeddings_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[0] = b'Z';
        assert_eq!(
            decode_embeddings_blob(&key, &h, &blob),
            Err(EmbeddingsBlobError::MagicMismatch),
        );
    }

    #[test]
    fn magic_distinct_from_search_and_indices() {
        // LOAD-BEARING: MYR1 (vault.embeddings) must never collide with MYS1
        // (vault.search) or MYI1 (vault.indices) — separate blob families.
        assert_eq!(EMBEDDINGS_BLOB_MAGIC, *b"MYR1");
        assert_ne!(EMBEDDINGS_BLOB_MAGIC, *b"MYS1");
        assert_ne!(EMBEDDINGS_BLOB_MAGIC, *b"MYI1");
        assert_ne!(EMBEDDINGS_BLOB_MAGIC, *b"MYE1");
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_embeddings_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[4] = 0x02;
        assert_eq!(
            decode_embeddings_blob(&key, &h, &blob),
            Err(EmbeddingsBlobError::ProtocolVersionMismatch),
        );
    }

    #[test]
    fn unsupported_format_rejects_for_rebuild() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_embeddings_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[5] = 0x02;
        assert_eq!(
            decode_embeddings_blob(&key, &h, &blob),
            Err(EmbeddingsBlobError::FormatUnsupported),
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_embeddings_blob_raw(&key, &h, b"hello", &nonce()).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert_eq!(
            decode_embeddings_blob(&key, &h, &blob),
            Err(EmbeddingsBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let key = fixed_key();
        let blob = encode_embeddings_blob_raw(&key, &account_hash(), b"hello", &nonce()).unwrap();
        // Different account_number_hash → different AAD → AEAD verify fails.
        let other = [0x44; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_embeddings_blob(&key, &other, &blob),
            Err(EmbeddingsBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn indices_key_cannot_open_embeddings_blob() {
        // One-KEK-per-family in byte form: a blob sealed under ai-embeddings-key
        // must NOT open under vault-indices-key (and vice versa).
        let emb_key = fixed_key();
        let h = account_hash();
        let blob = encode_embeddings_blob_raw(&emb_key, &h, b"hello", &nonce()).unwrap();
        let indices_key = *derive_subkey(&[0x42; 32], SubkeyRole::VaultIndicesKey);
        assert_eq!(
            decode_embeddings_blob(&indices_key, &h, &blob),
            Err(EmbeddingsBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn header_too_short_rejects() {
        let key = fixed_key();
        assert_eq!(
            decode_embeddings_blob(&key, &account_hash(), b"MYR1"),
            Err(EmbeddingsBlobError::HeaderTooShort),
        );
    }

    #[test]
    fn oversize_ciphertext_len_rejects_before_indexing() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_embeddings_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        // Force ciphertext_len to a hostile huge value.
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_embeddings_blob(&key, &h, &blob),
            Err(EmbeddingsBlobError::CiphertextLenOverflow),
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/embeddings/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_embeddings_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_embeddings_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (MYND-453 / §9.17), mirroring the `vault-indices` shape:
    /// - 3 `encrypt` × {empty / small opaque descriptor / 1-KB opaque
    ///   plaintext} — pin the `MYR1` byte output. `ai_embeddings_key` is
    ///   derived from `root_key` via `SubkeyRole::AiEmbeddingsKey` so the
    ///   vector exercises the full root_key → KEK → blob lineage. The inner
    ///   plaintext is engine-opaque (the desktop layer's serialized vector
    ///   store + `{note_id → content_nonce}` manifest + model-identity tuple);
    ///   only the envelope + AAD framing is pinned here, NOT the inner postcard
    ///   snapshot.
    /// - 1 `decrypt_ok` (small-descriptor round-trip).
    /// - 2 `decrypt_aead_fail` — (a) single-byte CTX-tag tamper, (b)
    ///   cross-vault (wrong `account_number_hash` via the AAD binding). Both
    ///   collapse to `EmbeddingsBlobError::CannotDecrypt` non-distinguishing
    ///   per spec §6.4 — the real-key fixtures make a skipped check observable.
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `FormatUnsupported`,
    ///   `HeaderTooShort`, `CiphertextTruncated`, `CiphertextLenOverflow`).
    ///   `FormatUnsupported` is the load-bearing forward hook (§9.17.4).
    ///
    /// `PlaintextTooLarge` + `RandomnessUnavailable` are encode-side and
    /// cannot be expressed as a decode-a-blob case, so they are not vectored
    /// (documented in the category's `schema.md`).
    #[test]
    #[ignore]
    fn emit_embeddings_vectors_for_paste() {
        extern crate std;

        // Distinct byte patterns per field — easy visual cross-check. root_key
        // (NOT the KEK): the runner derives ai_embeddings_key from this via
        // derive_subkey(SubkeyRole::AiEmbeddingsKey), exactly as a production
        // caller would. account_hash binds via the AAD. Patterns match the
        // vault-indices lineage exactly (0x42 root / 0x33 hash / 0x77 nonce)
        // so the two families share an identical fixed-vector provenance.
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN] =
            [0x44; EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let ai_embeddings_key = derive_subkey(&root_key, SubkeyRole::AiEmbeddingsKey);

        // Deterministic opaque plaintexts (the codec is payload-agnostic — the
        // inner postcard snapshot is the desktop engine's concern, NOT pinned
        // here). The small case is a byte-transparent stand-in for a tiny
        // vector-store snapshot; the codec never inspects it.
        let plaintext_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let plaintext_small: alloc::vec::Vec<u8> =
            (*b"\x00\x01\x02embeddings-store-opaque-bytes\xff\xfe").to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_empty =
            encode_embeddings_blob_raw(&ai_embeddings_key, &account_hash, &plaintext_empty, &nonce)
                .expect("encode empty");
        let blob_small =
            encode_embeddings_blob_raw(&ai_embeddings_key, &account_hash, &plaintext_small, &nonce)
                .expect("encode small");
        let blob_1kb =
            encode_embeddings_blob_raw(&ai_embeddings_key, &account_hash, &plaintext_1kb, &nonce)
                .expect("encode 1kb");

        // Round-trip sanity on the small blob.
        let decoded = decode_embeddings_blob(&ai_embeddings_key, &account_hash, &blob_small)
            .expect("decode small round-trip");
        assert_eq!(decoded.as_slice(), plaintext_small.as_slice());

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_embeddings_blob(&ai_embeddings_key, &account_hash, &blob_tag_tamper),
            Err(EmbeddingsBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): valid blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_embeddings_blob(&ai_embeddings_key, &other_account_hash, &blob_small),
            Err(EmbeddingsBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_format = blob_small.clone();
        pf_format[5] = 0x02;
        let pf_header_short: alloc::vec::Vec<u8> = EMBEDDINGS_BLOB_MAGIC.to_vec(); // 4 < 34
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        let root_key_hex = hex_lower(&root_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let nonce_hex = hex_lower(&nonce);
        let ai_embeddings_key_hex = hex_lower(&*ai_embeddings_key);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"embeddings\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.17 + §3.4 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_embeddings_blob_raw + protocol::decode_embeddings_blob byte mapping for the MYR1 vault.embeddings encrypted on-device AI-embedding-index codec (MYND-453). The inner plaintext is OPAQUE (client-serialized embedding store: semantic-search / Q&A dense vectors + {note_id -> content_nonce} manifest + model-identity tuple) — no canonical-JSON discipline, unlike vault-prefs; the structural twin of vault.search / vault.indices. The inner postcard snapshot is engine-opaque and is NOT pinned here — only the envelope + AAD framing. ai_embeddings_key = derive_subkey(root_key, SubkeyRole::AiEmbeddingsKey) (role 'ai-embeddings-key'); account_number_hash binds via aad_ai_embeddings_blob (role 'ai-embeddings-blob' — a DISTINCT load-bearing string, and DISTINCT from search-index-key/-blob and vault-indices-key/-blob: one magic + one KEK per blob family, MYR1 != MYS1 != MYI1). Model-swap invalidation rides inside the opaque payload (the §9.17.2 model-identity tuple), NOT the AAD. 12 cases: 3 encrypt (empty / small descriptor / 1-KB) + 1 decrypt_ok + 2 decrypt_aead_fail (tag-tamper + cross-vault, both non-distinguishing per §6.4, real-key fixtures) + 6 parse_fail (one per distinguishable pre-decryption structural reject incl. the load-bearing format_unsupported forward hook). Cases generated by `cargo test -p protocol --lib emit_embeddings_vectors_for_paste -- --ignored` (in protocol/src/embeddings_blob.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // ---- encrypt closure ----------------------------------------
        let emit_encrypt = |dump: &mut alloc::string::String,
                            slug: &str,
                            description: &str,
                            plaintext: &[u8],
                            blob: &[u8],
                            include_info: bool,
                            trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"embeddings/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"encrypt\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                root_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                account_hash_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_plaintext_hex\": \"{}\",\n",
                hex_lower(plaintext)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_nonce_hex\": \"{}\",\n",
                nonce_hex
            ));
            if include_info {
                dump.push_str(&alloc::format!(
                    "      \"informational_ai_embeddings_key_hex\": \"{}\",\n",
                    ai_embeddings_key_hex
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_embeddings_blob_hex\": \"{}\"\n",
                hex_lower(blob)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        emit_encrypt(
            &mut dump,
            "encrypt-empty",
            "Encode an empty inner plaintext (no embedding index persisted — the caller-side fall-to-rebuild / re-embed default). The smallest valid MYR1 blob: 34-byte header + 0-byte ciphertext + 32-byte CTX tag = 66 bytes. ciphertext_len field = 32.",
            &plaintext_empty,
            &blob_empty,
            true,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-small-descriptor",
            "Encode a 36-byte opaque descriptor standing in for a tiny vector-store snapshot (a couple of vectors + manifest + model-identity tuple). The codec is byte-transparent — the inner serialization is the desktop engine's, not the codec's, and is NOT pinned here. Expected blob = 34 + 36 + 32 = 102 bytes.",
            &plaintext_small,
            &blob_small,
            false,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-1kb",
            "Encode a 1024-byte plaintext where byte i = (i mod 256). Mid-size case — exercises a full XChaCha20 keystream block plus tail. Expected blob = 34 + 1024 + 32 = 1090 bytes.",
            &plaintext_1kb,
            &blob_1kb,
            false,
            true,
        );

        // ---- decrypt_ok ---------------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"embeddings/v0.1/decrypt-ok-small-descriptor\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the small-descriptor blob back to its opaque plaintext under the matching root_key (-> ai_embeddings_key) + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact inner bytes the desktop layer will deserialize.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_small)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            root_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            account_hash_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(&plaintext_small)
        ));
        dump.push_str("    },\n");

        // ---- decrypt_aead_fail closure ------------------------------
        let emit_aead_fail = |dump: &mut alloc::string::String,
                              slug: &str,
                              description: &str,
                              blob: &[u8],
                              account_hash_arg_hex: &str,
                              tamper_desc: &str,
                              trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"embeddings/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                root_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                account_hash_arg_hex
            ));
            dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(tamper_desc)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        emit_aead_fail(
            &mut dump,
            "decrypt-tampered-ctx-tag",
            "Take the small-descriptor blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt — the recomputed CTX commitment no longer matches. Same observable outcome as the cross-vault case below (spec §6.4).",
            &blob_tag_tamper,
            &account_hash_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );

        emit_aead_fail(
            &mut dump,
            "decrypt-cross-vault-account-hash",
            "Take the intact small-descriptor blob but decrypt under a DIFFERENT account_number_hash (0x44x16 instead of 0x33x16). aad_ai_embeddings_blob binds the account hash, so the AAD differs and AEAD verification fails — a blob from vault A cannot be opened against vault B. Collapses to the same CannotDecrypt as the tamper case; ports MUST NOT distinguish the two.",
            &blob_small,
            &other_account_hash_hex,
            "intact blob decrypted under wrong account_number_hash (0x44x16)",
            true,
        );

        // ---- parse_fail closure -------------------------------------
        let emit_parse_fail = |dump: &mut alloc::string::String,
                               slug: &str,
                               description: &str,
                               blob: &[u8],
                               expected_error: &str,
                               trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"embeddings/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\"\n",
                expected_error
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        emit_parse_fail(
            &mut dump,
            "parse-fail-magic-mismatch",
            "First byte of the MYR1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.17.1).",
            &pf_magic,
            "magic_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-protocol-version-mismatch",
            "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting.",
            &pf_version,
            "protocol_version_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-format-unsupported",
            "embeddings_format_version byte (offset 5) set to 0x02 — a future embedding-store serialization a v0.1 client does not understand. The decoder rejects cleanly so the caller falls to rebuild (re-embed) from the .myn files (§9.17.4). This is the forward-migration hook and is load-bearing. NOTE: model-identity drift (a model / dimension / chunker change) is handled INSIDE the opaque payload, not by bumping this byte.",
            &pf_format,
            "format_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYR1 magic, no room for the 34-byte header. Rejected before any field read.",
            &pf_header_short,
            "header_too_short",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-truncated",
            "Valid header advertising ciphertext_len = N, but the blob is one byte shorter than header + N. Rejected before the AEAD stage.",
            &pf_truncated,
            "ciphertext_truncated",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-len-overflow",
            "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_EMBEDDINGS_PLAINTEXT_LEN + 32 (256 MiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing.",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_embeddings_vectors.json", dump.as_bytes())
            .expect("write embeddings vectors dump");
    }
}
