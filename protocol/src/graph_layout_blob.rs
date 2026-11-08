// SPDX-License-Identifier: AGPL-3.0

//! `vault.graph` 34-byte-header encrypted knowledge-graph-layout codec —
//! see `myne-agents/docs/spec/protocol.md` § 9.19.
//!
//! `vault.graph` is a vault-level singleton **rebuildable cache** holding the
//! knowledge-graph view's laid-out node positions (id → x/y) plus a staleness
//! marker, so reopening the app restores the previous layout instead of
//! recomputing the force-directed layout from scratch. It lives next to
//! `vault.meta` at `<vault-root>/vault.graph` and is AEAD-encrypted under
//! `graph_layout_key = DeriveSubkey(root_key, SubkeyRole::GraphLayoutKey)`.
//!
//! Like `vault.workspace` (§ 9.7) and `vault.search` (§ 9.6), the inner
//! plaintext is **opaque to this layer** — the desktop client serializes the
//! position map + staleness marker (a client-defined structure) and hands the
//! codec raw bytes. The codec owns only the envelope: magic, versions, nonce,
//! AEAD seal under `graph_layout_key`, and the `aad_graph_layout_blob` binding.
//! The `graph_layout_format_version` byte at offset 5 carries the inner
//! schema for the client's own forward-compat.
//!
//! Class 3 (rebuildable cache): **never synced, never backed up** — a device
//! that lacks it (or finds it stale vs the current index) simply re-runs the
//! layout. Fall-to-rebuild is the caller's discipline; this module emits
//! **honest errors** per failure mode and the caller collapses them to "no
//! restored layout" at the boundary (parity with `search_blob.rs` /
//! `workspace_blob.rs`).
//!
//! ## On-disk layout (spec § 9.19.1)
//!
//! ```text
//! Offset  Size  Field                        Notes
//! ------  ----  ---------------------------  --------------------------------
//! 0       4     magic                        ASCII "MYG1"
//! 4       1     protocol_version             0x01
//! 5       1     graph_layout_format_version  0x01 = the initial position-map
//!                                            inner schema; any other value lets
//!                                            a client fall to rebuild
//! 6       24    nonce                        XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len               big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext                   AEAD ciphertext + 32-byte CTX tag T'
//! ```

use crate::aead::{aad_graph_layout_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_blob_envelope, encode_blob_envelope, encode_blob_envelope_raw, EnvelopeError,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0 — ASCII `"MYG1"` (Myne Graph v1).
pub const GRAPH_LAYOUT_BLOB_MAGIC: [u8; 4] = *b"MYG1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const GRAPH_LAYOUT_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `graph_layout_format_version` byte at offset 5 — the initial position-map
/// inner-plaintext schema. Distinct from `protocol_version`: the position-map
/// schema evolves independently within v0.1, and a client that does not
/// understand a given form falls back to recomputing the layout (§ 9.19.4)
/// rather than mis-parsing.
pub const GRAPH_LAYOUT_BLOB_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into
/// `AAD_graph_layout_blob` (spec § 9.19.3 + § 9.3 offset 6).
pub const GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
pub const GRAPH_LAYOUT_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (16 MiB).
///
/// The payload is one small record per note (`id → x/y`) plus a staleness
/// marker — a few dozen bytes each. 16 MiB is generous headroom (≈ 200k notes)
/// while still bounding the parser's pre-AEAD allocation (DoS-allocation
/// defense, parallel to the § 9.6.5 / § 9.7.4 caps). See spec § 9.19.4.
pub const MAX_GRAPH_LAYOUT_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

/// Closed-enum failure surface for `vault.graph` encode / decode. Mirrors
/// `WorkspaceBlobError`; callers collapse all variants to "no restored layout"
/// and re-run the force layout per spec § 9.19.4.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum GraphLayoutBlobError {
    /// Input shorter than [`GRAPH_LAYOUT_BLOB_HEADER_LEN`] bytes.
    #[error("vault.graph blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYG1`.
    #[error("vault.graph blob magic mismatch (expected MYG1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.graph blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `graph_layout_format_version` is not understood by this client → the
    /// caller falls back to recomputing the layout.
    #[error("vault.graph blob graph_layout_format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_GRAPH_LAYOUT_PLAINTEXT_LEN`] + 32.
    #[error("vault.graph ciphertext_len exceeds 16 MiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `GRAPH_LAYOUT_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.graph blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX commitment tag (§ 6.4
    /// non-distinguishing rule).
    #[error("vault.graph AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_GRAPH_LAYOUT_PLAINTEXT_LEN`].
    #[error("vault.graph plaintext exceeds 16 MiB cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.graph nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for GraphLayoutBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy §6.4, mirroring prefs/search/workspace).
        GraphLayoutBlobError::CannotDecrypt
    }
}

