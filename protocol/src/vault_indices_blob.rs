// SPDX-License-Identifier: AGPL-3.0

//! `vault.indices` 34-byte-header encrypted structured-metadata codec —
//! see `agent-tooling/docs/spec/protocol.md` § 9.8 (MYND-271; design MYND-31).
//!
//! `vault.indices` is a vault-level singleton artifact holding the
//! **structured-metadata index**: the wikilink forward/reverse (backlink)
//! graph, the nested `#tag` index, the title→note resolution surface, and
//! the typed **property** records (every note's arbitrary frontmatter keys,
//! each coerced to one Myne type per `markdown-dialect.md` § 3.6.4). It lives
//! next to `vault.meta` at `<vault-root>/vault.indices` and is AEAD-encrypted
//! under `vault_indices_key = DeriveSubkey(root_key, SubkeyRole::VaultIndicesKey)`.
//!
//! The structural twin of `vault.search` (§ 9.6) and `vault.workspace`
//! (§ 9.7): same envelope discipline, same engine-opaque inner plaintext,
//! same fall-to-rebuild posture. Unlike `vault.prefs` (§ 9.5), the inner
//! plaintext is **opaque to this layer** — the desktop client serializes the
//! (variable, evolving) index and hands the codec raw bytes. The codec owns
//! only the envelope: magic, versions, nonce, AEAD seal under
//! `vault_indices_key`, and the `aad_vault_indices_blob` binding. The
//! `index_format_version` byte at offset 5 carries the client's inner-schema
//! version for forward-compat.
//!
//! **Distinct from `vault.search`** (`MYS1` / `search-index-key`): one magic
//! and one KEK per blob family — `vault.indices` (structured metadata) and
//! `vault.search` (BM25 full-text) never share a key or an AAD.
//!
//! ## On-disk layout (spec § 9.8.1)
//!
//! ```text
//! Offset  Size  Field                  Notes
//! ------  ----  ---------------------  ----------------------------------
//! 0       4     magic                  ASCII "MYI1"
//! 4       1     protocol_version       0x01
//! 5       1     index_format_version   0x02 = the current inner-plaintext
//!                                       schema (0x01 = pre-MYND-612, now
//!                                       rejected); bumping it lets a client
//!                                       fall to rebuild on an unknown form
//! 6       24    nonce                  XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len         big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext             AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! ## Migration-less semantic (spec § 9.8.4)
//!
//! The caller-side `read_or_rebuild` discipline (Tauri plugin layer)
//! collapses absent-file / truncated / AEAD-fail / unsupported-format to
//! "rebuild the index from the `.myn` files". This module emits **honest
//! errors** per failure mode; the caller applies fall-to-rebuild at the
//! boundary (parity with `search_blob.rs` / `workspace_blob.rs`).

