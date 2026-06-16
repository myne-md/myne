// SPDX-License-Identifier: AGPL-3.0-or-later

//! `vault.search` 34-byte-header encrypted search-index codec
//! (MYND-29; `docs/spec/protocol.md` § 9.6).
//!
//! `vault.search` is a vault-level singleton artifact holding the
//! serialized full-text search index. It lives next to `vault.meta` /
//! `vault.prefs` at `<vault-root>/vault.search` and is AEAD-encrypted
//! under `search_index_key = DeriveSubkey(root_key,
//! SubkeyRole::SearchIndexKey)`.
//!
//! This codec is **payload-agnostic**: the inner plaintext is an opaque
//! byte string produced by the desktop layer (the serialized index plus
//! its `{note_id → content_nonce}` staleness manifest — both are
//! plaintext-derived and so MUST live INSIDE this AEAD envelope, never in
//! the cleartext header). The protocol crate only owns the crypto framing
//! (magic, format/version, AEAD, AAD) — the load-bearing parts — while the
//! index/manifest serialization format is the desktop layer's concern.
//!
//! ## On-disk layout (spec § 9.6.1)
//!
//! ```text
//! Offset  Size  Field                  Notes
//! ------  ----  ---------------------  -----------------------------------
//! 0       4     magic                  ASCII "MYS1"
//! 4       1     protocol_version       0x01
//! 5       1     index_format_version   0x01 (engine/serialization format;
//!                                       a future engine bumps this so an old
//!                                       decoder cleanly rejects → rebuild)
//! 6       24    nonce                  XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len         big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext             AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes. No public `account_number_hash` byte — it binds
//! via the AAD (§ 9.6.2) without consuming header bytes, exactly like
//! `vault.prefs`.
//!
//! ## Migration-less / fall-to-rebuild semantic
//!
//! Like `prefs.rs`, this module emits **honest errors** for each failure
//! mode; the desktop caller collapses any error (absent / truncated /
//! AEAD-fail / unsupported-format / stale-manifest) to a full index
//! rebuild from the decrypted notes. The `index_format_version` byte is
//! the forward-migration hook: a future engine writes a higher value, and
//! a client that only understands `0x01` returns
//! [`SearchBlobError::IndexFormatUnsupported`] → rebuild under the current
//! engine. The index is always reconstructible from the notes, so an
//! unreadable `vault.search` is never data loss.

use crate::aead::{
    aad_search_index_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYS1"` (Myne Search v1).
pub const SEARCH_BLOB_MAGIC: [u8; 4] = *b"MYS1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const SEARCH_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `index_format_version` byte at offset 5 — the engine/serialization
/// format of the inner plaintext. `0x01` = the v0.1 custom inverted-index
/// serialization (MYND-29 Task 1). A future engine or format bumps this so
/// an older decoder rejects cleanly and the caller rebuilds.
pub const SEARCH_BLOB_INDEX_FORMAT_V1: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const SEARCH_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const SEARCH_BLOB_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (serialized index + manifest). A
/// generous 256 MiB ceiling — far above any realistic Phase-1 vault — that
/// turns a hostile `ciphertext_len` into a clean error instead of an absurd
/// allocation / panicking slice index.
pub const MAX_SEARCH_INDEX_PLAINTEXT_LEN: usize = 256 * 1024 * 1024;

/// Failure modes of the `vault.search` codec. Distinct variants for
/// observability; the desktop caller collapses all of them to a rebuild.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SearchBlobError {
    /// Input shorter than [`SEARCH_BLOB_HEADER_LEN`] bytes.
    #[error("vault.search blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYS1`.
    #[error("vault.search blob magic mismatch (expected MYS1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("vault.search blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `index_format_version` is not understood by this client → rebuild.
    #[error("vault.search blob index_format_version unsupported")]
    IndexFormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_SEARCH_INDEX_PLAINTEXT_LEN`] + 32.
    #[error("vault.search ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("vault.search blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD).
    #[error("vault.search AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_SEARCH_INDEX_PLAINTEXT_LEN`].
    #[error("vault.search plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.search nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for SearchBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy §6.4 discipline, mirroring prefs.rs).
        SearchBlobError::CannotDecrypt
    }
}

