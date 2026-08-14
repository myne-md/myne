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
    use crate::test_vector_fmt::{hex_lower, json_escape};

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

    // ---- cross-implementation vector generator ------------------------

    /// The nonce the **vectors** use — a counting pattern rather than the
    /// `0x11` fill the unit tests above use, so a fixture read by eye shows its
    /// own offsets. Any constant would do: a vector run is deterministic, and
    /// production pulls this from the CSPRNG via [`encode_vault_label_blob`].
    const VECTOR_NONCE: [u8; AEAD_NONCE_LEN] = [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
    ];

    /// Emit the `vault-label` v0.1 cross-implementation vectors, for paste into
    /// `myne-test-vectors/vectors/vault-label/v0.1/cases.json`.
    ///
    /// `cargo test -p protocol --lib emit_vault_label_blob_vectors_for_paste -- --ignored`
    ///
    /// 18 cases pin § 9.22, and the shape is the `MYF1` / `MYK1` device-local
    /// one plus the two things this family does that they cannot:
    /// - 1 `aad_construction` — the 45 canonical `aad_vault_label_blob` bytes.
    ///   The device-local, vault-agnostic builders are deliberately outside the
    ///   vault-scoped `ctx-aead` / `aad-construction` enumeration families, so
    ///   this one is pinned inside its own family, exactly as `MYK1` and `MYF1`
    ///   pin theirs.
    /// - 3 `encrypt` — short ASCII, a multibyte label (2-, 3- and 4-byte UTF-8
    ///   sequences, so a port measuring characters rather than bytes fails), and
    ///   one at exactly the 4096-byte cap.
    /// - 1 `encode_fail` — 4097 bytes, one over the cap. Paired with the at-cap
    ///   `encrypt` case, this is what pins the boundary as inclusive: a port
    ///   writing `>=` where the spec says `>` fails one of the two.
    /// - 2 `decrypt_ok` — ASCII + multibyte (the latter catches a decoder that
    ///   re-encodes or lossily converts on read).
    /// - 3 `decrypt_aead_fail` — CTX-tag tamper, the relabelled header, a wrong
    ///   `wrap_key`; all collapse to `CannotDecrypt` (§ 6.4).
    /// - 8 `parse_fail` — one per distinguishable decode variant, with
    ///   `magic_mismatch` twice (the ordering case and the `MYQ1` neighbour).
    ///
    /// **Every `parse_fail` fixture carries the REAL `wrap_key`.** None of the
    /// corrupted header fields is AAD-bound, so a port that skips one of these
    /// checks decodes the fixture *successfully* — which the runner catches. A
    /// dummy key would mask that bug behind a coincidental AEAD failure.
    ///
    /// `RandomnessUnavailable` is raised by the non-`_raw` wrapper when the OS
    /// CSPRNG fails and cannot be expressed as a fixture, so it is not vectored.
    #[test]
    #[ignore]
    fn emit_vault_label_blob_vectors_for_paste() {
        extern crate std;

        let ascii_label: &[u8] = b"Work";
        let multibyte_label_str = "Günlük 日記 🗂";
        let multibyte_label: &[u8] = multibyte_label_str.as_bytes();
        let at_cap_label = [b'x'; MAX_VAULT_LABEL_PLAINTEXT_LEN];
        let over_cap_label = [b'x'; MAX_VAULT_LABEL_PLAINTEXT_LEN + 1];

        let blob_ascii =
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, ascii_label, &VECTOR_NONCE)
                .expect("seal the ASCII label");
        let blob_multibyte =
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, multibyte_label, &VECTOR_NONCE)
                .expect("seal the multibyte label");
        let blob_at_cap =
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, &at_cap_label, &VECTOR_NONCE)
                .expect("seal the at-cap label");

        // Round-trip sanity: the encrypt cases and the decrypt_ok cases are the
        // same bytes read in both directions, so mint them together.
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob_ascii)
                .expect("decode ASCII")
                .as_slice(),
            ascii_label
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob_multibyte)
                .expect("decode multibyte")
                .as_slice(),
            multibyte_label
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob_at_cap)
                .expect("decode at-cap")
                .len(),
            MAX_VAULT_LABEL_PLAINTEXT_LEN
        );
        assert_eq!(
            encode_vault_label_blob_raw(&WRAP_KEY, &VAULT_A, &over_cap_label, &VECTOR_NONCE),
            Err(VaultLabelBlobError::CiphertextLenOverflow),
            "an over-cap label must be refused rather than truncated"
        );

        // ---- decrypt_aead_fail fixtures -----------------------------
        let mut blob_tag_tamper = blob_ascii.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xff;
        let mut blob_relabelled = blob_ascii.clone();
        blob_relabelled[5..21].copy_from_slice(&VAULT_B);

        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &blob_tag_tamper),
            Err(VaultLabelBlobError::CannotDecrypt)
        );
        // Read as B: the header now agrees with the expectation, so the
        // structural comparison passes and only the AAD is left to refuse.
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_B, &blob_relabelled),
            Err(VaultLabelBlobError::CannotDecrypt)
        );
        assert_eq!(
            decode_vault_label_blob(&OTHER_WRAP_KEY, &VAULT_A, &blob_ascii),
            Err(VaultLabelBlobError::CannotDecrypt)
        );

        // ---- parse_fail fixtures ------------------------------------
        // Magic corrupted AND the tag destroyed, together: a decoder that
        // decrypts first has a cannot-decrypt answer available and will give
        // it, so only one that checks the magic first can answer
        // `magic_mismatch`.
        let mut pf_magic_before_decrypt = blob_ascii.clone();
        pf_magic_before_decrypt[0] = b'X';
        let pf_last = pf_magic_before_decrypt.len() - 1;
        pf_magic_before_decrypt[pf_last] ^= 0xff;
        // The `MYQ1` neighbour that literally sits beside `vault.label`.
        let mut pf_foreign_magic = blob_ascii.clone();
        pf_foreign_magic[0..4].copy_from_slice(b"MYQ1");
        let mut pf_version = blob_ascii.clone();
        pf_version[4] = 0x02;
        let mut pf_len_overflow = blob_ascii.clone();
        pf_len_overflow[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
        let pf_header_short: Vec<u8> = VAULT_LABEL_BLOB_MAGIC.to_vec(); // 4 < 49
        let mut pf_truncated = blob_ascii.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_trailing = blob_ascii.clone();
        pf_trailing.push(0x00);

        // Each fixture hits its intended reject WITH THE REAL KEY — a port that
        // skipped the check would decode `Ok`, which is what the runner sees.
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_magic_before_decrypt),
            Err(VaultLabelBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_foreign_magic),
            Err(VaultLabelBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_version),
            Err(VaultLabelBlobError::ProtocolVersionMismatch)
        );
        // Untouched blob, read as B: the structural half of the cross-vault
        // pin, and it MUST differ from the relabelled case above.
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_B, &blob_ascii),
            Err(VaultLabelBlobError::VaultIdMismatch)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_len_overflow),
            Err(VaultLabelBlobError::CiphertextLenOverflow)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_header_short),
            Err(VaultLabelBlobError::HeaderTooShort)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_truncated),
            Err(VaultLabelBlobError::CiphertextTruncated)
        );
        assert_eq!(
            decode_vault_label_blob(&WRAP_KEY, &VAULT_A, &pf_trailing),
            Err(VaultLabelBlobError::TrailingBytes)
        );

        let wrap_key_hex = hex_lower(&WRAP_KEY);
        let other_wrap_key_hex = hex_lower(&OTHER_WRAP_KEY);
        let vault_a_hex = hex_lower(&VAULT_A);
        let vault_b_hex = hex_lower(&VAULT_B);
        let nonce_hex = hex_lower(&VECTOR_NONCE);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-label\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.22 + §5.2 + §6.4 + §10.3.1\",\n");
        dump.push_str(&alloc::format!(
            "  \"description\": \"{}\",\n",
            json_escape(
                "Pins protocol::vault_label_blob::{encode_vault_label_blob_raw, decode_vault_label_blob} byte mapping for the MYL1 sealed label store (vault.label, §9.22, myne-md/myne#411). One file per vault at the vault root, carrying that vault's human-readable name and nothing else, so the picker can show it BEFORE any unlock (the authoritative label lives in vault.prefs, which is sealed under a root_key-derived KEK and therefore unreadable at that moment). Device-local: never synced, never backed up. Sealed under a PER-VAULT 32-byte wrap_key held in the OS keychain (service md.myne.vaultlabel), NOT a DeriveSubkey(root_key, ...) subkey, so there is NO HKDF SubkeyRole and the vectors supply wrap_key directly. Per-vault rather than device-global because vault deletion carries a per-VaultId cryptographic-erase guarantee: one key per vault is what lets deleting a vault destroy exactly one name. Unlike its device-local siblings MYK1 (§9.18) and MYF1 (§9.20) this family is NOT vault-agnostic: aad_vault_label_blob binds the 16-byte VaultId the READER EXPECTED, not merely the one the blob carries, which closes structurally the copied-to-another-name gap those two leave to a reader-side check. ciphertext_len is variable (plaintext_len + 32) with a 4 KiB plaintext cap (§9.22.4), enforced on both sides: an oversize ciphertext_len is rejected before allocation, and an over-cap label is refused at write time rather than truncated. §10.3.1 strict-trailing is ENFORCED (blob length must equal header + ciphertext_len exactly), unlike the older device-local families. 18 cases: 1 aad_construction + 3 encrypt (ascii, multibyte, at the 4096-byte cap) + 1 encode_fail (one byte over the cap) + 2 decrypt_ok (ascii, multibyte) + 3 decrypt_aead_fail (tag-tamper, relabelled header vault_id, wrong wrap_key, all non-distinguishing per §6.4) + 8 parse_fail (one per distinguishable pre-decryption structural reject). Every parse_fail fixture carries the REAL wrap_key, so a port that skips a structural check decodes Ok and the runner catches it rather than the bug hiding behind a coincidental AEAD failure."
            )
        ));
        dump.push_str("  \"cases\": [\n");

        // ---- aad_construction ---------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-label/v0.1/aad-vault-label-blob\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("AAD_vault_label_blob canonical bytes for a vault id, per spec 9.22.3: the 10-byte AAD prefix 'myne.v0.1|', the protocol_version byte 0x01, the length-prefixed role u16_be(16) || 'vault-label-blob', then the 16-byte vault_id. 45 bytes total. Pinned explicitly because a port that assembles these bytes in any other order still produces a well-formed blob whose tag simply never verifies anywhere else, which is a much harder failure to read than a byte diff on this string.")
        ));
        dump.push_str("      \"case_kind\": \"aad_construction\",\n");
        dump.push_str("      \"input_aad_builder\": \"aad_vault_label_blob\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_vault_id_hex\": \"{}\",\n",
            vault_a_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad_vault_label_blob(&VAULT_A))
        ));
        dump.push_str("    },\n");

        // ---- encrypt closure ----------------------------------------
        let emit_encrypt = |dump: &mut alloc::string::String,
                            slug: &str,
                            description: &str,
                            label: &[u8],
                            blob: &[u8],
                            informational_label: Option<&str>| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-label/v0.1/{}\",\n",
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
                "      \"input_vault_id_hex\": \"{}\",\n",
                vault_a_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_label_utf8_hex\": \"{}\",\n",
                hex_lower(label)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_nonce_hex\": \"{}\",\n",
                nonce_hex
            ));
            match informational_label {
                Some(text) => {
                    dump.push_str(&alloc::format!(
                        "      \"expected_vault_label_blob_hex\": \"{}\",\n",
                        hex_lower(blob)
                    ));
                    dump.push_str(&alloc::format!(
                        "      \"informational_label\": \"{}\"\n",
                        json_escape(text)
                    ));
                }
                None => {
                    dump.push_str(&alloc::format!(
                        "      \"expected_vault_label_blob_hex\": \"{}\"\n",
                        hex_lower(blob)
                    ));
                }
            }
            dump.push_str("    },\n");
        };

        emit_encrypt(
            &mut dump,
            "encrypt-label-ascii",
            "Seal a short ASCII vault name under the per-vault keychain wrap_key. The reference round trip: known key, known nonce, known vault_id, known label, exact expected bytes. Blob = 49-byte header + 4-byte label + 32-byte CTX commitment tag = 85 bytes. The blob every tamper case below is derived from.",
            ascii_label,
            &blob_ascii,
            Some("Work"),
        );
        emit_encrypt(
            &mut dump,
            "encrypt-label-multibyte",
            "Seal a non-ASCII vault name: 'Gunluk' with two U+00FC, two CJK ideographs, and one astral-plane emoji (U+1F5C2), so the label exercises 2-byte, 3-byte and 4-byte UTF-8 sequences. 12 scalar values, 20 UTF-8 bytes, which is the point: a port that measures the label in characters rather than bytes writes the wrong ciphertext_len and fails here while passing every ASCII case. The codec applies no normalization of its own, it seals the bytes it is handed.",
            multibyte_label,
            &blob_multibyte,
            Some(multibyte_label_str),
        );
        emit_encrypt(
            &mut dump,
            "encrypt-label-at-cap",
            "Seal a label of exactly MAX_VAULT_LABEL_PLAINTEXT_LEN (4096 bytes of 'x'). Spec 9.22.4 caps the plaintext at 4 KiB, and the cap is inclusive: 4096 seals, 4097 is refused (the encode_fail case below). A port that writes the bound as '>=' instead of '>' refuses this case and passes every other one, so the pair is what pins the boundary. ciphertext_len here is 4128 = 4096 + 32.",
            &at_cap_label,
            &blob_at_cap,
            None,
        );

        // ---- encode_fail --------------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-label/v0.1/encode-fail-over-cap\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Refuse to seal a 4097-byte label, one byte over the 9.22.4 cap. Normative and worth a case of its own: the encoder refuses outright rather than truncating, because a silently shortened name is a wrong name, and a truncating port would produce a blob that decodes cleanly forever after. Rust reference: VaultLabelBlobError::CiphertextLenOverflow raised on the encode side, the same variant the read side raises for an oversize ciphertext_len.")
        ));
        dump.push_str("      \"case_kind\": \"encode_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_wrap_key_hex\": \"{}\",\n",
            wrap_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_vault_id_hex\": \"{}\",\n",
            vault_a_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_label_utf8_hex\": \"{}\",\n",
            hex_lower(&over_cap_label)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_hex
        ));
        dump.push_str("      \"expected_error\": \"ciphertext_len_overflow\"\n");
        dump.push_str("    },\n");

        // ---- decrypt_ok closure -------------------------------------
        let emit_decrypt_ok = |dump: &mut alloc::string::String,
                               slug: &str,
                               description: &str,
                               blob: &[u8],
                               label: &[u8],
                               informational_label: &str| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-label/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_wrap_key_hex\": \"{}\",\n",
                wrap_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_expected_vault_id_hex\": \"{}\",\n",
                vault_a_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_label_utf8_hex\": \"{}\",\n",
                hex_lower(label)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_label\": \"{}\"\n",
                json_escape(informational_label)
            ));
            dump.push_str("    },\n");
        };

        emit_decrypt_ok(
            &mut dump,
            "decrypt-ok-label-ascii",
            "Open the ASCII blob with the matching wrap_key, reading for vault A. Note the expected vault_id is a decode INPUT, not something read out of the blob: it is the id of the directory the reader is reading from, it is compared against the header's copy, and it is what goes into the AAD (9.22.3).",
            &blob_ascii,
            ascii_label,
            "Work",
        );
        emit_decrypt_ok(
            &mut dump,
            "decrypt-ok-label-multibyte",
            "Open the multibyte blob and recover its 20 UTF-8 bytes exactly. The read half of the non-ASCII pin: a port that decodes to a lossy or re-encoded string (replacement characters, UTF-16 round trip, NFC folding on read) still passes the encrypt case and fails here.",
            &blob_multibyte,
            multibyte_label,
            multibyte_label_str,
        );

        // ---- decrypt_aead_fail closure ------------------------------
        let emit_aead_fail = |dump: &mut alloc::string::String,
                              slug: &str,
                              description: &str,
                              blob: &[u8],
                              wrap_key_arg_hex: &str,
                              expected_vault_id_hex: &str,
                              tamper_desc: &str| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-label/v0.1/{}\",\n",
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
                wrap_key_arg_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_expected_vault_id_hex\": \"{}\",\n",
                expected_vault_id_hex
            ));
            dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(tamper_desc)
            ));
            dump.push_str("    },\n");
        };

        emit_aead_fail(
            &mut dump,
            "decrypt-tampered-ctx-tag",
            "The ASCII blob with its final byte, inside the 32-byte CTX commitment tag, flipped by XOR 0xFF. A non-distinguishing CannotDecrypt per 6.4.",
            &blob_tag_tamper,
            &wrap_key_hex,
            &vault_a_hex,
            "final byte, inside the CTX tag, flipped via XOR 0xFF",
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-relabelled-header-vault-id",
            "Vault A's blob with its header vault_id overwritten with vault B's, then read as vault B with a working key. The structural comparison now passes, since header and expectation agree, and the AEAD refuses instead: the sealed bytes committed to A. This is the case that proves the binding is cryptographic rather than a comparison an implementer has to remember, and it is the half of the cross-vault pin that 9.18 and 9.20 cannot express, because their AAD binds the id the blob carries rather than the id the reader expected.",
            &blob_relabelled,
            &wrap_key_hex,
            &vault_b_hex,
            "header vault_id at offset 5 rewritten from vault A to vault B, then read as B",
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-wrong-wrap-key",
            "The intact ASCII blob opened with a different per-vault wrap_key. Collapses to the same CannotDecrypt as the two cases above: a port must not distinguish them. In production this is the ordinary state after the key has been destroyed (vault deleted, or names switched off), and the picker falls back to the neutral name rather than reporting anything.",
            &blob_ascii,
            &other_wrap_key_hex,
            &vault_a_hex,
            "intact blob opened under a different wrap_key",
        );

        // ---- parse_fail closure -------------------------------------
        let emit_parse_fail = |dump: &mut alloc::string::String,
                               slug: &str,
                               description: &str,
                               blob: &[u8],
                               expected_vault_id_hex: &str,
                               expected_error: &str,
                               trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-label/v0.1/{}\",\n",
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
            // The REAL wrap_key, deliberately: see this generator's doc comment.
            dump.push_str(&alloc::format!(
                "      \"input_wrap_key_hex\": \"{}\",\n",
                wrap_key_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_expected_vault_id_hex\": \"{}\",\n",
                expected_vault_id_hex
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
            "parse-fail-magic-before-decrypt",
            "Magic byte 0 corrupted to 'X' AND the final tag byte destroyed, together. The double corruption is the whole point: a decoder that decrypts first has a cannot-decrypt answer available and will give it, so only a decoder that checks the magic before touching the AEAD can answer magic_mismatch. Checking the magic after decrypting still 'works' on every valid input, which is why this ordering needs a case built to fail both checks rather than one.",
            &pf_magic_before_decrypt,
            &vault_a_hex,
            "magic_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-foreign-magic-myq1",
            "The blob with its magic replaced by MYQ1, the quick-unlock credential that literally sits beside vault.label at the vault root, and everything else left intact. The fixture carries the REAL wrap_key, so a port that never checks the magic decodes this successfully and returns 'Work', which is exactly the wrong answer the case exists to catch. The magic is not AAD-bound, so the AEAD cannot catch it for you.",
            &pf_foreign_magic,
            &vault_a_hex,
            "magic_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-protocol-version-mismatch",
            "protocol_version byte at offset 4 set to 0x02. The AAD carries the constant 0x01 rather than this byte, so a port that skips the version check decodes the blob successfully; the real wrap_key in the fixture is what makes that visible instead of masking it as a coincidental AEAD failure.",
            &pf_version,
            &vault_a_hex,
            "protocol_version_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-vault-id-mismatch",
            "Vault A's blob, untouched, read as vault B: A's file has turned up where B's should be. The header's vault_id is compared against the expected one before any key is touched, so this is the structural half of the cross-vault pin and reports vault_id_mismatch rather than the AEAD collapse. Its partner is decrypt-relabelled-header-vault-id above, where the header was also rewritten so that the comparison passes and only the AAD is left to refuse. The two MUST surface different outcomes.",
            &blob_ascii,
            &vault_b_hex,
            "vault_id_mismatch",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-len-overflow",
            "ciphertext_len at offset 45 set to 0xFFFFFFFF, far past the 4096 + 32 cap. Rejected before allocating, per 9.22.4: a hostile length must not be allowed to size an allocation. A port that allocates first and validates after passes its own tests and hands an attacker a 4 GiB request.",
            &pf_len_overflow,
            &vault_a_hex,
            "ciphertext_len_overflow",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYL1 magic, with no room for the 49-byte header. Rejected before any field is read, including the magic comparison's own neighbours.",
            &pf_header_short,
            &vault_a_hex,
            "header_too_short",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-truncated",
            "A valid header advertising ciphertext_len = 36, with the blob one byte shorter than header + ciphertext_len. Rejected before the AEAD stage, and distinct from the trailing-bytes case below: short is truncated, long is trailing, and the two are separate errors rather than one length complaint.",
            &pf_truncated,
            &vault_a_hex,
            "ciphertext_truncated",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-trailing-bytes",
            "The intact ASCII blob with one 0x00 appended. Strict-trailing per 10.3.1 is ENFORCED for this family rather than inherited leniently from the older device-local families: the surplus byte sits outside the AEAD tag and outside the AAD, so a decode that tolerated it would hand the caller a blob carrying unauthenticated bytes. The fixture carries the real wrap_key, so a lenient port decodes it successfully and returns 'Work' rather than failing for some unrelated reason.",
            &pf_trailing,
            &vault_a_hex,
            "trailing_bytes",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_label_vectors.json", dump.as_bytes())
            .expect("write vault-label vectors dump");
    }
}