use crate::aead::{aad_vault_indices_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_blob_envelope, encode_blob_envelope, encode_blob_envelope_raw, EnvelopeError,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0 — ASCII `"MYI1"` (Myne Indices v1).
pub const VAULT_INDICES_BLOB_MAGIC: [u8; 4] = *b"MYI1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const VAULT_INDICES_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `index_format_version` byte at offset 5 — the originally-shipped v0.1
/// inner-plaintext schema. **No longer written and no longer accepted**
/// (MYND-612 moved to [`VAULT_INDICES_BLOB_FORMAT_V2`]); retained so the
/// rejection path can be exercised against a real pre-612 byte rather than an
/// invented one.
pub const VAULT_INDICES_BLOB_FORMAT_V1: u8 = 0x01;

/// `index_format_version` byte at offset 5 — the current inner-plaintext
/// schema. Distinct from `protocol_version`: the structured-index schema may
/// grow fields within v0.1 (a new property type, a new edge field, a
/// different serialization), and a client that does not understand a newer
/// form falls to rebuild (§ 9.8.4) rather than mis-parsing.
///
/// Bumped to `0x02` by MYND-612, which added per-note line-task records to the
/// payload. The bump is **deliberate rather than incidental**: the nearest
/// precedent leaned on postcard being non-self-describing, so a payload with a
/// new trailing field simply failed to decode against the old struct. That is
/// an implementation property of the serializer, not a guarantee of the format
/// — if it ever stopped holding, an old blob would parse *successfully and
/// wrongly*, which is a silently incorrect index. A version byte checked
/// before decryption cannot fail that way.
pub const VAULT_INDICES_BLOB_FORMAT_V2: u8 = 0x02;

/// The `index_format_version` this build writes and accepts.
pub const VAULT_INDICES_BLOB_FORMAT_CURRENT: u8 = VAULT_INDICES_BLOB_FORMAT_V2;

/// Length of the 16-byte `account_number_hash` bound into
/// `AAD_vault_indices_blob` (spec § 9.8.3 + § 9.3 offset 6).
pub const VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
pub const VAULT_INDICES_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (256 MiB).
///
/// The structured index (wikilink edges + tag index + title map + typed
/// property records) is well within this even at 10k notes; 256 MiB is
/// generous headroom while still bounding the parser's pre-AEAD allocation
/// (DoS-allocation defense, parallel to the §9.6.5 search cap). See spec
/// § 9.8.5.
pub const MAX_VAULT_INDICES_PLAINTEXT_LEN: usize = 256 * 1024 * 1024;

/// Closed-enum failure surface for `vault.indices` encode / decode.
/// Mirrors `WorkspaceBlobError` / `SearchBlobError`; callers collapse all
/// variants to fall-to-rebuild per spec § 9.8.4.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum VaultIndicesBlobError {
    /// Input shorter than [`VAULT_INDICES_BLOB_HEADER_LEN`] bytes.
    #[error("vault.indices blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYI1`.
    #[error("vault.indices blob magic mismatch (expected MYI1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.indices blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `index_format_version` is not understood by this client → the caller
    /// falls to rebuild from the `.myn` files.
    #[error("vault.indices blob index_format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_VAULT_INDICES_PLAINTEXT_LEN`] + 32.
    #[error("vault.indices ciphertext_len exceeds 256 MiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `VAULT_INDICES_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.indices blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX commitment tag (§ 6.4
    /// non-distinguishing rule).
    #[error("vault.indices AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_VAULT_INDICES_PLAINTEXT_LEN`].
    #[error("vault.indices plaintext exceeds 256 MiB cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.indices nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for VaultIndicesBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy §6.4, mirroring prefs/search/workspace).
        VaultIndicesBlobError::CannotDecrypt
    }
}

crate::blob_envelope::impl_from_envelope_error!(VaultIndicesBlobError);

