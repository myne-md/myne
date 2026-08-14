// SPDX-License-Identifier: AGPL-3.0

//! `vault.label` sealed-label-store codec (`MYL1`; `docs/spec/protocol.md`
//! § 9.22).
//!
//! A vault's human-readable **name** lives inside `vault.prefs` (§ 9.5), which
//! is AEAD-sealed under a `root_key`-derived KEK and therefore unreadable at the
//! one moment the vault picker needs it: before any unlock. This family is the
//! device-local cache that closes that gap. One file per vault at the vault root
//! beside `vault.quickunlock`, carrying the label and nothing else, sealed under
//! a **per-vault** 32-byte `wrap_key` held in the OS keychain.
//!
//! It is a sibling of the two device-local queue codecs (`MYK1` § 9.18, `MYF1`
//! § 9.20): same keychain-held `wrap_key`, same **no `SubkeyRole`** posture, same
//! 49-byte header shape. Three things differ, and each one is deliberate.
//!
//! 1. **The key is per vault, not device-global.** The queues mint one key per
//!    device because an entry is enqueued before anyone knows which vault it
//!    lands in. A label belongs to exactly one vault, and vault deletion carries
//!    a per-`VaultId` cryptographic-erase guarantee, so a shared key would leave
//!    a deleted vault's name readable and weaken that guarantee in the most
//!    visible place available. One key per vault means deleting a vault destroys
//!    that vault's key.
//! 2. **The AAD binds the `VaultId` the READER expected**, not merely the one
//!    the blob carries. § 9.18.3 and § 9.20.3 both record a limit they cannot
//!    close: a sealed entry copied to a second filename still opens, because
//!    nothing about it was altered, so agreement is left to a reader-side check.
//!    Here the caller already knows which vault it is reading, so the expected
//!    id goes into the AAD and a file moved between vault directories fails AEAD
//!    rather than needing anyone to remember a comparison.
//! 3. **Strict-trailing is enforced** (§ 10.3.1): the blob's total length must
//!    equal `header + ciphertext_len` exactly. The older families accept a
//!    trailing tail; a new family has no compatibility reason to.
//!
//! There is **no `DeriveSubkey(root_key, …)` role.** A derived subkey cannot be
//! destroyed on its own while its root survives, so it could not deliver the
//! per-vault erase this family exists to make real. The codec is
//! provider-agnostic: it only ever sees a symmetric `wrap_key`.
//!
//! ## On-disk layout (spec § 9.22.1)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  ------------------------------------
//! 0       4     magic             ASCII "MYL1"
//! 4       1     protocol_version  0x01
//! 5       16    vault_id          the UUIDv7 naming `vaults/<id>/`; AAD-bound
//! 21      24    wrap_nonce        XChaCha20-Poly1305 nonce
//! 45      4     ciphertext_len    big-endian uint32, = plaintext_len + 32
//! 49      ..    ciphertext        UTF-8 label AEAD-sealed + 32-byte CTX tag
//! ```
//!
//! Header = 49 bytes. The `vault_id` is already the enclosing directory's name,
//! so carrying it in the header leaks nothing new; what it buys is a structural
//! reject (`VaultIdMismatch`) before any key is touched, which is the honest
//! answer for a file that has been moved.

use crate::aead::{
    aad_vault_label_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0: ASCII `"MYL1"` (Myne vault **L**abel v1). `L` is a
/// free letter in the § 10.3 registry; allocated here the way every family's
/// magic is (implementer-picked from the free pool, as `MYF1`'s own row
/// records). A later letter change would be a mechanical rename.
pub const VAULT_LABEL_BLOB_MAGIC: [u8; 4] = *b"MYL1";

/// `protocol_version` byte at offset 4: `0x01` for v0.1.
pub const VAULT_LABEL_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// Length of the `VaultId` carried in the header and bound into the AAD (a
/// UUIDv7 in its 16 raw bytes, not its 36-char rendering).
pub const VAULT_LABEL_VAULT_ID_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + vault_id 16 + nonce 24 + len 4).
pub const VAULT_LABEL_BLOB_HEADER_LEN: usize = 49;

