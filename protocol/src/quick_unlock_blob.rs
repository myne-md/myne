// SPDX-License-Identifier: AGPL-3.0-or-later

//! `vault.quickunlock` 50-byte-header encrypted quick-unlock credential codec
//! (MYND-329; `docs/spec/protocol.md` § 9.14).
//!
//! `vault.quickunlock` is a **device-local credential** holding a **third
//! wrapped copy of `root_key`** — the realization of the § 3.1 forward-look
//! ("a third encrypted copy of `root_key` under a third wrap key, with no
//! change to the rest of the protocol"). It lets a re-lock (auto-lock-on-idle)
//! be reversed with a fast second credential (Touch ID / Windows Hello / a PIN)
//! instead of the full master-password Argon2id path, **without touching the
//! cryptographic root**: the blob wraps the already-derived `root_key`; it
//! never participates in `root_key` derivation.
//!
//! Unlike every other § 9 blob, the wrap key is **NOT** a
//! `DeriveSubkey(root_key, …)` subkey — that would be circular, since the blob
//! *is* what protects `root_key`. The 32-byte `wrap_key` is supplied by an
//! external [wrap-key provider](../../docs/spec/protocol.md) (macOS Keychain
//! biometric secret, or a PIN run through the vault's Argon2id parameters); the
//! codec is **provider-agnostic** — it only ever sees a symmetric `wrap_key`.
//!
//! ## On-disk layout (spec § 9.14.1)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  ------------------------------------
//! 0       4     magic             ASCII "MYQ1"
//! 4       1     protocol_version  0x01
//! 5       1     provider_kind     0x01 = macOS-biometric, 0x02 = PIN
//! 6       16    pin_salt          Argon2id salt for the PIN provider;
//!                                  all-zero when provider_kind != PIN
//! 22      24    wrap_nonce        XChaCha20-Poly1305 nonce
//! 46      4     ciphertext_len    big-endian uint32, always 64 (32 + 32)
//! 50      64    ciphertext        root_key (32) AEAD-sealed + 32-byte CTX tag
//! ```
//!
//! Total = 114 bytes. No public `account_number_hash` byte — it binds via the
//! AAD (§ 9.14.3) without consuming header bytes, exactly like
//! `vault.prefs` / `vault.dictionary`. `provider_kind` is ALSO bound into the
//! AAD so a biometric-minted blob cannot be reinterpreted as a PIN blob.
//!
//! ## PIN provider chicken-and-egg
//!
//! For the PIN provider, the caller needs `pin_salt` to derive `wrap_key`
//! before it can call [`decode_quick_unlock_blob`]. [`parse_quick_unlock_header`]
//! exposes the **public** header fields (`provider_kind`, `pin_salt`) WITHOUT a
//! key, so the desktop layer can peek the salt, derive `wrap_key`, then decode.

use crate::aead::{
    aad_quick_unlock_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYQ1"` (Myne Quick-unlock v1).
pub const QUICK_UNLOCK_BLOB_MAGIC: [u8; 4] = *b"MYQ1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const QUICK_UNLOCK_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `provider_kind` value for the macOS-biometric (Keychain) wrap-key provider.
pub const PROVIDER_KIND_BIOMETRIC: u8 = 0x01;

/// `provider_kind` value for the PIN (Argon2id) wrap-key provider.
pub const PROVIDER_KIND_PIN: u8 = 0x02;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const QUICK_UNLOCK_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the `pin_salt` header field (16 bytes).
pub const QUICK_UNLOCK_PIN_SALT_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + provider 1 + pin_salt 16 +
/// nonce 24 + len 4).
pub const QUICK_UNLOCK_BLOB_HEADER_LEN: usize = 50;

/// The fixed inner ciphertext length: a 32-byte `root_key` plaintext plus the
/// 32-byte CTX commitment tag. The quick-unlock blob always wraps exactly one
/// `root_key`, so this is constant (unlike the variable-payload prefs/dict).
pub const QUICK_UNLOCK_CIPHERTEXT_LEN: usize = AEAD_KEY_LEN + CTX_COMMITMENT_TAG_LEN;

/// Public (pre-decrypt) header fields of a `vault.quickunlock` blob. Exposed by
/// [`parse_quick_unlock_header`] so the PIN provider can read `pin_salt` to
/// derive its `wrap_key` before decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickUnlockHeader {
    /// `0x01` = macOS-biometric, `0x02` = PIN.
    pub provider_kind: u8,
    /// Argon2id salt for the PIN provider; all-zero for biometric.
    pub pin_salt: [u8; QUICK_UNLOCK_PIN_SALT_LEN],
}