/// Encode a `vault.search` blob from an opaque `plaintext` (the desktop
/// layer's serialized index + manifest), sealing under `search_index_key`
/// with `nonce`.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse
/// under the same `search_index_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_search_index_blob`], which pulls randomness from `getrandom`.
pub fn encode_search_index_blob_raw(
    search_index_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; SEARCH_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, SearchBlobError> {
    if plaintext.len() > MAX_SEARCH_INDEX_PLAINTEXT_LEN {
        return Err(SearchBlobError::PlaintextTooLarge);
    }

    let aad = aad_search_index_blob(account_number_hash);
    let sealed = aead_seal_ctx(search_index_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(SEARCH_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&SEARCH_BLOB_MAGIC);
    out.push(SEARCH_BLOB_PROTOCOL_VERSION);
    out.push(SEARCH_BLOB_INDEX_FORMAT_V1);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.search` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_search_index_blob_raw`].
pub fn encode_search_index_blob(
    search_index_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; SEARCH_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, SearchBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| SearchBlobError::RandomnessUnavailable)?;
    let result =
        encode_search_index_blob_raw(search_index_key, account_number_hash, plaintext, &nonce);
    nonce.zeroize();
    result
}

/// Decode a `vault.search` blob into its opaque inner plaintext (the
/// serialized index + manifest, for the desktop layer to deserialize).
/// Magic / protocol_version / index_format_version are all checked BEFORE
/// any decryption; AEAD failure collapses to [`SearchBlobError::CannotDecrypt`].
pub fn decode_search_index_blob(
    search_index_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; SEARCH_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, SearchBlobError> {
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < SEARCH_BLOB_HEADER_LEN {
        return Err(SearchBlobError::HeaderTooShort);
    }
    if blob[0..4] != SEARCH_BLOB_MAGIC {
        return Err(SearchBlobError::MagicMismatch);
    }
    if blob[4] != SEARCH_BLOB_PROTOCOL_VERSION {
        return Err(SearchBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != SEARCH_BLOB_INDEX_FORMAT_V1 {
        return Err(SearchBlobError::IndexFormatUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > MAX_SEARCH_INDEX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(SearchBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = SEARCH_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(SearchBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let aad = aad_search_index_blob(account_number_hash);
    let plaintext = aead_open_ctx(
        search_index_key,
        &nonce,
        &blob[SEARCH_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; SEARCH_BLOB_ACCOUNT_HASH_LEN] = [0x7c; SEARCH_BLOB_ACCOUNT_HASH_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_search_index_blob_raw(&KEY, &ACCOUNT_HASH, plaintext, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = b"\x00\x01serialized index + manifest bytes\xff";
        let blob = encode(payload);
        let decoded = decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        // An empty index (fresh vault, no notes) must round-trip.
        let blob = encode(b"");
        let decoded = decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert!(decoded.is_empty());
    }

    #[test]
    fn header_layout_is_magic_version_format_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYS1");
        assert_eq!(blob[4], SEARCH_BLOB_PROTOCOL_VERSION);
        assert_eq!(blob[5], SEARCH_BLOB_INDEX_FORMAT_V1);
        assert_eq!(&blob[6..30], &NONCE);
        // ciphertext_len = plaintext (3) + CTX tag (32) = 35.
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), SEARCH_BLOB_HEADER_LEN + 35);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X'; // corrupt magic
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::MagicMismatch)
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let mut blob = encode(b"abc");
        blob[4] = 0x02;
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn unsupported_index_format_rejects_for_rebuild() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future engine/format
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::IndexFormatUnsupported)
        );
    }

    #[test]
    fn wrong_key_fails_decrypt() {
        let blob = encode(b"secret index");
        let wrong = [0x43; AEAD_KEY_LEN];
        assert_eq!(
            decode_search_index_blob(&wrong, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_account_hash_fails_decrypt() {
        // account_number_hash binds via AAD — a different vault's hash fails.
        let blob = encode(b"secret index");
        let other = [0x7d; SEARCH_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_search_index_blob(&KEY, &other, &blob),
            Err(SearchBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_decrypt() {
        let mut blob = encode(b"secret index");
        let last = blob.len() - 1;
        blob[last] ^= 0xff; // flip a CTX-tag byte
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short_rejects() {
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, b"MYS1"),
            Err(SearchBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn truncated_ciphertext_rejects() {
        let mut blob = encode(b"abc");
        blob.truncate(blob.len() - 1); // drop a ciphertext byte
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn oversize_ciphertext_len_rejects_without_panicking() {
        // Craft a header advertising an absurd ciphertext_len; the overflow
        // guard rejects before any slice indexing.
        let mut blob = encode(b"abc");
        blob[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        assert_eq!(
            decode_search_index_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(SearchBlobError::CiphertextLenOverflow)
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/vault-search/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_vault_search_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_vault_search_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (MYND-29 / §9.6):
    /// - 3 `encrypt` × {empty / small / 1-KB opaque plaintext} — pin the
    ///   `MYS1` byte output. The empty case is a fresh-vault index;
    ///   `search_index_key` is derived from `root_key` via
    ///   `SubkeyRole::SearchIndexKey` so the vector exercises the full
    ///   root_key → KEK → blob lineage.
    /// - 1 `decrypt_ok` (1-KB round-trip) — proves the decoder recovers
    ///   the opaque inner plaintext.
    /// - 2 `decrypt_aead_fail` — (a) single-byte CTX-tag tamper, (b)
    ///   cross-vault (wrong `account_number_hash` via the AAD binding).
    ///   Both collapse to `SearchBlobError::CannotDecrypt`
    ///   non-distinguishing per spec §6.4.
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`,
    ///   `IndexFormatUnsupported`, `HeaderTooShort`, `CiphertextTruncated`,
    ///   `CiphertextLenOverflow`). Distinct from the AEAD-failure surface:
    ///   these run BEFORE decryption and a port MUST surface the specific
    ///   reject so the caller can fall to a full index rebuild (§9.6.4).
    ///
    /// `PlaintextTooLarge` + `RandomnessUnavailable` are encode-side and
    /// cannot be expressed as a decode-a-blob case, so they are not
    /// vectored (documented in the category's `schema.md`).
    #[test]
    #[ignore]
    fn emit_vault_search_vectors_for_paste() {
        extern crate std;
        use crate::subkey::{derive_subkey, SubkeyRole};

        fn hex_lower(bytes: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> alloc::string::String {
            let mut out = alloc::string::String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&alloc::format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        // Distinct byte patterns per field — easy visual cross-check.
        // root_key (NOT the KEK): the runner derives search_index_key from
        // this via derive_subkey(SubkeyRole::SearchIndexKey), exactly as a
        // production caller would. account_hash binds via the AAD.
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; SEARCH_BLOB_ACCOUNT_HASH_LEN] = [0x7c; SEARCH_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; SEARCH_BLOB_ACCOUNT_HASH_LEN] =
            [0x7d; SEARCH_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

        let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);

        // Deterministic opaque plaintexts (the codec is payload-agnostic).
        let plaintext_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let plaintext_small: alloc::vec::Vec<u8> =
            (*b"\x00\x01serialized index + manifest bytes\xff").to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_empty = encode_search_index_blob_raw(
            &search_index_key,
            &account_hash,
            &plaintext_empty,
            &nonce,
        )
        .expect("encode empty");
        let blob_small = encode_search_index_blob_raw(
            &search_index_key,
            &account_hash,
            &plaintext_small,
            &nonce,
        )
        .expect("encode small");
        let blob_1kb =
            encode_search_index_blob_raw(&search_index_key, &account_hash, &plaintext_1kb, &nonce)
                .expect("encode 1kb");

        // Round-trip sanity on the 1-KB blob.
        let decoded = decode_search_index_blob(&search_index_key, &account_hash, &blob_1kb)
            .expect("decode 1kb round-trip");
        assert_eq!(decoded.as_slice(), plaintext_1kb.as_slice());

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_search_index_blob(&search_index_key, &account_hash, &blob_tag_tamper),
            Err(SearchBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): valid blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_search_index_blob(&search_index_key, &other_account_hash, &blob_small),
            Err(SearchBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_index_format = blob_small.clone();
        pf_index_format[5] = 0x02;
        let pf_header_short: alloc::vec::Vec<u8> = SEARCH_BLOB_MAGIC.to_vec(); // 4 bytes < 34
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        let root_key_hex = hex_lower(&root_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let nonce_hex = hex_lower(&nonce);
        let search_index_key_hex = hex_lower(&*search_index_key);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-search\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.6 + §3.4 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_search_index_blob_raw + protocol::decode_search_index_blob byte mapping for the MYS1 vault.search encrypted search-index codec (MYND-29). The inner plaintext is OPAQUE (engine-serialized index + manifest) — no canonical-JSON discipline, unlike vault-prefs. search_index_key = derive_subkey(root_key, SubkeyRole::SearchIndexKey) (role 'search-index-key'); account_number_hash binds via aad_search_index_blob (role 'search-index-blob'). 12 cases: 3 encrypt (empty / small / 1-KB) + 1 decrypt_ok + 2 decrypt_aead_fail (tag-tamper + cross-vault, both non-distinguishing per §6.4) + 6 parse_fail (one per distinguishable pre-decryption structural reject). Cases generated by `cargo test -p protocol --lib emit_vault_search_vectors_for_paste -- --ignored` (in protocol/src/search_blob.rs).\",\n");
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
                "      \"vector_id\": \"vault-search/v0.1/{}\",\n",
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
                    "      \"informational_search_index_key_hex\": \"{}\",\n",
                    search_index_key_hex
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_search_blob_hex\": \"{}\"\n",
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
            "Encode an empty inner plaintext (fresh vault, no notes indexed). The smallest valid MYS1 blob: 34-byte header + 0-byte ciphertext + 32-byte CTX tag = 66 bytes. ciphertext_len field = 32.",
            &plaintext_empty,
            &blob_empty,
            true,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-small",
            "Encode a 38-byte opaque payload (a stand-in for a serialized index + manifest snapshot, with leading/trailing non-ASCII bytes to prove the codec is byte-transparent). Expected blob = 34 + 38 + 32 = 104 bytes.",
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
        dump.push_str("      \"vector_id\": \"vault-search/v0.1/decrypt-ok-1kb\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the 1-KB blob back to its opaque plaintext under the matching root_key (→ search_index_key) + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact inner bytes the desktop layer will deserialize.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_1kb)
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
            hex_lower(&plaintext_1kb)
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
                "      \"vector_id\": \"vault-search/v0.1/{}\",\n",
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
            "Take the small blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt — the recomputed CTX commitment no longer matches. Same observable outcome as the cross-vault case below (spec §6.4).",
            &blob_tag_tamper,
            &account_hash_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );

        emit_aead_fail(
            &mut dump,
            "decrypt-cross-vault-account-hash",
            "Take the intact small blob but decrypt under a DIFFERENT account_number_hash (0x7d×16 instead of 0x7c×16). aad_search_index_blob binds the account hash, so the AAD differs and AEAD verification fails — a blob from vault A cannot be opened against vault B. Collapses to the same CannotDecrypt as the tamper case; ports MUST NOT distinguish the two.",
            &blob_small,
            &other_account_hash_hex,
            "intact blob decrypted under wrong account_number_hash (0x7d×16)",
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
                "      \"vector_id\": \"vault-search/v0.1/{}\",\n",
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
            "First byte of the MYS1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.6.1).",
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
            "parse-fail-index-format-unsupported",
            "index_format_version byte (offset 5) set to 0x02 — a future inverted-index serialization a v0.1 engine does not understand. The decoder rejects cleanly so the caller rebuilds the index from notes (§9.6.4). This is the forward-migration hook and is load-bearing.",
            &pf_index_format,
            "index_format_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYS1 magic, no room for the 34-byte header. Rejected before any field read.",
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
            "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_SEARCH_INDEX_PLAINTEXT_LEN + 32. The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing.",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_search_vectors.json", dump.as_bytes())
            .expect("write vault-search vectors dump");
    }
}