/// Maximum label plaintext (4 KiB). A vault name is a few words, so this is
/// several orders of magnitude of headroom while still bounding the parser's
/// pre-AEAD allocation. The decoder rejects
/// `ciphertext_len > MAX_VAULT_LABEL_PLAINTEXT_LEN + 32` **before** allocating;
/// the encoder refuses an over-cap label outright rather than truncating it,
/// because a silently shortened name is a wrong name. See spec § 9.22.4.
pub const MAX_VAULT_LABEL_PLAINTEXT_LEN: usize = 4096;

/// Public (pre-decrypt) header field of a sealed label blob. Exposed by
/// [`parse_vault_label_header`] so a caller can read the `vault_id` without a
/// `wrap_key`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultLabelHeader {
    /// The 16-byte `VaultId` naming the vault directory this blob belongs to.
    pub vault_id: [u8; VAULT_LABEL_VAULT_ID_LEN],
}

/// Failure modes of the sealed-label codec. The host collapses every one of
/// them to "this device has no readable name for that vault" and falls back to
/// the neutral label, so the distinctions here serve logging and tests rather
/// than the UI.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum VaultLabelBlobError {
    /// Input shorter than [`VAULT_LABEL_BLOB_HEADER_LEN`] bytes.
    #[error("vault-label blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYL1`.
    #[error("vault-label blob magic mismatch (expected MYL1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("vault-label blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// The header's `vault_id` is not the one the reader asked for: the file
    /// belongs to a different vault (it was copied or moved). Structural, and
    /// raised before any key is touched.
    #[error("vault-label blob belongs to a different vault")]
    VaultIdMismatch,
    /// `ciphertext_len` exceeds [`MAX_VAULT_LABEL_PLAINTEXT_LEN`] + 32, or an
    /// encode was asked to seal a label larger than the cap. The read-side check
    /// runs BEFORE allocation, so a hostile `ciphertext_len = 0xFFFFFFFF` cannot
    /// trigger a huge allocation.
    #[error("vault-label ciphertext_len exceeds 4 KiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("vault-label blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// Blob LONGER than `header + ciphertext_len` (§ 10.3.1 strict-trailing).
    /// The surplus bytes sit outside the AEAD tag and outside the AAD, so
    /// tolerating them would mean carrying unauthenticated bytes through a
    /// successful decode.
    #[error("vault-label blob carries bytes past its declared length")]
    TrailingBytes,
    /// AEAD verification failed (wrong wrap_key, tampered ciphertext/tag/AAD, or
    /// a blob sealed for a different `vault_id`).
    #[error("vault-label AEAD verification failed")]
    CannotDecrypt,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for vault-label nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for VaultLabelBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        VaultLabelBlobError::CannotDecrypt
    }
}

