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
}
