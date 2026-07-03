// SPDX-License-Identifier: AGPL-3.0

//! `vault.dictionary` 34-byte-header encrypted personal-dictionary codec
//! (MYND-266; `docs/spec/protocol.md` § 9.13).
//!
//! `vault.dictionary` is a vault-level singleton artifact holding the user's
//! personal spell-check dictionary — the added-words set plus a vault-wide
//! ignore set. It lives next to `vault.meta` / `vault.prefs` / `vault.search`
//! at `<vault-root>/vault.dictionary` and is AEAD-encrypted under
//! `personal_dictionary_key = DeriveSubkey(root_key, SubkeyRole::PersonalDictKey)`.
//!
//! This codec is **payload-agnostic**, exactly like `search_blob.rs`: the
//! inner plaintext is an opaque byte string produced by the desktop layer
//! (the `dict_format_version 0x01` format is a postcard-serialized
//! `{personal_words, ignore_words}` struct — both are plaintext-derived
//! AS3-Sensitive user vocabulary and so MUST live INSIDE this AEAD envelope,
//! never in the cleartext header). The protocol crate owns only the crypto
//! framing (magic, format/version, AEAD, AAD) — the load-bearing parts — while
//! the word-set serialization is the desktop layer's concern.
//!
//! ## On-disk layout (spec § 9.13.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYD1"
//! 4       1     protocol_version     0x01
//! 5       1     dict_format_version  0x01 (inner word-set serialization;
//!                                     a future format bumps this so an old
//!                                     decoder cleanly rejects → empty)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes. No public `account_number_hash` byte — it binds via
//! the AAD (§ 9.13.3) without consuming header bytes, exactly like
//! `vault.prefs` / `vault.search`.
//!
//! ## Fall-back-to-empty semantic (spec § 9.13.4)
//!
//! Like `prefs.rs` / `search_blob.rs`, this module emits **honest errors** for
//! each failure mode; the desktop caller collapses any error (absent /
//! truncated / AEAD-fail / unsupported-format) to the **empty dictionary**
//! (both sets empty). A replayed/tampered/stale blob is non-load-bearing — the
//! worst case is an out-of-date word set, never a weakened guarantee — so the
//! `dict_format_version` byte is the forward-migration hook: a future format
//! writes a higher value, and a `0x01`-only client returns
//! [`DictionaryBlobError::DictFormatUnsupported`] → empty.

use crate::aead::{aad_personal_dictionary_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_blob_envelope, encode_blob_envelope, encode_blob_envelope_raw, EnvelopeError,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0 — ASCII `"MYD1"` (Myne Dictionary v1).
pub const DICTIONARY_BLOB_MAGIC: [u8; 4] = *b"MYD1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const DICTIONARY_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `dict_format_version` byte at offset 5 — the serialization format of the
/// inner word-set plaintext. `0x01` = the v0.1 postcard `{personal_words,
/// ignore_words}` format (host-side). A future format bumps this so an older
/// decoder rejects cleanly and the caller falls back to the empty dictionary.
pub const DICTIONARY_BLOB_FORMAT_V1: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const DICTIONARY_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const DICTIONARY_BLOB_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (serialized word sets). 4 MiB — far
/// above a realistic personal dictionary (hundreds of thousands of words) —
/// that turns a hostile `ciphertext_len` into a clean error instead of an
/// absurd allocation / panicking slice index (§ 9.13.5; approved sign-off
/// 2026-06-14).
pub const MAX_DICTIONARY_PLAINTEXT_LEN: usize = 4 * 1024 * 1024;

/// Failure modes of the `vault.dictionary` codec. Distinct variants for
/// observability; the desktop caller collapses all of them to the empty
/// dictionary (fall-back-to-empty, § 9.13.4).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum DictionaryBlobError {
    /// Input shorter than [`DICTIONARY_BLOB_HEADER_LEN`] bytes.
    #[error("vault.dictionary blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYD1`.
    #[error("vault.dictionary blob magic mismatch (expected MYD1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("vault.dictionary blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `dict_format_version` is not understood by this client → empty.
    #[error("vault.dictionary blob dict_format_version unsupported")]
    DictFormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_DICTIONARY_PLAINTEXT_LEN`] + 32.
    #[error("vault.dictionary ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("vault.dictionary blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD).
    #[error("vault.dictionary AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_DICTIONARY_PLAINTEXT_LEN`].
    #[error("vault.dictionary plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.dictionary nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for DictionaryBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline, mirroring
        // prefs.rs / search_blob.rs).
        DictionaryBlobError::CannotDecrypt
    }
}