/// Encode a `vault.indices` blob from an opaque `plaintext` (the desktop
/// layer's serialized structured-metadata index), sealing under
/// `vault_indices_key` with `nonce`.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse
/// under the same `vault_indices_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_vault_indices_blob`].
pub fn encode_vault_indices_blob_raw(
    vault_indices_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, VaultIndicesBlobError> {
    let aad = aad_vault_indices_blob(account_number_hash);
    encode_blob_envelope_raw(
        vault_indices_key,
        &VAULT_INDICES_BLOB_MAGIC,
        VAULT_INDICES_BLOB_FORMAT_CURRENT,
        &aad,
        MAX_VAULT_INDICES_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(VaultIndicesBlobError::from)
}

/// Encode a `vault.indices` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_vault_indices_blob_raw`].
pub fn encode_vault_indices_blob(
    vault_indices_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultIndicesBlobError> {
    let aad = aad_vault_indices_blob(account_number_hash);
    encode_blob_envelope(
        vault_indices_key,
        &VAULT_INDICES_BLOB_MAGIC,
        VAULT_INDICES_BLOB_FORMAT_CURRENT,
        &aad,
        MAX_VAULT_INDICES_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(VaultIndicesBlobError::from)
}

/// Decode a `vault.indices` blob into its opaque inner plaintext (the
/// serialized structured-metadata index, for the desktop layer to
/// deserialize). Magic / protocol_version / index_format_version are all
/// checked BEFORE any decryption; AEAD failure collapses to
/// [`VaultIndicesBlobError::CannotDecrypt`].
pub fn decode_vault_indices_blob(
    vault_indices_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultIndicesBlobError> {
    let aad = aad_vault_indices_blob(account_number_hash);
    decode_blob_envelope(
        vault_indices_key,
        &VAULT_INDICES_BLOB_MAGIC,
        VAULT_INDICES_BLOB_FORMAT_CURRENT,
        &aad,
        MAX_VAULT_INDICES_PLAINTEXT_LEN,
        blob,
    )
    .map_err(VaultIndicesBlobError::from)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use crate::test_vector_fmt::{hex_lower, json_escape};

    fn fixed_key() -> [u8; AEAD_KEY_LEN] {
        *derive_subkey(&[0x42; 32], SubkeyRole::VaultIndicesKey)
    }
    fn account_hash() -> [u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN]
    }
    fn nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }

    #[test]
    fn round_trip_opaque_plaintext() {
        let key = fixed_key();
        let h = account_hash();
        let pt = br#"{"props":{"n1":[{"k":"status","t":"string","v":"in-progress"}]}}"#;
        let blob = encode_vault_indices_blob_raw(&key, &h, pt, &nonce()).unwrap();
        assert_eq!(&blob[0..4], b"MYI1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], 0x02, "index_format_version is written as 0x02");
        let out = decode_vault_indices_blob(&key, &h, &blob).unwrap();
        assert_eq!(out.as_slice(), pt.as_slice());
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let key = fixed_key();
        let h = account_hash();
        let blob = encode_vault_indices_blob_raw(&key, &h, b"", &nonce()).unwrap();
        let out = decode_vault_indices_blob(&key, &h, &blob).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn magic_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_vault_indices_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[0] = b'Z';
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::MagicMismatch),
        );
    }

    #[test]
    fn magic_distinct_from_search_blob() {
        // LOAD-BEARING: MYI1 (vault.indices) must never collide with MYS1
        // (vault.search) — separate blob families, one magic each.
        assert_ne!(VAULT_INDICES_BLOB_MAGIC, *b"MYS1");
        assert_eq!(VAULT_INDICES_BLOB_MAGIC, *b"MYI1");
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_vault_indices_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[4] = 0x02;
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::ProtocolVersionMismatch),
        );
    }

    #[test]
    fn unsupported_format_rejects_for_rebuild() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_vault_indices_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[5] = 0x03; // a future schema this build does not understand
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::FormatUnsupported),
        );
    }

    #[test]
    fn a_pre_612_v1_blob_is_rejected_before_any_decryption_is_attempted() {
        // MYND-612. The pre-bump blob must be refused on its version byte, not
        // by luck of the serializer: postcard being non-self-describing is an
        // implementation property, and if it stopped holding, an old payload
        // would decode successfully against the new struct and produce a
        // silently incorrect index. So this asserts the refusal happens with a
        // key that WOULD decrypt the body — only the version byte differs.
        let key = fixed_key();
        let h = account_hash();
        let mut blob =
            encode_vault_indices_blob_raw(&key, &h, b"pre-612 payload", &nonce()).expect("encode");
        blob[5] = VAULT_INDICES_BLOB_FORMAT_V1;

        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::FormatUnsupported),
            "a 0x01 blob is rejected, and on the format byte rather than on AEAD"
        );
    }

    #[test]
    fn a_current_v2_blob_loads() {
        let key = fixed_key();
        let h = account_hash();
        let pt = b"post-612 payload carrying task records";
        let blob = encode_vault_indices_blob_raw(&key, &h, pt, &nonce()).expect("encode");
        assert_eq!(blob[5], VAULT_INDICES_BLOB_FORMAT_CURRENT);
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob)
                .expect("decodes")
                .as_slice(),
            pt.as_slice()
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_vault_indices_blob_raw(&key, &h, b"hello", &nonce()).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let key = fixed_key();
        let blob =
            encode_vault_indices_blob_raw(&key, &account_hash(), b"hello", &nonce()).unwrap();
        // Different account_number_hash → different AAD → AEAD verify fails.
        let other = [0x44; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_vault_indices_blob(&key, &other, &blob),
            Err(VaultIndicesBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn search_key_cannot_open_indices_blob() {
        // One-KEK-per-family in byte form: a blob sealed under vault-indices-key
        // must NOT open under search-index-key (and vice versa).
        let indices_key = fixed_key();
        let h = account_hash();
        let blob = encode_vault_indices_blob_raw(&indices_key, &h, b"hello", &nonce()).unwrap();
        let search_key = *derive_subkey(&[0x42; 32], SubkeyRole::SearchIndexKey);
        assert_eq!(
            decode_vault_indices_blob(&search_key, &h, &blob),
            Err(VaultIndicesBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn header_too_short_rejects() {
        let key = fixed_key();
        assert_eq!(
            decode_vault_indices_blob(&key, &account_hash(), b"MYI1"),
            Err(VaultIndicesBlobError::HeaderTooShort),
        );
    }

    #[test]
    fn oversize_ciphertext_len_rejects_before_indexing() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_vault_indices_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        // Force ciphertext_len to a hostile huge value.
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_vault_indices_blob(&key, &h, &blob),
            Err(VaultIndicesBlobError::CiphertextLenOverflow),
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/vault-indices/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_vault_indices_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_vault_indices_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (MYND-271 / §9.8), mirroring the `vault-workspace` shape:
    /// - 3 `encrypt` × {empty / small property-record descriptor / 1-KB
    ///   opaque plaintext} — pin the `MYI1` byte output. `vault_indices_key`
    ///   is derived from `root_key` via `SubkeyRole::VaultIndicesKey` so the
    ///   vector exercises the full root_key → KEK → blob lineage.
    /// - 1 `decrypt_ok` (small-descriptor round-trip).
    /// - 2 `decrypt_aead_fail` — (a) single-byte CTX-tag tamper, (b)
    ///   cross-vault (wrong `account_number_hash` via the AAD binding). Both
    ///   collapse to `VaultIndicesBlobError::CannotDecrypt` non-distinguishing
    ///   per spec §6.4 — the real-key fixtures make a skipped check observable.
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `FormatUnsupported`,
    ///   `HeaderTooShort`, `CiphertextTruncated`, `CiphertextLenOverflow`).
    ///   `FormatUnsupported` is the load-bearing forward hook (§9.8.4).
    ///
    /// `PlaintextTooLarge` + `RandomnessUnavailable` are encode-side and
    /// cannot be expressed as a decode-a-blob case, so they are not vectored
    /// (documented in the category's `schema.md`).
    #[test]
    #[ignore]
    fn emit_vault_indices_vectors_for_paste() {
        extern crate std;

        // Distinct byte patterns per field — easy visual cross-check. root_key
        // (NOT the KEK): the runner derives vault_indices_key from this via
        // derive_subkey(SubkeyRole::VaultIndicesKey), exactly as a production
        // caller would. account_hash binds via the AAD. Patterns match this
        // test mod's fixtures (0x42 root / 0x33 hash / 0x77 nonce).
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN] =
            [0x44; VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);

        // Deterministic opaque plaintexts (the codec is payload-agnostic). The
        // small case is a realistic typed-property-record descriptor — the
        // same fixture the round_trip_opaque_plaintext unit test pins.
        let plaintext_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let plaintext_small: alloc::vec::Vec<u8> =
            (*br#"{"props":{"n1":[{"k":"status","t":"string","v":"in-progress"}]}}"#).to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_empty = encode_vault_indices_blob_raw(
            &vault_indices_key,
            &account_hash,
            &plaintext_empty,
            &nonce,
        )
        .expect("encode empty");
        let blob_small = encode_vault_indices_blob_raw(
            &vault_indices_key,
            &account_hash,
            &plaintext_small,
            &nonce,
        )
        .expect("encode small");
        let blob_1kb = encode_vault_indices_blob_raw(
            &vault_indices_key,
            &account_hash,
            &plaintext_1kb,
            &nonce,
        )
        .expect("encode 1kb");

        // Round-trip sanity on the small blob.
        let decoded = decode_vault_indices_blob(&vault_indices_key, &account_hash, &blob_small)
            .expect("decode small round-trip");
        assert_eq!(decoded.as_slice(), plaintext_small.as_slice());

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_vault_indices_blob(&vault_indices_key, &account_hash, &blob_tag_tamper),
            Err(VaultIndicesBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): valid blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_vault_indices_blob(&vault_indices_key, &other_account_hash, &blob_small),
            Err(VaultIndicesBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_index_format = blob_small.clone();
        // MYND-612 bumped the current index format to 0x02, so the
        // forward-hook case moves to 0x03. The hook is RELOCATED, not burned:
        // it still pins "a client rejects a version it does not know", which is
        // the only thing it ever existed to prove.
        pf_index_format[5] = 0x03;
        let pf_header_short: alloc::vec::Vec<u8> = VAULT_INDICES_BLOB_MAGIC.to_vec(); // 4 < 34
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        let root_key_hex = hex_lower(&root_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let nonce_hex = hex_lower(&nonce);
        let vault_indices_key_hex = hex_lower(&*vault_indices_key);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-indices\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.8 + §3.4 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_vault_indices_blob_raw + protocol::decode_vault_indices_blob byte mapping for the MYI1 vault.indices encrypted structured-metadata codec (MYND-271; design MYND-31). The header's index_format_version is 0x02 as of MYND-612, which added per-note line-task records to the inner plaintext; 0x01 blobs are rejected rather than migrated, since the index is a rebuildable cache. The inner plaintext is OPAQUE (client-serialized structured index: wikilink graph + tag index + title map + typed property records + per-note imported block-anchor records (MYND-382) + per-note line-task records (MYND-612) + per-note heading records (myne#216)) — no canonical-JSON discipline, unlike vault-prefs; the structural twin of vault.search/vault.workspace. vault_indices_key = derive_subkey(root_key, SubkeyRole::VaultIndicesKey) (role 'vault-indices-key'); account_number_hash binds via aad_vault_indices_blob (role 'vault-indices-blob' — a DISTINCT load-bearing string, and DISTINCT from search-index-key/-blob: one magic + one KEK per blob family, MYI1 != MYS1). 12 cases: 3 encrypt (empty / small descriptor / 1-KB) + 1 decrypt_ok + 2 decrypt_aead_fail (tag-tamper + cross-vault, both non-distinguishing per §6.4, real-key fixtures) + 6 parse_fail (one per distinguishable pre-decryption structural reject incl. the load-bearing format_unsupported forward hook). Cases generated by `cargo test -p protocol --lib emit_vault_indices_vectors_for_paste -- --ignored` (in protocol/src/vault_indices_blob.rs).\",\n");
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
                "      \"vector_id\": \"vault-indices/v0.1/{}\",\n",
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
                    "      \"informational_vault_indices_key_hex\": \"{}\",\n",
                    vault_indices_key_hex
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_vault_indices_blob_hex\": \"{}\"\n",
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
            "Encode an empty inner plaintext (no index persisted — the caller-side fall-to-rebuild default). The smallest valid MYI1 blob: 34-byte header + 0-byte ciphertext + 32-byte CTX tag = 66 bytes. ciphertext_len field = 32.",
            &plaintext_empty,
            &blob_empty,
            true,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-small-descriptor",
            "Encode a 64-byte typed-property-record descriptor (one note, one typed property). The codec is byte-transparent — the JSON shape is the desktop client's, not the codec's. Expected blob = 34 + 64 + 32 = 130 bytes.",
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
        dump.push_str("      \"vector_id\": \"vault-indices/v0.1/decrypt-ok-small-descriptor\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the small-descriptor blob back to its opaque plaintext under the matching root_key (→ vault_indices_key) + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact inner bytes the desktop layer will deserialize.")
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
                "      \"vector_id\": \"vault-indices/v0.1/{}\",\n",
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
            "Take the intact small-descriptor blob but decrypt under a DIFFERENT account_number_hash (0x44×16 instead of 0x33×16). aad_vault_indices_blob binds the account hash, so the AAD differs and AEAD verification fails — a blob from vault A cannot be opened against vault B. Collapses to the same CannotDecrypt as the tamper case; ports MUST NOT distinguish the two.",
            &blob_small,
            &other_account_hash_hex,
            "intact blob decrypted under wrong account_number_hash (0x44×16)",
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
                "      \"vector_id\": \"vault-indices/v0.1/{}\",\n",
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
            "First byte of the MYI1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.8.1).",
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
            "index_format_version byte (offset 5) set to 0x03 — a future structured-index serialization a v0.1 client does not understand. The decoder rejects cleanly so the caller falls to rebuild from the .myn files (§9.8.4). This is the forward-migration hook and is load-bearing. It pinned 0x02 until MYND-612 made 0x02 the CURRENT format (per-note line-task records); the hook relocated to 0x03 rather than being burned, since what it proves — a client rejects a version it does not know — is unchanged.",
            &pf_index_format,
            "format_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYI1 magic, no room for the 34-byte header. Rejected before any field read.",
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
            "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_VAULT_INDICES_PLAINTEXT_LEN + 32 (256 MiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing.",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_indices_vectors.json", dump.as_bytes())
            .expect("write vault-indices vectors dump");
    }
}