/// Encode a sealed label blob, sealing `plaintext` (the UTF-8 label) under
/// `wrap_key` with `nonce`. `vault_id` is written into the public header AND
/// bound into the AAD.
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source. Nonce reuse under
/// the same `wrap_key` is catastrophic. Production callers SHOULD use
/// [`encode_vault_label_blob`].
pub fn encode_vault_label_blob_raw(
    wrap_key: &[u8; AEAD_KEY_LEN],
    vault_id: &[u8; VAULT_LABEL_VAULT_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, VaultLabelBlobError> {
    if plaintext.len() > MAX_VAULT_LABEL_PLAINTEXT_LEN {
        return Err(VaultLabelBlobError::CiphertextLenOverflow);
    }

    let aad = aad_vault_label_blob(vault_id);
    let sealed = aead_seal_ctx(wrap_key, nonce, plaintext, &aad)?;

    // ciphertext_len in the header = sealed.len() = plaintext.len() + 32.
    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "sealed length is plaintext || CTX tag",
    );

    let mut out = Vec::with_capacity(VAULT_LABEL_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&VAULT_LABEL_BLOB_MAGIC);
    out.push(VAULT_LABEL_BLOB_PROTOCOL_VERSION);
    out.extend_from_slice(vault_id);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a sealed label blob, pulling the 24-byte nonce from the OS CSPRNG.
/// Production callers SHOULD use this rather than the `_raw` variant.
pub fn encode_vault_label_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    vault_id: &[u8; VAULT_LABEL_VAULT_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultLabelBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| VaultLabelBlobError::RandomnessUnavailable)?;
    let result = encode_vault_label_blob_raw(wrap_key, vault_id, plaintext, &nonce);
    nonce.zeroize();
    result
}

/// Parse the **public** header of a sealed label blob WITHOUT a wrap key.
/// Checks magic / protocol_version only, and returns the `vault_id` the blob
/// claims. Magic is the first thing checked, before anything else reads a byte
/// of the blob.
pub fn parse_vault_label_header(blob: &[u8]) -> Result<VaultLabelHeader, VaultLabelBlobError> {
    if blob.len() < VAULT_LABEL_BLOB_HEADER_LEN {
        return Err(VaultLabelBlobError::HeaderTooShort);
    }
    if blob[0..4] != VAULT_LABEL_BLOB_MAGIC {
        return Err(VaultLabelBlobError::MagicMismatch);
    }
    if blob[4] != VAULT_LABEL_BLOB_PROTOCOL_VERSION {
        return Err(VaultLabelBlobError::ProtocolVersionMismatch);
    }
    let mut vault_id = [0u8; VAULT_LABEL_VAULT_ID_LEN];
    vault_id.copy_from_slice(&blob[5..21]);
    Ok(VaultLabelHeader { vault_id })
}

/// Decode a sealed label blob into its UTF-8 label bytes.
///
/// `vault_id` is the vault the CALLER is reading for, and it is the id bound
/// into the AAD. The header's own `vault_id` is compared against it first and a
/// mismatch is [`VaultLabelBlobError::VaultIdMismatch`], so the two can never
/// disagree by the time the AEAD runs. The comparison is the fast, nameable
/// answer and the AAD binding is what makes it structural rather than a check
/// someone has to remember.
///
/// Magic, `protocol_version`, the vault binding, `ciphertext_len` and the
/// strict-trailing equality are ALL checked before any decryption is attempted;
/// AEAD failure collapses to [`VaultLabelBlobError::CannotDecrypt`].
pub fn decode_vault_label_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    vault_id: &[u8; VAULT_LABEL_VAULT_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultLabelBlobError> {
    // ---- parse the 49-byte header (all checks BEFORE decryption) -------
    let header = parse_vault_label_header(blob)?;
    if header.vault_id != *vault_id {
        return Err(VaultLabelBlobError::VaultIdMismatch);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[21..45]);

    let ciphertext_len = u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize;
    // Reject an oversize length BEFORE indexing/allocating (a hostile
    // ciphertext_len = 0xFFFFFFFF must not cause a huge allocation).
    if ciphertext_len > MAX_VAULT_LABEL_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(VaultLabelBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = VAULT_LABEL_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(VaultLabelBlobError::CiphertextTruncated);
    }
    if blob.len() > ciphertext_end {
        return Err(VaultLabelBlobError::TrailingBytes);
    }

    // ---- AEAD-decrypt (the expected vault_id bound into the AAD) -------
    let aad = aad_vault_label_blob(vault_id);
    let plaintext = aead_open_ctx(
        wrap_key,
        &nonce,
        &blob[VAULT_LABEL_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;

    const WRAP_KEY: [u8; AEAD_KEY_LEN] = [0x5a; AEAD_KEY_LEN];
    const OTHER_WRAP_KEY: [u8; AEAD_KEY_LEN] = [0xa5; AEAD_KEY_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x11; AEAD_NONCE_LEN];
    /// Two distinct `VaultId` byte forms. UUIDv7-shaped (version nibble 7,
    /// variant bits `10`) so they are the same shape the host actually writes.
    const VAULT_A: [u8; VAULT_LABEL_VAULT_ID_LEN] = [
        0x01, 0x97, 0xc0, 0xde, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x0a,
    ];
    const VAULT_B: [u8; VAULT_LABEL_VAULT_ID_LEN] = [
        0x01, 0x97, 0xc0, 0xde, 0x00, 0x00, 0x70, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x0b,
    ];

    fn seal(vault_id: &[u8; VAULT_LABEL_VAULT_ID_LEN], label: &str) -> Vec<u8> {
        encode_vault_label_blob_raw(&WRAP_KEY, vault_id, label.as_bytes(), &NONCE)
            .expect("seal a label")
    }

    #[test]
    fn round_trips_a_label() {
        let blob = seal(&VAULT_A, "Work");
        let out = decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob).expect("decode");
        assert_eq!(out.as_slice(), b"Work");
    }

    #[test]
    fn round_trips_a_multibyte_label() {
        // A vault name is user-authored text, so it is not ASCII by assumption.
        let label = "Günlük 日記 🗂";
        let blob = seal(&VAULT_A, label);
        let out = decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob).expect("decode");
        assert_eq!(out.as_slice(), label.as_bytes());
    }

    #[test]
    fn header_layout_is_the_documented_49_bytes() {
        let blob = seal(&VAULT_A, "Work");
        assert_eq!(&blob[0..4], b"MYL1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(&blob[5..21], &VAULT_A);
        assert_eq!(&blob[21..45], &NONCE);
        assert_eq!(
            u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize,
            "Work".len() + CTX_COMMITMENT_TAG_LEN
        );
        assert_eq!(
            blob.len(),
            VAULT_LABEL_BLOB_HEADER_LEN + "Work".len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    #[test]
    fn parses_the_public_header_without_a_key() {
        let blob = seal(&VAULT_A, "Work");
        let header = parse_vault_label_header(&blob).expect("parse header");
        assert_eq!(header.vault_id, VAULT_A);
    }

    // ---- magic is checked BEFORE decryption ---------------------------
    //
    // The ordering is the point, and asserting it needs a blob that would fail
    // BOTH checks: corrupt the magic and the ciphertext together. A decoder that
    // decrypted first would answer `CannotDecrypt`; only one that checks magic
    // first can answer `MagicMismatch`.

    #[test]
    fn corrupt_magic_is_rejected_before_any_decryption_is_attempted() {
        let mut blob = seal(&VAULT_A, "Work");
        blob[0] = b'X';
        // Also destroy the ciphertext, so a decrypt-first decoder has an answer
        // available and would give it.
        let last = blob.len() - 1;
        blob[last] ^= 0xff;

        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::MagicMismatch),
            "magic must be checked before the AEAD, not after"
        );
    }

    #[test]
    fn corrupt_magic_outranks_a_wrong_wrap_key_too() {
        // The other half of the same ordering claim: with no usable key at all,
        // the answer is still the structural one.
        let mut blob = seal(&VAULT_A, "Work");
        blob[3] = b'9';
        assert_eq!(
            decode_vault_label_blob(&OTHER_WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::MagicMismatch)
        );
    }

    #[test]
    fn a_foreign_magic_never_reaches_the_codec_body() {
        // The `MYQ1` neighbour at the same vault root, handed to the wrong
        // reader: rejected on magic, with a real key, before anything else.
        let mut blob = seal(&VAULT_A, "Work");
        blob[0..4].copy_from_slice(b"MYQ1");
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::MagicMismatch)
        );
    }

    // ---- the AAD binds the VaultId ------------------------------------

    #[test]
    fn vault_as_blob_does_not_validate_for_vault_b() {
        // The cross-vault case as it actually occurs on disk: A's file turns up
        // where B's should be. Same wrap_key on purpose, because a per-vault key would
        // reject this on its own, and this test is about the binding, not the
        // key.
        let blob = seal(&VAULT_A, "Work");
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_B, &blob),
            Err(VaultLabelBlobError::VaultIdMismatch)
        );
    }

    #[test]
    fn relabelling_the_header_to_vault_b_fails_the_aead_rather_than_opening() {
        // And the binding is what refuses, not the byte comparison: patch the
        // header so it CLAIMS vault B, then read as vault B with a key that
        // works. The structural check now passes, and the AEAD does not: the
        // sealed bytes committed to A.
        let mut blob = seal(&VAULT_A, "Work");
        blob[5..21].copy_from_slice(&VAULT_B);
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_B, &blob),
            Err(VaultLabelBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn the_two_vault_ids_produce_different_ciphertext_under_one_key_and_nonce() {
        // The AAD is the only input that differs, so the tags must differ.
        let a = seal(&VAULT_A, "Work");
        let b = seal(&VAULT_B, "Work");
        assert_ne!(
            a[VAULT_LABEL_BLOB_HEADER_LEN..],
            b[VAULT_LABEL_BLOB_HEADER_LEN..]
        );
    }

    // ---- the rest of the reject surface -------------------------------

    #[test]
    fn a_wrong_wrap_key_cannot_decrypt() {
        let blob = seal(&VAULT_A, "Work");
        assert_eq!(
            decode_vault_label_blob(&OTHER_WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn a_short_input_is_a_header_too_short() {
        let blob = seal(&VAULT_A, "Work");
        assert_eq!(
            decode_vault_label_blob(
                &WRAP_KEY,
                &VAULT_A,
                &blob[..VAULT_LABEL_BLOB_HEADER_LEN - 1]
            ),
            Err(VaultLabelBlobError::HeaderTooShort)
        );
        assert_eq!(
            parse_vault_label_header(&[]),
            Err(VaultLabelBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn a_wrong_protocol_version_is_rejected() {
        let mut blob = seal(&VAULT_A, "Work");
        blob[4] = 0x02;
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn a_hostile_ciphertext_len_is_rejected_before_it_can_allocate() {
        let mut blob = seal(&VAULT_A, "Work");
        blob[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn a_truncated_blob_is_rejected() {
        let blob = seal(&VAULT_A, "Work");
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob[..blob.len() - 1]),
            Err(VaultLabelBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn trailing_bytes_are_rejected_rather_than_ignored() {
        // Strict-trailing, § 10.3.1: the surplus is outside the AEAD tag and
        // outside the AAD, so a decode that succeeded would be handing the
        // caller a blob carrying unauthenticated bytes.
        let mut blob = seal(&VAULT_A, "Work");
        blob.push(0x00);
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob),
            Err(VaultLabelBlobError::TrailingBytes)
        );
    }

    #[test]
    fn a_label_over_the_cap_is_refused_rather_than_truncated() {
        let too_long = [b'x'; MAX_VAULT_LABEL_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, &too_long, &NONCE),
            Err(VaultLabelBlobError::CiphertextLenOverflow)
        );
        // And exactly at the cap still seals.
        let at_cap = [b'x'; MAX_VAULT_LABEL_PLAINTEXT_LEN];
        let blob =
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, &at_cap, &NONCE).expect("at-cap seal");
        let out = decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob).expect("decode at cap");
        assert_eq!(out.len(), MAX_VAULT_LABEL_PLAINTEXT_LEN);
    }

    #[test]
    fn the_csprng_wrapper_round_trips_and_varies_the_nonce() {
        let one = encode_vault_label_blob(&WRAP_KEY, &VAULT_A, b"Work").expect("seal one");
        let two = encode_vault_label_blob(&WRAP_KEY, &VAULT_A, b"Work").expect("seal two");
        assert_ne!(one[21..45], two[21..45], "a fresh nonce per seal");
        let out = decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &one).expect("decode");
        assert_eq!(out.as_slice(), b"Work");
    }

    #[test]
    fn the_magic_is_the_allocated_one() {
        // A blob-family magic is a major-version-event constant (root
        // `CLAUDE.md`). Pin the bytes so a rename has to argue with a test.
        assert_eq!(VAULT_LABEL_BLOB_MAGIC, *b"MYL1");
        assert_eq!(VAULT_LABEL_BLOB_PROTOCOL_VERSION, 0x01);
        assert_eq!(VAULT_LABEL_BLOB_HEADER_LEN, 49);
    }
}