impl From<EnvelopeError> for DictionaryBlobError {
    /// Map the shared-envelope error into this codec's public variant so the
    /// distinguishable-reject surface (and its vectors) stay unchanged. Note the
    /// `FormatUnsupported` → `DictFormatUnsupported` rename (§9.13 spelling).
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::HeaderTooShort => DictionaryBlobError::HeaderTooShort,
            EnvelopeError::MagicMismatch => DictionaryBlobError::MagicMismatch,
            EnvelopeError::ProtocolVersionMismatch => DictionaryBlobError::ProtocolVersionMismatch,
            EnvelopeError::FormatUnsupported => DictionaryBlobError::DictFormatUnsupported,
            EnvelopeError::CiphertextLenOverflow => DictionaryBlobError::CiphertextLenOverflow,
            EnvelopeError::CiphertextTruncated => DictionaryBlobError::CiphertextTruncated,
            EnvelopeError::CannotDecrypt => DictionaryBlobError::CannotDecrypt,
            EnvelopeError::PlaintextTooLarge => DictionaryBlobError::PlaintextTooLarge,
            EnvelopeError::RandomnessUnavailable => DictionaryBlobError::RandomnessUnavailable,
        }
    }
}

/// Encode a `vault.dictionary` blob from an opaque `plaintext` (the desktop
/// layer's serialized `{personal_words, ignore_words}`), sealing under
/// `personal_dictionary_key` with `nonce`.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse
/// under the same `personal_dictionary_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_dictionary_blob`], which pulls randomness from `getrandom`.
pub fn encode_dictionary_blob_raw(
    personal_dictionary_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, DictionaryBlobError> {
    let aad = aad_personal_dictionary_blob(account_number_hash);
    encode_blob_envelope_raw(
        personal_dictionary_key,
        &DICTIONARY_BLOB_MAGIC,
        DICTIONARY_BLOB_FORMAT_V1,
        &aad,
        MAX_DICTIONARY_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(DictionaryBlobError::from)
}

/// Encode a `vault.dictionary` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_dictionary_blob_raw`].
pub fn encode_dictionary_blob(
    personal_dictionary_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, DictionaryBlobError> {
    let aad = aad_personal_dictionary_blob(account_number_hash);
    encode_blob_envelope(
        personal_dictionary_key,
        &DICTIONARY_BLOB_MAGIC,
        DICTIONARY_BLOB_FORMAT_V1,
        &aad,
        MAX_DICTIONARY_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(DictionaryBlobError::from)
}

/// Decode a `vault.dictionary` blob into its opaque inner plaintext (the
/// serialized word sets, for the desktop layer to deserialize). Magic /
/// protocol_version / dict_format_version are all checked BEFORE any
/// decryption; AEAD failure collapses to [`DictionaryBlobError::CannotDecrypt`].
pub fn decode_dictionary_blob(
    personal_dictionary_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, DictionaryBlobError> {
    let aad = aad_personal_dictionary_blob(account_number_hash);
    decode_blob_envelope(
        personal_dictionary_key,
        &DICTIONARY_BLOB_MAGIC,
        DICTIONARY_BLOB_FORMAT_V1,
        &aad,
        MAX_DICTIONARY_PLAINTEXT_LEN,
        blob,
    )
    .map_err(DictionaryBlobError::from)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN] =
        [0x7c; DICTIONARY_BLOB_ACCOUNT_HASH_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_dictionary_blob_raw(&KEY, &ACCOUNT_HASH, plaintext, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = b"\x00\x01serialized personal+ignore word sets\xff";
        let blob = encode(payload);
        let decoded = decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        // An empty dictionary (fresh vault) must round-trip.
        let blob = encode(b"");
        let decoded = decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert!(decoded.is_empty());
    }

    #[test]
    fn header_layout_is_magic_version_format_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYD1");
        assert_eq!(blob[4], DICTIONARY_BLOB_PROTOCOL_VERSION);
        assert_eq!(blob[5], DICTIONARY_BLOB_FORMAT_V1);
        assert_eq!(&blob[6..30], &NONCE);
        // ciphertext_len = plaintext (3) + CTX tag (32) = 35.
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), DICTIONARY_BLOB_HEADER_LEN + 35);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::MagicMismatch)
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let mut blob = encode(b"abc");
        blob[4] = 0x02;
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn unsupported_dict_format_rejects_for_empty() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future word-set format
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::DictFormatUnsupported)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"hello words");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_account_hash_fails_aead_cross_vault() {
        // A blob from vault A fails AEAD under vault B's account_number_hash
        // (the AAD binds vault identity) — cross-vault substitution defense.
        let blob = encode(b"vault A words");
        let other_hash = [0x11; DICTIONARY_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_dictionary_blob(&KEY, &other_hash, &blob),
            Err(DictionaryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_key_fails_aead() {
        let blob = encode(b"words");
        let other_key = [0x01; AEAD_KEY_LEN];
        assert_eq!(
            decode_dictionary_blob(&other_key, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short_rejects() {
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, b"MYD1"),
            Err(DictionaryBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn truncated_ciphertext_rejects() {
        let mut blob = encode(b"abc");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn ciphertext_len_overflow_rejects_before_alloc() {
        let mut blob = encode(b"abc");
        // Set ciphertext_len to a hostile huge value.
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(DictionaryBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn plaintext_over_cap_rejects_on_encode() {
        let big = alloc::vec![0u8; MAX_DICTIONARY_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_dictionary_blob_raw(&KEY, &ACCOUNT_HASH, &big, &NONCE),
            Err(DictionaryBlobError::PlaintextTooLarge)
        );
    }

    #[test]
    fn convenience_encode_round_trips_via_getrandom() {
        let payload = b"convenience path";
        let blob = encode_dictionary_blob(&KEY, &ACCOUNT_HASH, payload).expect("encode");
        let decoded = decode_dictionary_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/vault-dictionary/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_vault_dictionary_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_vault_dictionary_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (MYND-266 / §9.13), mirroring the `vault-indices` shape:
    /// - 3 `encrypt` × {empty / small word-set descriptor / 1-KB opaque
    ///   plaintext} — pin the `MYD1` byte output. `personal_dictionary_key`
    ///   is derived from `root_key` via `SubkeyRole::PersonalDictKey` so the
    ///   vector exercises the full root_key → KEK → blob lineage.
    /// - 1 `decrypt_ok` (small-descriptor round-trip).
    /// - 2 `decrypt_aead_fail` — (a) single-byte CTX-tag tamper, (b)
    ///   cross-vault (wrong `account_number_hash` via the AAD binding). Both
    ///   collapse to `DictionaryBlobError::CannotDecrypt` non-distinguishing
    ///   per spec §6.4 — the real-key fixtures make a skipped check observable.
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `DictFormatUnsupported`,
    ///   `HeaderTooShort`, `CiphertextTruncated`, `CiphertextLenOverflow`).
    ///   `DictFormatUnsupported` (vector `format_unsupported`) is the
    ///   load-bearing forward hook (§9.13.4).
    ///
    /// `PlaintextTooLarge` + `RandomnessUnavailable` are encode-side and
    /// cannot be expressed as a decode-a-blob case, so they are not vectored
    /// (documented in the category's `schema.md`).
    #[test]
    #[ignore]
    fn emit_vault_dictionary_vectors_for_paste() {
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

        // Distinct byte patterns per field — easy visual cross-check. root_key
        // (NOT the KEK): the runner derives personal_dictionary_key from this
        // via derive_subkey(SubkeyRole::PersonalDictKey), exactly as a
        // production caller would. account_hash binds via the AAD. Patterns
        // match the vault-singleton generator convention (0x42 root / 0x33
        // hash / 0x44 cross-vault / 0x77 nonce).
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; DICTIONARY_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN] =
            [0x44; DICTIONARY_BLOB_ACCOUNT_HASH_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let personal_dictionary_key = derive_subkey(&root_key, SubkeyRole::PersonalDictKey);

        // Deterministic opaque plaintexts (the codec is payload-agnostic). The
        // inner format is the desktop layer's postcard {personal_words,
        // ignore_words}; vectors pin arbitrary opaque bytes since the codec is
        // byte-transparent. The small case is an illustrative word-set
        // descriptor (its JSON-ish shape is NOT the real serialization).
        let plaintext_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let plaintext_small: alloc::vec::Vec<u8> =
            (*br#"{"personal":["crockford","myne","vodozemac"],"ignore":["lorem"]}"#).to_vec();
        let plaintext_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_empty = encode_dictionary_blob_raw(
            &personal_dictionary_key,
            &account_hash,
            &plaintext_empty,
            &nonce,
        )
        .expect("encode empty");
        let blob_small = encode_dictionary_blob_raw(
            &personal_dictionary_key,
            &account_hash,
            &plaintext_small,
            &nonce,
        )
        .expect("encode small");
        let blob_1kb = encode_dictionary_blob_raw(
            &personal_dictionary_key,
            &account_hash,
            &plaintext_1kb,
            &nonce,
        )
        .expect("encode 1kb");

        // Round-trip sanity on the small blob.
        let decoded = decode_dictionary_blob(&personal_dictionary_key, &account_hash, &blob_small)
            .expect("decode small round-trip");
        assert_eq!(decoded.as_slice(), plaintext_small.as_slice());

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &blob_tag_tamper),
            Err(DictionaryBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): valid blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &other_account_hash, &blob_small),
            Err(DictionaryBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_dict_format = blob_small.clone();
        pf_dict_format[5] = 0x02;
        let pf_header_short: alloc::vec::Vec<u8> = DICTIONARY_BLOB_MAGIC.to_vec(); // 4 < 34
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        // Sanity: each corrupted blob hits its intended reject (real key/hash
        // for the non-distinguishing rejects; dummy is fine pre-decryption).
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_magic),
            Err(DictionaryBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_version),
            Err(DictionaryBlobError::ProtocolVersionMismatch)
        );
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_dict_format),
            Err(DictionaryBlobError::DictFormatUnsupported)
        );
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_header_short),
            Err(DictionaryBlobError::HeaderTooShort)
        );
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_truncated),
            Err(DictionaryBlobError::CiphertextTruncated)
        );
        assert_eq!(
            decode_dictionary_blob(&personal_dictionary_key, &account_hash, &pf_len_overflow),
            Err(DictionaryBlobError::CiphertextLenOverflow)
        );

        let root_key_hex = hex_lower(&root_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let nonce_hex = hex_lower(&nonce);
        let personal_dictionary_key_hex = hex_lower(&*personal_dictionary_key);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-dictionary\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.13 + §3.4 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_dictionary_blob_raw + protocol::decode_dictionary_blob byte mapping for the MYD1 vault.dictionary encrypted personal-dictionary codec (MYND-266; §9.13). The inner plaintext is OPAQUE (the desktop layer's serialized {personal_words, ignore_words} word sets) — no canonical-JSON discipline, unlike vault-prefs; the structural twin of vault.search/vault.workspace/vault.indices. personal_dictionary_key = derive_subkey(root_key, SubkeyRole::PersonalDictKey) (HKDF role 'personal-dictionary-key'); account_number_hash binds via aad_personal_dictionary_blob (AAD role 'personal-dictionary-blob' — a DISTINCT load-bearing string from the HKDF role). 12 cases: 3 encrypt (empty / small descriptor / 1-KB) + 1 decrypt_ok + 2 decrypt_aead_fail (tag-tamper + cross-vault, both non-distinguishing per §6.4, real-key fixtures) + 6 parse_fail (one per distinguishable pre-decryption structural reject incl. the load-bearing format_unsupported forward hook, §9.13.4). Cases generated by `cargo test -p protocol --lib emit_vault_dictionary_vectors_for_paste -- --ignored` (in protocol/src/dictionary_blob.rs).\",\n");
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
                "      \"vector_id\": \"vault-dictionary/v0.1/{}\",\n",
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
                    "      \"informational_personal_dictionary_key_hex\": \"{}\",\n",
                    personal_dictionary_key_hex
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_vault_dictionary_blob_hex\": \"{}\"\n",
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
            "Encode an empty inner plaintext (the empty dictionary — fresh vault, the caller-side fall-to-empty default). The smallest valid MYD1 blob: 34-byte header + 0-byte ciphertext + 32-byte CTX tag = 66 bytes. ciphertext_len field = 32.",
            &plaintext_empty,
            &blob_empty,
            true,
            true,
        );

        emit_encrypt(
            &mut dump,
            "encrypt-small-descriptor",
            "Encode a small opaque word-set descriptor (one personal-words set + one ignore set). The codec is byte-transparent — the illustrative JSON-ish shape is NOT the real desktop serialization (which is postcard {personal_words, ignore_words}). Expected blob = 34-byte header + plaintext + 32-byte CTX tag.",
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
            "      \"vector_id\": \"vault-dictionary/v0.1/decrypt-ok-small-descriptor\",\n",
        );
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the small-descriptor blob back to its opaque plaintext under the matching root_key (→ personal_dictionary_key) + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact inner bytes the desktop layer will deserialize.")
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
                "      \"vector_id\": \"vault-dictionary/v0.1/{}\",\n",
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
            "Take the intact small-descriptor blob but decrypt under a DIFFERENT account_number_hash (0x44×16 instead of 0x33×16). aad_personal_dictionary_blob binds the account hash, so the AAD differs and AEAD verification fails — a blob from vault A cannot be opened against vault B. Collapses to the same CannotDecrypt as the tamper case; ports MUST NOT distinguish the two.",
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
                "      \"vector_id\": \"vault-dictionary/v0.1/{}\",\n",
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
            "First byte of the MYD1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.13.1).",
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
            "dict_format_version byte (offset 5) set to 0x02 — a future word-set serialization a v0.1 client does not understand. The decoder rejects cleanly so the caller falls back to the empty dictionary (§9.13.4). This is the forward-migration hook and is load-bearing (Rust reference: DictionaryBlobError::DictFormatUnsupported).",
            &pf_dict_format,
            "format_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYD1 magic, no room for the 34-byte header. Rejected before any field read.",
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
            "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_DICTIONARY_PLAINTEXT_LEN + 32 (4 MiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing.",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_dictionary_vectors.json", dump.as_bytes())
            .expect("write vault-dictionary vectors dump");
    }
}