crate::blob_envelope::impl_from_envelope_error!(GraphLayoutBlobError);

/// Encode a `vault.graph` blob from an opaque `plaintext` (the desktop layer's
/// serialized position map + staleness marker), sealing under
/// `graph_layout_key` with `nonce`.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse
/// under the same `graph_layout_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_graph_layout_blob`].
pub fn encode_graph_layout_blob_raw(
    graph_layout_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, GraphLayoutBlobError> {
    let aad = aad_graph_layout_blob(account_number_hash);
    encode_blob_envelope_raw(
        graph_layout_key,
        &GRAPH_LAYOUT_BLOB_MAGIC,
        GRAPH_LAYOUT_BLOB_FORMAT_VERSION,
        &aad,
        MAX_GRAPH_LAYOUT_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(GraphLayoutBlobError::from)
}

/// Encode a `vault.graph` blob, pulling the 24-byte nonce from the OS CSPRNG.
/// Production callers SHOULD use this rather than
/// [`encode_graph_layout_blob_raw`].
pub fn encode_graph_layout_blob(
    graph_layout_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, GraphLayoutBlobError> {
    let aad = aad_graph_layout_blob(account_number_hash);
    encode_blob_envelope(
        graph_layout_key,
        &GRAPH_LAYOUT_BLOB_MAGIC,
        GRAPH_LAYOUT_BLOB_FORMAT_VERSION,
        &aad,
        MAX_GRAPH_LAYOUT_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(GraphLayoutBlobError::from)
}

/// Decode a `vault.graph` blob into its opaque inner plaintext (the serialized
/// position map + staleness marker, for the desktop layer to deserialize).
/// Magic / protocol_version / graph_layout_format_version are all checked
/// BEFORE any decryption; AEAD failure collapses to
/// [`GraphLayoutBlobError::CannotDecrypt`].
pub fn decode_graph_layout_blob(
    graph_layout_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, GraphLayoutBlobError> {
    let aad = aad_graph_layout_blob(account_number_hash);
    decode_blob_envelope(
        graph_layout_key,
        &GRAPH_LAYOUT_BLOB_MAGIC,
        GRAPH_LAYOUT_BLOB_FORMAT_VERSION,
        &aad,
        MAX_GRAPH_LAYOUT_PLAINTEXT_LEN,
        blob,
    )
    .map_err(GraphLayoutBlobError::from)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use crate::test_vector_fmt::{hex_lower, json_escape};

    fn fixed_key() -> [u8; AEAD_KEY_LEN] {
        *derive_subkey(&[0x42; 32], SubkeyRole::GraphLayoutKey)
    }
    fn account_hash() -> [u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN]
    }
    fn nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }

    #[test]
    fn round_trip_opaque_plaintext() {
        let key = fixed_key();
        let h = account_hash();
        let pt = br#"{"nonce":7,"pos":[["n1",12.5,-8.0],["n2",100.0,42.0]]}"#;
        let blob = encode_graph_layout_blob_raw(&key, &h, pt, &nonce()).unwrap();
        assert_eq!(&blob[0..4], b"MYG1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], 0x01);
        let out = decode_graph_layout_blob(&key, &h, &blob).unwrap();
        assert_eq!(out.as_slice(), pt.as_slice());
    }

    #[test]
    fn empty_plaintext_round_trips() {
        let key = fixed_key();
        let h = account_hash();
        let blob = encode_graph_layout_blob_raw(&key, &h, b"", &nonce()).unwrap();
        let out = decode_graph_layout_blob(&key, &h, &blob).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn magic_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_graph_layout_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[0] = b'Z';
        assert_eq!(
            decode_graph_layout_blob(&key, &h, &blob),
            Err(GraphLayoutBlobError::MagicMismatch),
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_graph_layout_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        blob[4] = 0x02;
        assert_eq!(
            decode_graph_layout_blob(&key, &h, &blob),
            Err(GraphLayoutBlobError::ProtocolVersionMismatch),
        );
    }

    #[test]
    fn unsupported_format_rejects_for_rebuild() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_graph_layout_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        // 0x02 is an unknown future form → caller falls back to rebuilding.
        blob[5] = 0x02;
        assert_eq!(
            decode_graph_layout_blob(&key, &h, &blob),
            Err(GraphLayoutBlobError::FormatUnsupported),
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_graph_layout_blob_raw(&key, &h, b"hello", &nonce()).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        assert_eq!(
            decode_graph_layout_blob(&key, &h, &blob),
            Err(GraphLayoutBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let key = fixed_key();
        let blob = encode_graph_layout_blob_raw(&key, &account_hash(), b"hello", &nonce()).unwrap();
        // Different account_number_hash → different AAD → AEAD verify fails.
        let other = [0x44; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_graph_layout_blob(&key, &other, &blob),
            Err(GraphLayoutBlobError::CannotDecrypt),
        );
    }

    #[test]
    fn header_too_short_rejects() {
        let key = fixed_key();
        assert_eq!(
            decode_graph_layout_blob(&key, &account_hash(), b"MYG1"),
            Err(GraphLayoutBlobError::HeaderTooShort),
        );
    }

    #[test]
    fn oversize_ciphertext_len_rejects_before_indexing() {
        let key = fixed_key();
        let h = account_hash();
        let mut blob = encode_graph_layout_blob_raw(&key, &h, b"x", &nonce()).unwrap();
        // Force ciphertext_len to a hostile huge value.
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_graph_layout_blob(&key, &h, &blob),
            Err(GraphLayoutBlobError::CiphertextLenOverflow),
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/graph-layout/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_graph_layout_vectors.json`,
    /// ready to copy verbatim into the companion repo. Mirrors
    /// `workspace_blob.rs::emit_vault_workspace_vectors_for_paste` (MYG1 is a
    /// structural twin of MYW1: opaque inner plaintext, 34-byte envelope).
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_graph_layout_vectors_for_paste -- --ignored`
    ///
    /// 12 cases (§9.19): 3 `encrypt` × {empty / small position-map / 1-KB
    /// opaque} + 1 `decrypt_ok` + 2 `decrypt_aead_fail` (tag-tamper +
    /// cross-vault, both non-distinguishing per §6.4) + 6 `parse_fail` (one per
    /// distinguishable pre-decryption structural reject). `graph_layout_key` is
    /// derived from `root_key` via `SubkeyRole::GraphLayoutKey`, exercising the
    /// full root_key → KEK → blob lineage.
    #[test]
    #[ignore]
    fn emit_graph_layout_vectors_for_paste() {
        extern crate std;

        // Distinct byte patterns per field (match this mod's unit fixtures:
        // 0x42 root / 0x33 hash / 0x77 nonce) so tests and vectors stay aligned.
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN] =
            [0x44; GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);

        // Deterministic opaque plaintexts (the codec is payload-agnostic). The
        // small case is a realistic v0.1 position-map payload (§9.19.2).
        let plaintext_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let plaintext_small: alloc::vec::Vec<u8> =
            (*br#"{"v":1,"pos":[["n1",12.5,-8.0],["n2",100.0,42.0]]}"#).to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_empty = encode_graph_layout_blob_raw(
            &graph_layout_key,
            &account_hash,
            &plaintext_empty,
            &nonce,
        )
        .expect("encode empty");
        let blob_small = encode_graph_layout_blob_raw(
            &graph_layout_key,
            &account_hash,
            &plaintext_small,
            &nonce,
        )
        .expect("encode small");
        let blob_1kb =
            encode_graph_layout_blob_raw(&graph_layout_key, &account_hash, &plaintext_1kb, &nonce)
                .expect("encode 1kb");

        // Round-trip sanity on the small blob.
        let decoded = decode_graph_layout_blob(&graph_layout_key, &account_hash, &blob_small)
            .expect("decode small round-trip");
        assert_eq!(decoded.as_slice(), plaintext_small.as_slice());

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_graph_layout_blob(&graph_layout_key, &account_hash, &blob_tag_tamper),
            Err(GraphLayoutBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): valid blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_graph_layout_blob(&graph_layout_key, &other_account_hash, &blob_small),
            Err(GraphLayoutBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_format = blob_small.clone();
        // 0x02 is an unknown future graph-layout schema → format_unsupported.
        pf_format[5] = 0x02;
        let pf_header_short: alloc::vec::Vec<u8> = GRAPH_LAYOUT_BLOB_MAGIC.to_vec(); // 4 bytes < 34
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        let root_key_hex = hex_lower(&root_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let nonce_hex = hex_lower(&nonce);
        let graph_layout_key_hex = hex_lower(&*graph_layout_key);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"graph-layout\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.19 + §3.4 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_graph_layout_blob_raw + protocol::decode_graph_layout_blob byte mapping for the MYG1 vault.graph encrypted knowledge-graph layout-cache codec (§9.19). The inner plaintext is OPAQUE (client-serialized position map) — no canonical-JSON discipline, like vault.workspace. graph_layout_key = derive_subkey(root_key, SubkeyRole::GraphLayoutKey) (role 'graph-layout-key'); account_number_hash binds via aad_graph_layout_blob (role 'graph-layout-blob' — a DISTINCT load-bearing string). 12 cases: 3 encrypt (empty / small position-map / 1-KB) + 1 decrypt_ok + 2 decrypt_aead_fail (tag-tamper + cross-vault, both non-distinguishing per §6.4) + 6 parse_fail (one per distinguishable pre-decryption structural reject). Cases generated by `cargo test -p protocol --lib emit_graph_layout_vectors_for_paste -- --ignored` (in protocol/src/graph_layout_blob.rs).\",\n");
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
                "      \"vector_id\": \"graph-layout/v0.1/{}\",\n",
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
                    "      \"informational_graph_layout_key_hex\": \"{}\",\n",
                    graph_layout_key_hex
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_graph_layout_blob_hex\": \"{}\"\n",
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
            "Encode an empty inner plaintext (no restored layout — the caller-side default; the reader recomputes). The smallest valid MYG1 blob: 34-byte header + 0-byte ciphertext + 32-byte CTX tag = 66 bytes. ciphertext_len field = 32.",
            &plaintext_empty,
            &blob_empty,
            true,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-small-position-map",
            "Encode a 50-byte v0.1 position-map payload ({\\\"v\\\":1,\\\"pos\\\":[[id,x,y],...]}). The codec is byte-transparent — the JSON shape is the desktop client's, not the codec's. Expected blob = 34 + 50 + 32 = 116 bytes.",
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
        dump.push_str(
            "      \"vector_id\": \"graph-layout/v0.1/decrypt-ok-small-position-map\",\n",
        );
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the small-position-map blob back to its opaque plaintext under the matching root_key (→ graph_layout_key) + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact inner bytes the desktop layer deserializes into node positions.")
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
                "      \"vector_id\": \"graph-layout/v0.1/{}\",\n",
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
            "Take the small-position-map blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt — the recomputed CTX commitment no longer matches. Same observable outcome as the cross-vault case below (spec §6.4).",
            &blob_tag_tamper,
            &account_hash_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );

        emit_aead_fail(
            &mut dump,
            "decrypt-cross-vault-account-hash",
            "Take the intact small-position-map blob but decrypt under a DIFFERENT account_number_hash (0x44×16 instead of 0x33×16). aad_graph_layout_blob binds the account hash, so the AAD differs and AEAD verification fails — a blob from vault A cannot be opened against vault B. Collapses to the same CannotDecrypt as the tamper case; ports MUST NOT distinguish the two.",
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
                "      \"vector_id\": \"graph-layout/v0.1/{}\",\n",
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
            "First byte of the MYG1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.19.1).",
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
            "graph_layout_format_version byte (offset 5) set to 0x02 — a future position-map serialization this client does not understand (0x01 is the initial form). The decoder rejects cleanly so the caller falls back to recomputing the layout (§9.19.4). This is the forward-migration hook and is load-bearing.",
            &pf_format,
            "format_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYG1 magic, no room for the 34-byte header. Rejected before any field read.",
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
            "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_GRAPH_LAYOUT_PLAINTEXT_LEN + 32 (16 MiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing.",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_graph_layout_vectors.json", dump.as_bytes())
            .expect("write graph-layout vectors dump");
    }
}
