// SPDX-License-Identifier: AGPL-3.0

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
    use crate::test_vector_fmt::{hex_lower, json_escape};

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

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/vault-quickunlock/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_vault_quickunlock_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_quick_unlock_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (MYND-329 / §9.14):
    /// - 2 `encrypt` × {biometric (provider_kind 0x01, all-zero pin_salt) /
    ///   PIN (provider_kind 0x02, real pin_salt)} — pin the `MYQ1` byte output.
    ///   The `wrap_key` is supplied DIRECTLY (provider-agnostic codec — the blob
    ///   never runs Argon2id; the PIN→wrap_key derivation is pinned separately
    ///   in the `argon2id` family). `root_key` (0x33×32) is the wrapped secret.
    /// - 1 `decrypt_ok` (biometric round-trip → the unwrapped `root_key`).
    /// - 3 `decrypt_aead_fail` — (a) CTX-tag tamper, (b) cross-vault wrong
    ///   `account_number_hash`, (c) `provider_kind` flipped 0x01→0x02 on a valid
    ///   biometric blob (AAD-bound, so it AEAD-fails rather than mis-decoding).
    ///   All collapse to `QuickUnlockBlobError::CannotDecrypt` (non-distinguishing,
    ///   §6.4); real-key fixtures make a skipped check observable.
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `ProviderKindUnsupported`,
    ///   `CiphertextLenInvalid`, `HeaderTooShort`, `CiphertextTruncated`).
    ///   There is NO `ciphertext_len_overflow` case: the ciphertext length is
    ///   the fixed constant 64, validated exactly (`CiphertextLenInvalid`).
    ///
    /// `PlaintextLenInvalid` (unreachable for a well-formed 64-byte ciphertext)
    /// and `RandomnessUnavailable` (encode-side) cannot be expressed as a
    /// decode-a-blob case, so they are not vectored (documented in schema.md).
    #[test]
    #[ignore]
    fn emit_quick_unlock_vectors_for_paste() {
        extern crate std;

        // Fixed fixtures — the wrap_key is PRE-DERIVED (the codec is
        // provider-agnostic). Patterns match this test mod's inline fixtures.
        let wrap_key: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
        let account_hash: [u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN] =
            [0x7c; QUICK_UNLOCK_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; QUICK_UNLOCK_ACCOUNT_HASH_LEN] =
            [0x11; QUICK_UNLOCK_ACCOUNT_HASH_LEN];
        let pin_salt: [u8; QUICK_UNLOCK_PIN_SALT_LEN] = [0xab; QUICK_UNLOCK_PIN_SALT_LEN];
        let zero_pin_salt: [u8; QUICK_UNLOCK_PIN_SALT_LEN] = [0u8; QUICK_UNLOCK_PIN_SALT_LEN];
        let root_key: [u8; AEAD_KEY_LEN] = [0x33; AEAD_KEY_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

        let blob_biometric = encode_quick_unlock_blob_raw(
            &wrap_key,
            &account_hash,
            PROVIDER_KIND_BIOMETRIC,
            &zero_pin_salt,
            &root_key,
            &nonce,
        )
        .expect("encode biometric");
        let blob_pin = encode_quick_unlock_blob_raw(
            &wrap_key,
            &account_hash,
            PROVIDER_KIND_PIN,
            &pin_salt,
            &root_key,
            &nonce,
        )
        .expect("encode pin");

        // Round-trip sanity (both providers).
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &blob_biometric)
                .expect("decode biometric")
                .as_slice(),
            &root_key
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &blob_pin)
                .expect("decode pin")
                .as_slice(),
            &root_key
        );

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_biometric.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &blob_tag_tamper),
            Err(QuickUnlockBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): intact blob, wrong account_hash (AAD bind).
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &other_account_hash, &blob_biometric),
            Err(QuickUnlockBlobError::CannotDecrypt),
            "cross-vault account_hash must reject"
        );
        // decrypt_aead_fail (c): valid biometric blob, provider_kind flipped to
        // PIN. provider_kind is AAD-bound, so it AEAD-fails (NOT a structural
        // reject — 0x02 is a registered provider).
        let mut blob_provider_flip = blob_biometric.clone();
        blob_provider_flip[5] = PROVIDER_KIND_PIN;
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &blob_provider_flip),
            Err(QuickUnlockBlobError::CannotDecrypt),
            "provider_kind flip must reject (AAD-bound)"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_biometric.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_biometric.clone();
        pf_version[4] = 0x02;
        let mut pf_provider = blob_biometric.clone();
        pf_provider[5] = 0x09; // not a registered provider
        let mut pf_len_invalid = blob_biometric.clone();
        pf_len_invalid[46..50].copy_from_slice(&65u32.to_be_bytes()); // != 64
        let pf_header_short: alloc::vec::Vec<u8> = QUICK_UNLOCK_BLOB_MAGIC.to_vec(); // 4 < 50
        let mut pf_truncated = blob_biometric.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);

        // Sanity: each corrupted blob hits its intended reject (real key/hash —
        // a port skipping a structural check would surface CannotDecrypt, which
        // the runner catches as a mismatch).
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_magic),
            Err(QuickUnlockBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_version),
            Err(QuickUnlockBlobError::ProtocolVersionMismatch)
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_provider),
            Err(QuickUnlockBlobError::ProviderKindUnsupported)
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_len_invalid),
            Err(QuickUnlockBlobError::CiphertextLenInvalid)
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_header_short),
            Err(QuickUnlockBlobError::HeaderTooShort)
        );
        assert_eq!(
            decode_quick_unlock_blob(&wrap_key, &account_hash, &pf_truncated),
            Err(QuickUnlockBlobError::CiphertextTruncated)
        );

        let wrap_key_hex = hex_lower(&wrap_key);
        let account_hash_hex = hex_lower(&account_hash);
        let other_account_hash_hex = hex_lower(&other_account_hash);
        let pin_salt_hex = hex_lower(&pin_salt);
        let zero_pin_salt_hex = hex_lower(&zero_pin_salt);
        let root_key_hex = hex_lower(&root_key);
        let nonce_hex = hex_lower(&nonce);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-quickunlock\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.14 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_quick_unlock_blob_raw + protocol::decode_quick_unlock_blob byte mapping for the MYQ1 vault.quickunlock device-local credential codec (MYND-329; §9.14). The blob wraps a THIRD copy of root_key (32 bytes) under a provider-supplied wrap_key — the codec is PROVIDER-AGNOSTIC: it never runs Argon2id (the PIN→wrap_key derivation is pinned separately in the argon2id family as input_path 'quickunlock-pin'), so vectors supply wrap_key DIRECTLY as a fixed fixture. provider_kind (0x01 biometric / 0x02 PIN) and account_number_hash both bind via aad_quick_unlock_blob (AAD role 'quick-unlock-blob'); there is NO HKDF SubkeyRole (a root_key-derived KEK would be circular). ciphertext_len is the fixed constant 64 (root_key 32 + CTX tag 32), so there is no size cap / ciphertext_len_overflow case. 12 cases: 2 encrypt (biometric + PIN) + 1 decrypt_ok + 3 decrypt_aead_fail (tag-tamper + cross-vault + provider_kind-flip, all non-distinguishing per §6.4) + 6 parse_fail (one per distinguishable pre-decryption structural reject). Cases generated by `cargo test -p protocol --lib emit_quick_unlock_vectors_for_paste -- --ignored` (in protocol/src/quick_unlock_blob.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // ---- encrypt closure ----------------------------------------
        let emit_encrypt = |dump: &mut alloc::string::String,
                            slug: &str,
                            description: &str,
                            provider_kind: u8,
                            pin_salt_arg_hex: &str,
                            blob: &[u8],
                            trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-quickunlock/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"encrypt\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_wrap_key_hex\": \"{}\",\n",
                wrap_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                account_hash_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_provider_kind\": {},\n",
                provider_kind
            ));
            dump.push_str(&alloc::format!(
                "      \"input_pin_salt_hex\": \"{}\",\n",
                pin_salt_arg_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                root_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_nonce_hex\": \"{}\",\n",
                nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_vault_quickunlock_blob_hex\": \"{}\"\n",
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
            "encrypt-biometric",
            "Encode under the biometric provider (provider_kind=0x01, e.g. macOS Keychain). pin_salt is all-zero (unused by a non-PIN provider but still a header field). The wrap_key is the provider's symmetric secret, supplied directly. Expected blob = 50-byte header + 32-byte root_key ciphertext + 32-byte CTX tag = 114 bytes.",
            PROVIDER_KIND_BIOMETRIC,
            &zero_pin_salt_hex,
            &blob_biometric,
            true,
        );
        emit_encrypt(
            &mut dump,
            "encrypt-pin",
            "Encode under the PIN provider (provider_kind=0x02). pin_salt (0xab×16) is the Argon2id salt the desktop layer used to derive wrap_key from the PIN; it is stored in the public header so the salt can be read back before decode. The wrap_key here is the already-derived 32-byte key (the Argon2id step is pinned separately in the argon2id family). Expected blob = 114 bytes.",
            PROVIDER_KIND_PIN,
            &pin_salt_hex,
            &blob_pin,
            true,
        );

        // ---- decrypt_ok ---------------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-quickunlock/v0.1/decrypt-ok-biometric\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the biometric blob back to the wrapped root_key under the matching wrap_key + account_number_hash. Proves the decoder's header parse + AEAD unwrap reconstruct the exact 32-byte root_key (the third wrapped copy).")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_biometric)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_wrap_key_hex\": \"{}\",\n",
            wrap_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            account_hash_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_root_key_hex\": \"{}\"\n",
            root_key_hex
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
                "      \"vector_id\": \"vault-quickunlock/v0.1/{}\",\n",
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
                "      \"input_wrap_key_hex\": \"{}\",\n",
                wrap_key_hex
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
            "Take the biometric blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt. Same observable outcome as the cross-vault and provider-flip cases (spec §6.4).",
            &blob_tag_tamper,
            &account_hash_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-cross-vault-account-hash",
            "Take the intact biometric blob but decrypt under a DIFFERENT account_number_hash (0x11×16 instead of 0x7c×16). aad_quick_unlock_blob binds the account hash, so the AAD differs and AEAD verification fails — a credential from vault A cannot unwrap vault B's root_key. Collapses to the same CannotDecrypt; ports MUST NOT distinguish.",
            &blob_biometric,
            &other_account_hash_hex,
            "intact blob decrypted under wrong account_number_hash (0x11×16)",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-provider-kind-flip",
            "Take the valid biometric blob (provider_kind=0x01) and flip the provider_kind byte (offset 5) to 0x02 (PIN). Both values are registered, so this passes the structural provider_kind check — but provider_kind is bound into the AAD (§9.14.3), so the AEAD verification fails. This is a decrypt_aead_fail, NOT a parse_fail: it proves a biometric-minted credential cannot be reinterpreted as a PIN credential.",
            &blob_provider_flip,
            &account_hash_hex,
            "provider_kind byte flipped 0x01 (biometric) -> 0x02 (PIN); AAD-bound",
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
                "      \"vector_id\": \"vault-quickunlock/v0.1/{}\",\n",
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
            "First byte of the MYQ1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.14.1).",
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
            "parse-fail-provider-kind-unsupported",
            "provider_kind byte (offset 5) set to 0x09 — not a registered provider (only 0x01 biometric / 0x02 PIN exist). Rejected structurally before decryption. Contrast the provider-kind-flip decrypt_aead_fail case, where the flipped value (0x02) IS registered and so reaches the AAD-bound AEAD stage.",
            &pf_provider,
            "provider_kind_unsupported",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-len-invalid",
            "ciphertext_len field (offset 46..50) set to 65 instead of the fixed 64 (root_key 32 + CTX tag 32). The quick-unlock blob always wraps exactly one root_key, so any other length is rejected before the AEAD stage (there is no variable-size cap here, unlike vault-search/indices).",
            &pf_len_invalid,
            "ciphertext_len_invalid",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYQ1 magic, no room for the 50-byte header. Rejected before any field read.",
            &pf_header_short,
            "header_too_short",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-truncated",
            "Valid header advertising ciphertext_len = 64, but the blob is one byte shorter than header + 64. Rejected before the AEAD stage.",
            &pf_truncated,
            "ciphertext_truncated",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_quickunlock_vectors.json", dump.as_bytes())
            .expect("write vault-quickunlock vectors dump");
    }
}