/// Failure modes of the `vault.quickunlock` codec. The desktop caller collapses
/// a decode failure to "quick-unlock unavailable → fall back to full password".
#[derive(Debug, Error, PartialEq, Eq)]
pub enum QuickUnlockBlobError {
    /// Input shorter than [`QUICK_UNLOCK_BLOB_HEADER_LEN`] bytes.
    #[error("vault.quickunlock blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYQ1`.
    #[error("vault.quickunlock blob magic mismatch (expected MYQ1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("vault.quickunlock blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `provider_kind` is not a registered provider (0x01 / 0x02).
    #[error("vault.quickunlock blob provider_kind unsupported")]
    ProviderKindUnsupported,
    /// `ciphertext_len` is not exactly [`QUICK_UNLOCK_CIPHERTEXT_LEN`].
    #[error("vault.quickunlock ciphertext_len invalid (must wrap exactly one root_key)")]
    CiphertextLenInvalid,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("vault.quickunlock blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong wrap_key, tampered ciphertext/tag/AAD,
    /// or wrong vault / provider_kind binding).
    #[error("vault.quickunlock AEAD verification failed")]
    CannotDecrypt,
    /// Decrypted plaintext was not exactly 32 bytes (a `root_key`). Defensive —
    /// a well-formed blob always carries a 32-byte plaintext.
    #[error("vault.quickunlock decrypted plaintext is not a 32-byte root_key")]
    PlaintextLenInvalid,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault.quickunlock nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for QuickUnlockBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        QuickUnlockBlobError::CannotDecrypt
    }
}

#[inline]
fn provider_kind_is_known(provider_kind: u8) -> bool {
    provider_kind == PROVIDER_KIND_BIOMETRIC || provider_kind == PROVIDER_KIND_PIN
}

