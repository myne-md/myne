// SPDX-License-Identifier: AGPL-3.0-or-later

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

use crate::aead::{
    aad_personal_dictionary_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

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
    if plaintext.len() > MAX_DICTIONARY_PLAINTEXT_LEN {
        return Err(DictionaryBlobError::PlaintextTooLarge);
    }

    let aad = aad_personal_dictionary_blob(account_number_hash);
    let sealed = aead_seal_ctx(personal_dictionary_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(DICTIONARY_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&DICTIONARY_BLOB_MAGIC);
    out.push(DICTIONARY_BLOB_PROTOCOL_VERSION);
    out.push(DICTIONARY_BLOB_FORMAT_V1);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.dictionary` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_dictionary_blob_raw`].
pub fn encode_dictionary_blob(
    personal_dictionary_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; DICTIONARY_BLOB_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, DictionaryBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| DictionaryBlobError::RandomnessUnavailable)?;
    let result = encode_dictionary_blob_raw(
        personal_dictionary_key,
        account_number_hash,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
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
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < DICTIONARY_BLOB_HEADER_LEN {
        return Err(DictionaryBlobError::HeaderTooShort);
    }
    if blob[0..4] != DICTIONARY_BLOB_MAGIC {
        return Err(DictionaryBlobError::MagicMismatch);
    }
    if blob[4] != DICTIONARY_BLOB_PROTOCOL_VERSION {
        return Err(DictionaryBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != DICTIONARY_BLOB_FORMAT_V1 {
        return Err(DictionaryBlobError::DictFormatUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > MAX_DICTIONARY_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(DictionaryBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = DICTIONARY_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(DictionaryBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let aad = aad_personal_dictionary_blob(account_number_hash);
    let plaintext = aead_open_ctx(
        personal_dictionary_key,
        &nonce,
        &blob[DICTIONARY_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
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
}