/// Encode a `vault.quickunlock` blob, sealing `root_key` under `wrap_key` with
/// `nonce`. `provider_kind` and `pin_salt` are written into the public header
/// (and `provider_kind` is bound into the AAD).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse under
/// the same `wrap_key` is catastrophic. Production callers SHOULD use
/// [`encode_quick_unlock_blob`].
pub fn encode_quick_unlock_blob_raw(
    wrap_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN],
    provider_kind: u8,
    pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    root_key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, QuickUnlockBlobError> {
    if !provider_kind_is_known(provider_kind) {
        return Err(QuickUnlockBlobError::ProviderKindUnsupported);
    }

    let aad = aad_quick_unlock_blob(account_number_hash, provider_kind);
    let sealed = aead_seal_ctx(wrap_key, nonce, root_key, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len, QUICK_UNLOCK_CIPHERTEXT_LEN,
        "quick-unlock ciphertext is always root_key (32) || CTX tag (32)",
    );

    let mut out = Vec::with_capacity(QUICK_UNLOCK_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&QUICK_UNLOCK_BLOB_MAGIC);
    out.push(QUICK_UNLOCK_BLOB_PROTOCOL_VERSION);
    out.push(provider_kind);
    out.extend_from_slice(pin_salt);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.quickunlock` blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than the `_raw` variant.
pub fn encode_quick_unlock_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN],
    provider_kind: u8,
    pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    root_key: &[u8; AEAD_KEY_LEN],
) -> Result<Vec<u8>, QuickUnlockBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| QuickUnlockBlobError::RandomnessUnavailable)?;
    let result = encode_quick_unlock_blob_raw(
        wrap_key,
        account_number_hash,
        provider_kind,
        pin_salt,
        root_key,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Parse the **public** header fields (`provider_kind`, `pin_salt`) of a
/// `vault.quickunlock` blob WITHOUT a wrap key. Checks magic / protocol_version
/// / provider_kind only — the caller (PIN provider) uses `pin_salt` to derive
/// `wrap_key` before calling [`decode_quick_unlock_blob`].
pub fn parse_quick_unlock_header(blob: &[u8]) -> Result<QuickUnlockHeader, QuickUnlockBlobError> {
    if blob.len() < QUICK_UNLOCK_BLOB_HEADER_LEN {
        return Err(QuickUnlockBlobError::HeaderTooShort);
    }
    if blob[0..4] != QUICK_UNLOCK_BLOB_MAGIC {
        return Err(QuickUnlockBlobError::MagicMismatch);
    }
    if blob[4] != QUICK_UNLOCK_BLOB_PROTOCOL_VERSION {
        return Err(QuickUnlockBlobError::ProtocolVersionMismatch);
    }
    let provider_kind = blob[5];
    if !provider_kind_is_known(provider_kind) {
        return Err(QuickUnlockBlobError::ProviderKindUnsupported);
    }
    let mut pin_salt = [0u8; QUICK_UNLOCK_PIN_SALT_LEN];
    pin_salt.copy_from_slice(&blob[6..22]);
    Ok(QuickUnlockHeader {
        provider_kind,
        pin_salt,
    })
}

/// Decode a `vault.quickunlock` blob into the unwrapped `root_key`. Magic /
/// protocol_version / provider_kind / ciphertext_len are all checked BEFORE any
/// decryption; AEAD failure collapses to [`QuickUnlockBlobError::CannotDecrypt`].
pub fn decode_quick_unlock_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, QuickUnlockBlobError> {
    // ---- parse the 50-byte header (all checks BEFORE decryption) -------
    let header = parse_quick_unlock_header(blob)?;

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[22..46]);

    let ciphertext_len = u32::from_be_bytes([blob[46], blob[47], blob[48], blob[49]]) as usize;
    if ciphertext_len != QUICK_UNLOCK_CIPHERTEXT_LEN {
        return Err(QuickUnlockBlobError::CiphertextLenInvalid);
    }
    let ciphertext_end = QUICK_UNLOCK_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(QuickUnlockBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt (provider_kind bound into the AAD) ---------------
    let aad = aad_quick_unlock_blob(account_number_hash, header.provider_kind);
    let plaintext = aead_open_ctx(
        wrap_key,
        &nonce,
        &blob[QUICK_UNLOCK_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;

    if plaintext.len() != AEAD_KEY_LEN {
        return Err(QuickUnlockBlobError::PlaintextLenInvalid);
    }
    let mut root_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    root_key.copy_from_slice(&plaintext);
    Ok(root_key)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const WRAP_KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN] = [0x7c; QUICK_UNLOCK_ACCOUNT_HASH_LEN];
    const PIN_SALT: [u8; QUICK_UNLOCK_PIN_SALT_LEN] = [0xab; QUICK_UNLOCK_PIN_SALT_LEN];
    const ROOT_KEY: [u8; AEAD_KEY_LEN] = [0x33; AEAD_KEY_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(provider_kind: u8, pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN]) -> Vec<u8> {
        encode_quick_unlock_blob_raw(
            &WRAP_KEY,
            &ACCOUNT_HASH,
            provider_kind,
            pin_salt,
            &ROOT_KEY,
            &NONCE,
        )
        .expect("encode")
    }

    #[test]
    fn round_trips_root_key_biometric() {
        let blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        let root_key = decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(root_key.as_slice(), &ROOT_KEY);
    }

    #[test]
    fn round_trips_root_key_pin_with_salt() {
        let blob = encode(PROVIDER_KIND_PIN, &PIN_SALT);
        let root_key = decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(root_key.as_slice(), &ROOT_KEY);
    }

    #[test]
    fn header_layout_is_magic_version_provider_salt_nonce_len() {
        let blob = encode(PROVIDER_KIND_PIN, &PIN_SALT);
        assert_eq!(&blob[0..4], b"MYQ1");
        assert_eq!(blob[4], QUICK_UNLOCK_BLOB_PROTOCOL_VERSION);
        assert_eq!(blob[5], PROVIDER_KIND_PIN);
        assert_eq!(&blob[6..22], &PIN_SALT);
        assert_eq!(&blob[22..46], &NONCE);
        // ciphertext_len = root_key (32) + CTX tag (32) = 64.
        assert_eq!(
            u32::from_be_bytes([blob[46], blob[47], blob[48], blob[49]]),
            64
        );
        assert_eq!(blob.len(), QUICK_UNLOCK_BLOB_HEADER_LEN + 64);
    }

    #[test]
    fn parse_header_exposes_provider_and_salt_without_key() {
        let blob = encode(PROVIDER_KIND_PIN, &PIN_SALT);
        let header = parse_quick_unlock_header(&blob).expect("header");
        assert_eq!(header.provider_kind, PROVIDER_KIND_PIN);
        assert_eq!(&header.pin_salt, &PIN_SALT);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        blob[0] = b'X';
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::MagicMismatch)
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        blob[4] = 0x02;
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn unknown_provider_kind_rejects() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        blob[5] = 0x09; // not a registered provider
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::ProviderKindUnsupported)
        );
        assert_eq!(
            parse_quick_unlock_header(&blob),
            Err(QuickUnlockBlobError::ProviderKindUnsupported)
        );
    }

    #[test]
    fn encode_rejects_unknown_provider_kind() {
        assert_eq!(
            encode_quick_unlock_blob_raw(
                &WRAP_KEY,
                &ACCOUNT_HASH,
                0x09,
                &PIN_SALT,
                &ROOT_KEY,
                &NONCE,
            ),
            Err(QuickUnlockBlobError::ProviderKindUnsupported)
        );
    }

    #[test]
    fn provider_kind_is_aad_bound_cannot_be_flipped() {
        // A biometric blob whose provider_kind byte is flipped to PIN fails
        // AEAD — provider_kind is bound into the AAD (§ 9.14.3).
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        blob[5] = PROVIDER_KIND_PIN;
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_account_hash_fails_aead_cross_vault() {
        let blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        let other_hash = [0x11; QUICK_UNLOCK_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &other_hash, &blob),
            Err(QuickUnlockBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_wrap_key_fails_aead() {
        let blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        let other_key = [0x01; AEAD_KEY_LEN];
        assert_eq!(
            decode_quick_unlock_blob(&other_key, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short_rejects() {
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, b"MYQ1"),
            Err(QuickUnlockBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn truncated_ciphertext_rejects() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn ciphertext_len_must_be_exactly_64() {
        let mut blob = encode(PROVIDER_KIND_BIOMETRIC, &[0u8; QUICK_UNLOCK_PIN_SALT_LEN]);
        // Set ciphertext_len to a different value (e.g. 65).
        blob[46..50].copy_from_slice(&65u32.to_be_bytes());
        assert_eq!(
            decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob),
            Err(QuickUnlockBlobError::CiphertextLenInvalid)
        );
    }

    #[test]
    fn convenience_encode_round_trips_via_getrandom() {
        let blob = encode_quick_unlock_blob(
            &WRAP_KEY,
            &ACCOUNT_HASH,
            PROVIDER_KIND_BIOMETRIC,
            &[0u8; QUICK_UNLOCK_PIN_SALT_LEN],
            &ROOT_KEY,
        )
        .expect("encode");
        let root_key = decode_quick_unlock_blob(&WRAP_KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(root_key.as_slice(), &ROOT_KEY);
    }
}
