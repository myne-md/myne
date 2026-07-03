// SPDX-License-Identifier: AGPL-3.0
//! Per-attachment `MYA1` blob encoder/decoder per
//! `docs/spec/protocol.md` § 9.9 (attachment blob binary format), with
//! AAD construction per § 5.2 and the content-addressed attachment-id
//! per § 9.9 "Attachment-id".
//!
//! An attachment blob holds one arbitrary file (image, SVG, PDF) as
//! encrypted bytes under `<vault-root>/attachments/<attachment-id-hex>`
//! (§ 9.1). The blob reuses the `.myn` three-level wrapping pattern
//! (§ 9.2, [`crate::blob`]) byte-for-byte, with the `MYA1` magic in
//! place of `MY01`:
//!
//! - a per-attachment random `attachment_key` is wrapped under the
//!   vault `itemsKey` (the outer AEAD), and
//! - the file bytes are encrypted under `attachment_key` (the inner
//!   AEAD).
//!
//! Because the key lineage is `itemsKey → attachment_key`, an
//! attachment blob is **independent of any single note** — a
//! deduplicated attachment referenced by many notes has exactly one
//! blob and one key (§ 9.9). Dedup is an id-existence check (§ 9.10),
//! NOT convergent encryption: encryption stays randomized (fresh
//! `attachment_key` + nonces per blob).
//!
//! ## § 9.9 byte layout
//!
//! Identical in shape to § 9.2 with `MYA1` magic. `attachment_id` is
//! **not** in the blob — it is the on-disk filename (hex) per § 9.1 and
//! feeds both AAD constructions at encrypt/decrypt time, exactly as
//! `note_uuid` does for the `.myn` blob.
//!
//! ```text
//! Offset  Size       Field                   Notes
//! ------  ---------  ----------------------  --------------------------------
//! 0       4          magic                   ASCII "MYA1"
//! 4       1          protocol_version        0x01
//! 5       1          reserved                0x00 (non-zero rejects parse)
//! 6       16         items_key_id            UUIDv7 of singleton v0.1 itemsKey
//! 22      24         attachment_key_nonce    192-bit random nonce, key wrap
//! 46      2          enc_attachment_key_len  0x0040 = 64 (constant in v0.1)
//! 48      64         enc_attachment_key      32 B ct + 32 B CTX commitment
//! 112     24         content_nonce           192-bit random nonce, file encrypt
//! 136     4          ciphertext_len          M = file_len + 32 (BE)
//! 140     M          ciphertext              file bytes + 32 B CTX commitment
//! ```
//!
//! ## Size cap (§ 9.9 "Size cap")
//!
//! The decoder rejects `ciphertext_len > 67108864 + 32` (64 MiB + 32)
//! at the parse layer **before** any AEAD-bound allocation — parallel
//! to § 9.2's [`crate::MAX_PLAINTEXT_LEN`] rationale. Larger payloads
//! (streamed/chunked AEAD, Merkle manifests) are out of scope and would
//! require a new magic + migration, not an extension of `MYA1`.

use crate::aead::{aead_open_ctx, aead_seal_ctx, push_length_prefixed_u16_be};
use crate::aead::{AAD_PREFIX_V0_1, PROTOCOL_VERSION_V0_1};
use crate::aead::{AEAD_KEY_LEN, AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN};
use crate::subkey::{derive_subkey, SubkeyRole};
use alloc::vec::Vec;
use hkdf::Hkdf;
use serde::Serialize;
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroizing;

// ---- §9.9 byte-layout constants -----------------------------------------

/// Attachment-blob magic bytes per `protocol.md` § 9.9 offset 0. ASCII
/// `"MYA1"`. Distinct from `.myn`'s `MY01` — § 10.3 magic-byte registry.
pub const ATTACHMENT_BLOB_MAGIC: &[u8; 4] = b"MYA1";

/// Protocol version byte per § 9.9 offset 4. `0x01` for v0.1.
pub const ATTACHMENT_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// Reserved byte per § 9.9 offset 5. MUST be `0x00`; non-zero rejects
/// parse.
pub const ATTACHMENT_BLOB_RESERVED: u8 = 0x00;

/// Length of the `items_key_id` field (UUIDv7, 16 bytes).
pub const ITEMS_KEY_ID_LEN: usize = 16;

/// Length of the `attachment_id` — the 32-byte content-addressed value
/// (§ 9.9). It is the on-disk filename (hex) per § 9.1 and is bound
/// into both AAD constructions per § 5.2.
pub const ATTACHMENT_ID_LEN: usize = 32;

/// On-disk length of `enc_attachment_key` per § 9.9 offsets 48..112:
/// `AEAD_KEY_LEN` (32) + `CTX_COMMITMENT_TAG_LEN` (32) = 64. The
/// `enc_attachment_key_len` field at offset 46 is bound to this
/// constant in v0.1; parse rejects any other value.
pub const ENC_ATTACHMENT_KEY_WRAPPED_LEN: usize = AEAD_KEY_LEN + CTX_COMMITMENT_TAG_LEN;

/// 64 MiB attachment ceiling per § 9.9 "Size cap" — the maximum file
/// plaintext length, inclusive.
pub const MAX_ATTACHMENT_LEN: usize = 64 * 1024 * 1024;

// Offsets (identical shape to §9.2 / `blob.rs`, MYA1 magic).

/// Offset of `protocol_version` byte (§ 9.9).
pub const OFFSET_PROTOCOL_VERSION: usize = 4;
/// Offset of `reserved` byte (§ 9.9). MUST be `0x00`.
pub const OFFSET_RESERVED: usize = 5;
/// Offset of `items_key_id` (16 bytes) (§ 9.9).
pub const OFFSET_ITEMS_KEY_ID: usize = 6;
/// Offset of `attachment_key_nonce` (24 bytes) (§ 9.9).
pub const OFFSET_ATTACHMENT_KEY_NONCE: usize = 22;
/// Offset of `enc_attachment_key_len` (2 bytes BE, value `0x0040`) (§ 9.9).
pub const OFFSET_ENC_ATTACHMENT_KEY_LEN: usize = 46;
/// Offset of `enc_attachment_key` (64 bytes: 32 ct + 32 CTX tag) (§ 9.9).
pub const OFFSET_ENC_ATTACHMENT_KEY: usize = 48;
/// Offset of `content_nonce` (24 bytes) (§ 9.9).
pub const OFFSET_CONTENT_NONCE: usize = OFFSET_ENC_ATTACHMENT_KEY + ENC_ATTACHMENT_KEY_WRAPPED_LEN;
/// Offset of `ciphertext_len` (4 bytes BE) (§ 9.9).
pub const OFFSET_CIPHERTEXT_LEN: usize = OFFSET_CONTENT_NONCE + AEAD_NONCE_LEN;
/// Offset of the AEAD-encrypted file ciphertext (§ 9.9).
pub const OFFSET_CIPHERTEXT: usize = OFFSET_CIPHERTEXT_LEN + 4;

// ---- AAD construction (§5.2) --------------------------------------------

/// Build `AAD_wrap_attachment_key` (§ 5.2). Bound into the outer AEAD
/// that wraps `attachment_key` under `itemsKey`.
///
/// Layout (59 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.9)
/// items_key_id     16 bytes
/// attachment_id    32 bytes  (content-addressed, § 9.9; from the filename, § 9.1)
/// ```
///
/// Structurally parallel to `aad_note_item_key_wrap` (§ 5.2) with the
/// 32-byte `attachment_id` taking `note_uuid`'s place. Binding
/// `attachment_id` prevents substituting one attachment's blob for
/// another within the same vault.
pub fn aad_wrap_attachment_key(
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + items_key_id.len() + attachment_id.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(attachment_id);
    aad
}

/// Build `AAD_encrypt_attachment` (§ 5.2). Bound into the inner AEAD
/// that encrypts the file bytes under `attachment_key`.
///
/// Layout (`61 + len(content_type)` bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.9)
/// items_key_id                          16 bytes
/// attachment_id                         32 bytes
/// u16_be(len) || content_type           2 + L bytes  (length-prefixed UTF-8, § 5.2)
/// ```
///
/// `content_type` is the attachment's actual MIME (length-prefixed
/// UTF-8). Binding it means a blob cannot be reinterpreted as a
/// different content type at the AEAD layer (§ 5.2). Unlike the `.myn`
/// content-type (hardcoded `"text/markdown"`), the attachment
/// content-type is a genuine parameter — attachments are arbitrary
/// files.
pub fn aad_encrypt_attachment(
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    content_type: &[u8],
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + items_key_id.len()
            + attachment_id.len()
            + 2
            + content_type.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(attachment_id);
    push_length_prefixed_u16_be(&mut aad, content_type);
    aad
}

// ---- Content-addressed attachment-id (§9.9) -----------------------------

/// Compute the content-addressed `attachment_id` per § 9.9
/// "Attachment-id":
///
/// ```text
/// attachment_id = HMAC-SHA-256(
///     DeriveSubkey(root_key, "attachments-id-hmac"),
///     file_plaintext_bytes,
/// )
/// ```
///
/// A deterministic 32-byte value used as the on-disk filename (hex) and
/// the dedup key (§ 9.10). It is keyed under `root_key` so it is stable
/// **within** a vault but reveals nothing to a disk observer who lacks
/// `root_key` — no known-file confirmation oracle, no cross-vault
/// equality (`threat-model.md` AS7/AS8).
///
/// **HMAC via HKDF-Extract.** HKDF-Extract(salt, ikm) is defined as
/// `HMAC-SHA-256(salt, ikm)` (RFC 5869 § 2.2). The crate already
/// depends on `hkdf`; `Hkdf::<Sha256>::extract(Some(key), msg).0` is
/// therefore exactly `HMAC-SHA-256(key, msg)` with no new dependency
/// and no use of the forbidden `hkdf.expand` path (the subkey-helper
/// discipline rule governs Expand, not Extract). The HMAC key itself is
/// derived through the canonical [`derive_subkey`] helper, so the
/// registered `"attachments-id-hmac"` context string is the only way to
/// produce it.
pub fn compute_attachment_id(
    root_key: &[u8; 32],
    file_plaintext: &[u8],
) -> [u8; ATTACHMENT_ID_LEN] {
    let hmac_key = derive_subkey(root_key, SubkeyRole::AttachmentsIdHmac);
    // HKDF-Extract = HMAC-SHA-256(salt=key, ikm=message). The returned
    // PRK is the 32-byte HMAC tag.
    let (prk, _hkdf) = Hkdf::<Sha256>::extract(Some(hmac_key.as_slice()), file_plaintext);
    let mut id = [0u8; ATTACHMENT_ID_LEN];
    id.copy_from_slice(&prk);
    id
}

// ---- Error surface ------------------------------------------------------

/// Public failure surface for [`decode_attachment_blob`]. **Single
/// variant by design** mirroring `blob::DecryptError` / § 6.4: failures
/// collapse to a single non-distinguishing message regardless of cause.
/// Internal cause distinguishability lives in [`DecryptCause`]
/// (`pub(crate)`).
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum AttachmentBlobError {
    /// The blob cannot be decrypted under the supplied (`itemsKey`,
    /// `items_key_id`, `attachment_id`, `content_type`). The caller MUST
    /// NOT distinguish the failure cause to the user beyond this.
    #[error("attachment cannot be decrypted under the current vault")]
    CannotDecrypt,
    /// OS CSPRNG (`getrandom`) is unavailable on the encode path —
    /// could not source `attachment_key` / nonces. Distinct from
    /// [`AttachmentBlobError::CannotDecrypt`] because it is a
    /// randomness-availability failure on ENCODE, not an AEAD failure on
    /// decode.
    #[error("OS CSPRNG unavailable for attachment blob generation")]
    RandomnessUnavailable,
    /// File plaintext exceeds the § 9.9 64 MiB cap. Returned by the
    /// encoder boundary check before any AEAD allocation; symmetric with
    /// the decoder's parse-level reject of `ciphertext_len > 64 MiB + 32`.
    #[error("attachment exceeds 64 MiB cap")]
    AttachmentTooLarge,
}

/// Internal disambiguation of decode-failure paths, exposed
/// `pub(crate)` so the tampering-test matrix can verify which defense
/// fired per mutation case. **Never crosses the IPC boundary** — the
/// public [`decode_attachment_blob`] collapses every variant to
/// [`AttachmentBlobError::CannotDecrypt`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DecryptCause {
    /// Header parse rejects (wrong magic, wrong version, non-zero
    /// reserved, wrong `enc_attachment_key_len`, truncated header), plus
    /// the § 9.9 cap on `ciphertext_len` and the strict-trailing rule.
    Parse,
    /// Blob's `items_key_id` does not match the singleton supplied.
    ItemsKeyIdMismatch,
    /// AEAD-unwrap of `enc_attachment_key` failed the CTX commitment
    /// check (tampered blob or wrong `itemsKey` / cross-vault).
    OuterAead,
    /// File decryption failed the CTX commitment check given a
    /// successful outer unwrap (corruption of `content_nonce`,
    /// `ciphertext`, the trailing CTX tag, or `content_type` mismatch).
    InnerAead,
}

// ---- Encoder (deterministic primitive) ----------------------------------

/// Encode a fresh `MYA1` attachment blob from caller-supplied
/// randomness per § 9.9. Deterministic: identical inputs produce
/// identical output bytes. Used by `myne-test-vectors/` and
/// crate-internal tampering tests.
///
/// **`_raw` contract (caller-supplied randomness).** The caller MUST
/// source `attachment_key`, `attachment_key_nonce`, and `content_nonce`
/// from a CSPRNG-grade source and never reuse a nonce under the same
/// key. See `protocol/CLAUDE.md` `_raw` convention. Production callers
/// SHOULD use [`encode_attachment_blob`].
///
/// `content_type` is the attachment's MIME, bound into
/// `AAD_encrypt_attachment` (§ 5.2). `attachment_id` is the 32-byte
/// content-addressed id (§ 9.9), typically [`compute_attachment_id`] of
/// the same `file_plaintext`; it is the on-disk filename (hex) and is
/// bound into both AADs but is NOT in the blob bytes.
///
/// **Errors.** [`AttachmentBlobError::AttachmentTooLarge`] if
/// `file_plaintext.len() > MAX_ATTACHMENT_LEN`.
#[allow(clippy::too_many_arguments)]
pub fn encode_attachment_blob_raw(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    content_type: &[u8],
    attachment_key: &[u8; AEAD_KEY_LEN],
    attachment_key_nonce: &[u8; AEAD_NONCE_LEN],
    content_nonce: &[u8; AEAD_NONCE_LEN],
    file_plaintext: &[u8],
) -> Result<Vec<u8>, AttachmentBlobError> {
    if file_plaintext.len() > MAX_ATTACHMENT_LEN {
        return Err(AttachmentBlobError::AttachmentTooLarge);
    }

    // (1) Wrap attachment_key under itemsKey with AAD_wrap_attachment_key.
    let aad_wrap = aad_wrap_attachment_key(items_key_id, attachment_id);
    let enc_attachment_key =
        aead_seal_ctx(items_key, attachment_key_nonce, attachment_key, &aad_wrap)
            .map_err(|_| AttachmentBlobError::CannotDecrypt)?;
    debug_assert_eq!(enc_attachment_key.len(), ENC_ATTACHMENT_KEY_WRAPPED_LEN);

    // (2) Encrypt file bytes under attachment_key with AAD_encrypt_attachment.
    let aad_content = aad_encrypt_attachment(items_key_id, attachment_id, content_type);
    let ciphertext = aead_seal_ctx(attachment_key, content_nonce, file_plaintext, &aad_content)
        .map_err(|_| AttachmentBlobError::CannotDecrypt)?;
    debug_assert_eq!(
        ciphertext.len(),
        file_plaintext.len() + CTX_COMMITMENT_TAG_LEN
    );

    // (3) Assemble the §9.9 byte sequence.
    let total_len = OFFSET_CIPHERTEXT + ciphertext.len();
    let mut blob = Vec::with_capacity(total_len);
    blob.extend_from_slice(ATTACHMENT_BLOB_MAGIC);
    blob.push(ATTACHMENT_BLOB_PROTOCOL_VERSION);
    blob.push(ATTACHMENT_BLOB_RESERVED);
    blob.extend_from_slice(items_key_id);
    blob.extend_from_slice(attachment_key_nonce);
    blob.extend_from_slice(&(ENC_ATTACHMENT_KEY_WRAPPED_LEN as u16).to_be_bytes());
    blob.extend_from_slice(&enc_attachment_key);
    blob.extend_from_slice(content_nonce);
    let ciphertext_len_u32 =
        u32::try_from(ciphertext.len()).map_err(|_| AttachmentBlobError::AttachmentTooLarge)?;
    blob.extend_from_slice(&ciphertext_len_u32.to_be_bytes());
    blob.extend_from_slice(&ciphertext);

    debug_assert_eq!(blob.len(), total_len);
    Ok(blob)
}

/// Encode a fresh `MYA1` attachment blob, sourcing all randomness
/// internally from `getrandom`. Production caller surface for § 9.9.
///
/// Pulls a 32-byte `attachment_key`, a 24-byte `attachment_key_nonce`,
/// and a 24-byte `content_nonce` from the OS CSPRNG, then forwards to
/// [`encode_attachment_blob_raw`]. The `attachment_key` is held in
/// `Zeroizing` and dropped at function exit.
///
/// **Errors.** [`AttachmentBlobError::RandomnessUnavailable`] if
/// `getrandom` fails; [`AttachmentBlobError::AttachmentTooLarge`] if the
/// file exceeds the § 9.9 cap.
pub fn encode_attachment_blob(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    content_type: &[u8],
    file_plaintext: &[u8],
) -> Result<Vec<u8>, AttachmentBlobError> {
    let mut attachment_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    getrandom::getrandom(attachment_key.as_mut_slice())
        .map_err(|_| AttachmentBlobError::RandomnessUnavailable)?;

    let mut attachment_key_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut attachment_key_nonce)
        .map_err(|_| AttachmentBlobError::RandomnessUnavailable)?;

    let mut content_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut content_nonce)
        .map_err(|_| AttachmentBlobError::RandomnessUnavailable)?;

    encode_attachment_blob_raw(
        items_key,
        items_key_id,
        attachment_id,
        content_type,
        &attachment_key,
        &attachment_key_nonce,
        &content_nonce,
        file_plaintext,
    )
}

// ---- Decoder ------------------------------------------------------------

/// Decrypt a `MYA1` attachment blob, returning the file plaintext.
/// Single-error public surface — failures collapse to
/// [`AttachmentBlobError::CannotDecrypt`] regardless of cause.
///
/// `attachment_id` is the on-disk filename (hex-decoded) per § 9.1; the
/// caller extracts it from the path before calling. `content_type` is
/// the attachment's MIME (the caller reads it from the catalog, § 9.10)
/// and is bound into `AAD_encrypt_attachment`; a mismatch fails the CTX
/// commitment check. `items_key_id` is the singleton id read from
/// `vault.meta`.
///
/// The returned plaintext is wrapped in [`Zeroizing`] — Drop wipes it.
pub fn decode_attachment_blob(
    blob: &[u8],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    content_type: &[u8],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<Zeroizing<Vec<u8>>, AttachmentBlobError> {
    decode_attachment_blob_with_cause(blob, attachment_id, content_type, items_key, items_key_id)
        .map_err(|cause| {
            tracing::debug!(stage = ?cause, "decode_attachment_blob failed");
            AttachmentBlobError::CannotDecrypt
        })
}

/// Crate-internal decode entry point that returns the distinguishable
/// [`DecryptCause`] for the tampering-test matrix. The public
/// [`decode_attachment_blob`] collapses every variant to
/// [`AttachmentBlobError::CannotDecrypt`].
pub(crate) fn decode_attachment_blob_with_cause(
    blob: &[u8],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    content_type: &[u8],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<Zeroizing<Vec<u8>>, DecryptCause> {
    // ---- Step 1: parse-level checks ----
    if blob.len() < OFFSET_CIPHERTEXT {
        return Err(DecryptCause::Parse);
    }
    if &blob[0..ATTACHMENT_BLOB_MAGIC.len()] != ATTACHMENT_BLOB_MAGIC {
        return Err(DecryptCause::Parse);
    }
    if blob[OFFSET_PROTOCOL_VERSION] != ATTACHMENT_BLOB_PROTOCOL_VERSION {
        return Err(DecryptCause::Parse);
    }
    if blob[OFFSET_RESERVED] != ATTACHMENT_BLOB_RESERVED {
        return Err(DecryptCause::Parse);
    }
    let enc_key_len_bytes: [u8; 2] = blob[OFFSET_ENC_ATTACHMENT_KEY_LEN..OFFSET_ENC_ATTACHMENT_KEY]
        .try_into()
        .expect("2-byte slice fits a [u8; 2] by construction");
    let enc_key_len = u16::from_be_bytes(enc_key_len_bytes) as usize;
    if enc_key_len != ENC_ATTACHMENT_KEY_WRAPPED_LEN {
        return Err(DecryptCause::Parse);
    }

    let ciphertext_len_bytes: [u8; 4] = blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
        .try_into()
        .expect("4-byte slice fits a [u8; 4] by construction");
    let ciphertext_len = u32::from_be_bytes(ciphertext_len_bytes) as usize;

    // No room for the trailing CTX commitment tag.
    if ciphertext_len < CTX_COMMITMENT_TAG_LEN {
        return Err(DecryptCause::Parse);
    }
    // §9.9 64 MiB cap — reject BEFORE allocation.
    if ciphertext_len > MAX_ATTACHMENT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(DecryptCause::Parse);
    }
    // Strict-trailing: blob length MUST equal the declared layout.
    let expected_total = OFFSET_CIPHERTEXT + ciphertext_len;
    if blob.len() != expected_total {
        return Err(DecryptCause::Parse);
    }

    // ---- Step 2: items_key_id mismatch ----
    let blob_items_key_id_slice = &blob[OFFSET_ITEMS_KEY_ID..OFFSET_ATTACHMENT_KEY_NONCE];
    if blob_items_key_id_slice != items_key_id.as_slice() {
        return Err(DecryptCause::ItemsKeyIdMismatch);
    }

    // ---- Step 3: outer AEAD — unwrap attachment_key under itemsKey ----
    let attachment_key_nonce: [u8; AEAD_NONCE_LEN] = blob
        [OFFSET_ATTACHMENT_KEY_NONCE..OFFSET_ENC_ATTACHMENT_KEY_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let enc_attachment_key_bytes = &blob[OFFSET_ENC_ATTACHMENT_KEY..OFFSET_CONTENT_NONCE];
    let aad_wrap = aad_wrap_attachment_key(items_key_id, attachment_id);
    let attachment_key_zeroizing = aead_open_ctx(
        items_key,
        &attachment_key_nonce,
        enc_attachment_key_bytes,
        &aad_wrap,
    )
    .map_err(|_| DecryptCause::OuterAead)?;

    if attachment_key_zeroizing.len() != AEAD_KEY_LEN {
        return Err(DecryptCause::OuterAead);
    }
    let mut attachment_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    attachment_key.copy_from_slice(&attachment_key_zeroizing);

    // ---- Step 4: inner AEAD — decrypt ciphertext under attachment_key ----
    let content_nonce: [u8; AEAD_NONCE_LEN] = blob[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let ciphertext_bytes = &blob[OFFSET_CIPHERTEXT..];
    let aad_content = aad_encrypt_attachment(items_key_id, attachment_id, content_type);
    let plaintext = aead_open_ctx(
        &attachment_key,
        &content_nonce,
        ciphertext_bytes,
        &aad_content,
    )
    .map_err(|_| DecryptCause::InnerAead)?;

    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};
    use alloc::vec;

    const TEST_ITEMS_KEY: [u8; AEAD_KEY_LEN] = [0xAA; 32];
    const TEST_ITEMS_KEY_ID: [u8; ITEMS_KEY_ID_LEN] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF,
    ];
    const TEST_ATTACHMENT_ID: [u8; ATTACHMENT_ID_LEN] = [0x5A; 32];
    const TEST_ATTACHMENT_KEY: [u8; AEAD_KEY_LEN] = [0xCC; 32];
    const TEST_ATTACHMENT_KEY_NONCE: [u8; AEAD_NONCE_LEN] = [0x10; 24];
    const TEST_CONTENT_NONCE: [u8; AEAD_NONCE_LEN] = [0x20; 24];
    const TEST_CONTENT_TYPE: &[u8] = b"image/png";
    const TEST_FILE: &[u8] = b"\x89PNG\r\n\x1a\n fake png bytes for the round trip";

    fn encode_with_fixture(file: &[u8]) -> Vec<u8> {
        encode_attachment_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ATTACHMENT_KEY,
            &TEST_ATTACHMENT_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            file,
        )
        .expect("fixture encodes cleanly")
    }

    // ---- §9.9 layout-constant pins ----

    #[test]
    fn offsets_match_spec_9_9_layout() {
        assert_eq!(OFFSET_PROTOCOL_VERSION, 4);
        assert_eq!(OFFSET_RESERVED, 5);
        assert_eq!(OFFSET_ITEMS_KEY_ID, 6);
        assert_eq!(OFFSET_ATTACHMENT_KEY_NONCE, 22);
        assert_eq!(OFFSET_ENC_ATTACHMENT_KEY_LEN, 46);
        assert_eq!(OFFSET_ENC_ATTACHMENT_KEY, 48);
        assert_eq!(OFFSET_CONTENT_NONCE, 112);
        assert_eq!(OFFSET_CIPHERTEXT_LEN, 136);
        assert_eq!(OFFSET_CIPHERTEXT, 140);
        assert_eq!(ENC_ATTACHMENT_KEY_WRAPPED_LEN, 64);
        assert_eq!(MAX_ATTACHMENT_LEN, 67108864);
    }

    #[test]
    fn encode_emits_mya1_magic_and_header_fields() {
        let blob = encode_with_fixture(TEST_FILE);
        assert_eq!(&blob[0..4], ATTACHMENT_BLOB_MAGIC);
        assert_eq!(
            blob[OFFSET_PROTOCOL_VERSION],
            ATTACHMENT_BLOB_PROTOCOL_VERSION
        );
        assert_eq!(blob[OFFSET_RESERVED], ATTACHMENT_BLOB_RESERVED);
        assert_eq!(
            &blob[OFFSET_ITEMS_KEY_ID..OFFSET_ATTACHMENT_KEY_NONCE],
            &TEST_ITEMS_KEY_ID
        );
        assert_eq!(
            &blob[OFFSET_ATTACHMENT_KEY_NONCE..OFFSET_ENC_ATTACHMENT_KEY_LEN],
            &TEST_ATTACHMENT_KEY_NONCE
        );
        assert_eq!(
            &blob[OFFSET_ENC_ATTACHMENT_KEY_LEN..OFFSET_ENC_ATTACHMENT_KEY],
            &[0x00, 0x40] // u16 BE 64
        );
        assert_eq!(
            &blob[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN],
            &TEST_CONTENT_NONCE
        );
        let expected_ct_len =
            (TEST_FILE.len() as u32 + CTX_COMMITMENT_TAG_LEN as u32).to_be_bytes();
        assert_eq!(
            &blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT],
            &expected_ct_len
        );
        assert_eq!(
            blob.len(),
            OFFSET_CIPHERTEXT + TEST_FILE.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    // ---- round-trip ----

    #[test]
    fn encode_decode_round_trip() {
        let blob = encode_with_fixture(TEST_FILE);
        let plaintext = decode_attachment_blob(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect("round-trip decode succeeds");
        assert_eq!(plaintext.as_slice(), TEST_FILE);
    }

    #[test]
    fn encode_decode_round_trip_empty_file() {
        let blob = encode_with_fixture(b"");
        let plaintext = decode_attachment_blob(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect("empty-file round-trip");
        assert!(plaintext.is_empty());
    }

    // ---- cap enforcement ----

    #[test]
    fn encode_rejects_oversized_file() {
        // One byte over the 64 MiB cap → AttachmentTooLarge. Allocated
        // only at test time.
        let file = vec![0u8; MAX_ATTACHMENT_LEN + 1];
        let err = encode_attachment_blob_raw(
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ATTACHMENT_KEY,
            &TEST_ATTACHMENT_KEY_NONCE,
            &TEST_CONTENT_NONCE,
            &file,
        )
        .expect_err("oversized file must be rejected");
        assert_eq!(err, AttachmentBlobError::AttachmentTooLarge);
    }

    #[test]
    fn decode_rejects_oversized_ciphertext_len_field() {
        // Forge a header advertising ciphertext_len > 64 MiB + 32. The
        // parser must reject before allocation — we don't even need a
        // full blob body.
        let mut blob = encode_with_fixture(b"hello");
        let forged = (MAX_ATTACHMENT_LEN as u32 + CTX_COMMITMENT_TAG_LEN as u32 + 1).to_be_bytes();
        blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT].copy_from_slice(&forged);
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("oversized ciphertext_len must be rejected at parse");
        assert_eq!(cause, DecryptCause::Parse);
    }

    // ---- cross-vault / wrong-key failures ----

    #[test]
    fn decode_fails_with_wrong_items_key() {
        let blob = encode_with_fixture(TEST_FILE);
        let mut wrong_items_key = TEST_ITEMS_KEY;
        wrong_items_key[0] ^= 0x01;
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &wrong_items_key,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("wrong itemsKey must fail");
        assert_eq!(cause, DecryptCause::OuterAead);
    }

    #[test]
    fn decode_fails_with_wrong_items_key_id() {
        let blob = encode_with_fixture(TEST_FILE);
        let mut wrong_id = TEST_ITEMS_KEY_ID;
        wrong_id[0] ^= 0x01;
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &wrong_id,
        )
        .expect_err("wrong items_key_id must fail");
        assert_eq!(cause, DecryptCause::ItemsKeyIdMismatch);
    }

    #[test]
    fn decode_fails_with_wrong_attachment_id() {
        // attachment_id is bound into AAD_wrap_attachment_key — a wrong
        // id fails the outer unwrap (it never reaches the inner AEAD).
        let blob = encode_with_fixture(TEST_FILE);
        let mut wrong_id = TEST_ATTACHMENT_ID;
        wrong_id[0] ^= 0x01;
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &wrong_id,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("wrong attachment_id must fail");
        assert_eq!(cause, DecryptCause::OuterAead);
    }

    #[test]
    fn decode_fails_with_wrong_content_type() {
        // content_type is bound only into AAD_encrypt_attachment — the
        // outer unwrap succeeds, the inner decrypt fails.
        let blob = encode_with_fixture(TEST_FILE);
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            b"application/pdf",
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("wrong content_type must fail");
        assert_eq!(cause, DecryptCause::InnerAead);
    }

    // ---- tampering ----

    #[test]
    fn decode_fails_with_tampered_ciphertext() {
        let mut blob = encode_with_fixture(TEST_FILE);
        let tamper_at = OFFSET_CIPHERTEXT + 1;
        blob[tamper_at] ^= 0x01;
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("tampered ciphertext must fail");
        assert_eq!(cause, DecryptCause::InnerAead);
    }

    #[test]
    fn decode_fails_with_tampered_wrapped_key() {
        let mut blob = encode_with_fixture(TEST_FILE);
        blob[OFFSET_ENC_ATTACHMENT_KEY + 1] ^= 0x01;
        let cause = decode_attachment_blob_with_cause(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("tampered wrapped key must fail");
        assert_eq!(cause, DecryptCause::OuterAead);
    }

    #[test]
    fn decode_public_surface_collapses_to_cannot_decrypt() {
        let mut blob = encode_with_fixture(TEST_FILE);
        blob[OFFSET_CIPHERTEXT] ^= 0xFF;
        let err = decode_attachment_blob(
            &blob,
            &TEST_ATTACHMENT_ID,
            TEST_CONTENT_TYPE,
            &TEST_ITEMS_KEY,
            &TEST_ITEMS_KEY_ID,
        )
        .expect_err("tampered blob must fail");
        assert_eq!(err, AttachmentBlobError::CannotDecrypt);
    }

    // ---- attachment-id determinism (§9.9) ----

    #[test]
    fn attachment_id_is_deterministic_for_same_bytes() {
        let root = [0x42u8; 32];
        let a = compute_attachment_id(&root, b"the same file bytes");
        let b = compute_attachment_id(&root, b"the same file bytes");
        assert_eq!(a, b);
    }

    #[test]
    fn attachment_id_differs_for_different_bytes() {
        let root = [0x42u8; 32];
        let a = compute_attachment_id(&root, b"file one");
        let b = compute_attachment_id(&root, b"file two");
        assert_ne!(a, b);
    }

    #[test]
    fn attachment_id_differs_across_vaults() {
        // Keyed under root_key: same bytes, different vault → different id.
        // No cross-vault equality oracle (AS7/AS8).
        let root_a = [0x11u8; 32];
        let root_b = [0x22u8; 32];
        let a = compute_attachment_id(&root_a, b"identical content");
        let b = compute_attachment_id(&root_b, b"identical content");
        assert_ne!(a, b);
    }

    #[test]
    fn attachment_id_matches_manual_hkdf_extract_hmac() {
        // Pin that compute_attachment_id is exactly
        // HMAC-SHA-256(DeriveSubkey(root, "attachments-id-hmac"), msg),
        // computed here via the independent extract path.
        let root = [0x42u8; 32];
        let msg = b"verify the hmac construction";
        let id = compute_attachment_id(&root, msg);

        let hmac_key = derive_subkey(&root, SubkeyRole::AttachmentsIdHmac);
        let (prk, _) = Hkdf::<Sha256>::extract(Some(hmac_key.as_slice()), msg);
        assert_eq!(&id[..], prk.as_slice());
    }

    // ---- AAD construction pins (§5.2) ----

    #[test]
    fn aad_wrap_attachment_key_layout() {
        let aad = aad_wrap_attachment_key(&TEST_ITEMS_KEY_ID, &TEST_ATTACHMENT_ID);
        // 10 (prefix) + 1 (version) + 16 (items_key_id) + 32 (attachment_id) = 59.
        assert_eq!(aad.len(), 59);
        assert_eq!(&aad[0..10], b"myne.v0.1|");
        assert_eq!(aad[10], 0x01);
        assert_eq!(&aad[11..27], &TEST_ITEMS_KEY_ID);
        assert_eq!(&aad[27..59], &TEST_ATTACHMENT_ID);
    }

    #[test]
    fn aad_encrypt_attachment_layout() {
        let aad =
            aad_encrypt_attachment(&TEST_ITEMS_KEY_ID, &TEST_ATTACHMENT_ID, TEST_CONTENT_TYPE);
        // 59 (wrap layout) + 2 (u16 len) + 9 ("image/png") = 70.
        assert_eq!(aad.len(), 70);
        // First 59 bytes equal the wrap AAD.
        let wrap = aad_wrap_attachment_key(&TEST_ITEMS_KEY_ID, &TEST_ATTACHMENT_ID);
        assert_eq!(&aad[..59], wrap.as_slice());
        assert_eq!(&aad[59..61], &[0x00, 0x09]); // u16 BE 9
        assert_eq!(&aad[61..], TEST_CONTENT_TYPE);
    }

    #[test]
    fn aad_encrypt_attachment_changes_with_content_type() {
        let a = aad_encrypt_attachment(&TEST_ITEMS_KEY_ID, &TEST_ATTACHMENT_ID, b"image/png");
        let b = aad_encrypt_attachment(&TEST_ITEMS_KEY_ID, &TEST_ATTACHMENT_ID, b"image/jpeg");
        assert_ne!(a, b);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits `myne-test-vectors/vectors/attachment-blob/v0.1/cases.json`
    /// to `/tmp/myne_attachment_blob_vectors.json`. `#[ignore]` — run
    /// with:
    /// `cargo test -p protocol --lib emit_attachment_blob_vectors_for_paste -- --ignored`
    ///
    /// Cases (case_kind): `encrypt` (MYA1 byte output), `decrypt_ok`
    /// (round-trip), `decrypt_aead_fail` (cross-vault + tamper,
    /// non-distinguishing), `aad_construction` (both attachment AAD
    /// builders' canonical bytes), `id_determinism`
    /// (`compute_attachment_id` mapping).
    #[test]
    #[ignore]
    fn emit_attachment_blob_vectors_for_paste() {
        extern crate std;

        // Distinct byte patterns per field for visual cross-check.
        let items_key: [u8; AEAD_KEY_LEN] = [0xAA; 32];
        let other_items_key: [u8; AEAD_KEY_LEN] = [0xAB; 32];
        let items_key_id: [u8; ITEMS_KEY_ID_LEN] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let attachment_id: [u8; ATTACHMENT_ID_LEN] = [0x5A; 32];
        let attachment_key: [u8; AEAD_KEY_LEN] = [0xCC; 32];
        let attachment_key_nonce: [u8; AEAD_NONCE_LEN] = [0x10; 24];
        let content_nonce: [u8; AEAD_NONCE_LEN] = [0x20; 24];
        let content_type: &[u8] = b"image/png";
        let file_small: &[u8] = b"\x89PNG\r\n\x1a\n attachment vector payload";
        let file_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let blob_small = encode_attachment_blob_raw(
            &items_key,
            &items_key_id,
            &attachment_id,
            content_type,
            &attachment_key,
            &attachment_key_nonce,
            &content_nonce,
            file_small,
        )
        .expect("encode small");
        let blob_1kb = encode_attachment_blob_raw(
            &items_key,
            &items_key_id,
            &attachment_id,
            content_type,
            &attachment_key,
            &attachment_key_nonce,
            &content_nonce,
            &file_1kb,
        )
        .expect("encode 1kb");

        // Round-trip sanity.
        let decoded = decode_attachment_blob(
            &blob_1kb,
            &attachment_id,
            content_type,
            &items_key,
            &items_key_id,
        )
        .expect("decode 1kb round-trip");
        assert_eq!(decoded.as_slice(), file_1kb.as_slice());

        // decrypt_aead_fail (a): tamper a ciphertext byte.
        let mut blob_tamper = blob_small.clone();
        blob_tamper[OFFSET_CIPHERTEXT + 1] ^= 0xFF;
        // decrypt_aead_fail (b): valid blob, wrong itemsKey (cross-vault).

        // id determinism inputs.
        let id_root: [u8; 32] = [0x42; 32];
        let id_file_a: &[u8] = b"deterministic attachment file bytes";
        let id_file_b: &[u8] = b"a different file's bytes";
        let id_a = compute_attachment_id(&id_root, id_file_a);
        let id_a2 = compute_attachment_id(&id_root, id_file_a);
        let id_b = compute_attachment_id(&id_root, id_file_b);
        assert_eq!(id_a, id_a2);
        assert_ne!(id_a, id_b);
        let id_hmac_key = derive_subkey(&id_root, SubkeyRole::AttachmentsIdHmac);

        let aad_wrap = aad_wrap_attachment_key(&items_key_id, &attachment_id);
        let aad_enc = aad_encrypt_attachment(&items_key_id, &attachment_id, content_type);

        let mut d = alloc::string::String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"attachment-blob\",\n");
        d.push_str("  \"protocol_version\": \"v0.1\",\n");
        d.push_str("  \"spec_section\": \"protocol.md §9.9 + §5.2\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_attachment_blob_raw + decode_attachment_blob (MYA1) + the two attachment AAD builders + compute_attachment_id. Reference impl: protocol/src/attachment_blob.rs. content_type bound into AAD_encrypt_attachment; attachment_id bound into both AADs; key lineage itemsKey->attachment_key->file (independent of any note).\",\n");
        d.push_str("  \"cases\": [\n");

        // encrypt (small + 1kb)
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/encrypt-small\",\n");
        d.push_str("      \"description\": \"Encode a small PNG payload to a MYA1 blob; pins full byte output.\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_key_hex\": \"{}\",\n",
            hex_lower(&attachment_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_key_nonce_hex\": \"{}\",\n",
            hex_lower(&attachment_key_nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_nonce_hex\": \"{}\",\n",
            hex_lower(&content_nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"input_file_plaintext_hex\": \"{}\",\n",
            hex_lower(file_small)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_attachment_blob_hex\": \"{}\"\n",
            hex_lower(&blob_small)
        ));
        d.push_str("    },\n");

        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/encrypt-1kb\",\n");
        d.push_str("      \"description\": \"Encode a 1-KiB payload to a MYA1 blob; pins full byte output across a larger ciphertext_len.\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_key_hex\": \"{}\",\n",
            hex_lower(&attachment_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_key_nonce_hex\": \"{}\",\n",
            hex_lower(&attachment_key_nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_nonce_hex\": \"{}\",\n",
            hex_lower(&content_nonce)
        ));
        d.push_str(&alloc::format!(
            "      \"input_file_plaintext_hex\": \"{}\",\n",
            hex_lower(&file_1kb)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_attachment_blob_hex\": \"{}\"\n",
            hex_lower(&blob_1kb)
        ));
        d.push_str("    },\n");

        // decrypt_ok
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/decrypt-ok\",\n");
        d.push_str(
            "      \"description\": \"Decode the 1-KiB MYA1 blob back to its file plaintext.\",\n",
        );
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_attachment_blob_hex\": \"{}\",\n",
            hex_lower(&blob_1kb)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_file_plaintext_hex\": \"{}\"\n",
            hex_lower(&file_1kb)
        ));
        d.push_str("    },\n");

        // decrypt_aead_fail (a): tamper
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/decrypt-fail-tamper\",\n");
        d.push_str("      \"description\": \"Tampered ciphertext byte → non-distinguishing AEAD failure (§6.4).\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&alloc::format!(
            "      \"input_attachment_blob_hex\": \"{}\",\n",
            hex_lower(&blob_tamper)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // decrypt_aead_fail (b): cross-vault wrong itemsKey
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/decrypt-fail-cross-vault\",\n");
        d.push_str("      \"description\": \"Valid blob, wrong itemsKey (cross-vault) → non-distinguishing AEAD failure.\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&alloc::format!(
            "      \"input_attachment_blob_hex\": \"{}\",\n",
            hex_lower(&blob_small)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&other_items_key)
        ));
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // aad_construction: wrap
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/aad-wrap-attachment-key\",\n");
        d.push_str("      \"description\": \"AAD_wrap_attachment_key canonical bytes: prefix || 0x01 || items_key_id(16) || attachment_id(32).\",\n");
        d.push_str("      \"case_kind\": \"aad_construction\",\n");
        d.push_str("      \"input_aad_builder\": \"aad_wrap_attachment_key\",\n");
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad_wrap)
        ));
        d.push_str("    },\n");

        // aad_construction: encrypt
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/aad-encrypt-attachment\",\n");
        d.push_str("      \"description\": \"AAD_encrypt_attachment canonical bytes: prefix || 0x01 || items_key_id(16) || attachment_id(32) || u16_be(len)||content_type.\",\n");
        d.push_str("      \"case_kind\": \"aad_construction\",\n");
        d.push_str("      \"input_aad_builder\": \"aad_encrypt_attachment\",\n");
        d.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        d.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad_enc)
        ));
        d.push_str("    },\n");

        // id_determinism a
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/id-determinism-a\",\n");
        d.push_str("      \"description\": \"compute_attachment_id = HMAC-SHA-256(DeriveSubkey(root,'attachments-id-hmac'), file). informational_id_hmac_key_hex is the derived HMAC key.\",\n");
        d.push_str("      \"case_kind\": \"id_determinism\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&id_root)
        ));
        d.push_str(&alloc::format!(
            "      \"input_file_plaintext_hex\": \"{}\",\n",
            hex_lower(id_file_a)
        ));
        d.push_str(&alloc::format!(
            "      \"informational_id_hmac_key_hex\": \"{}\",\n",
            hex_lower(id_hmac_key.as_slice())
        ));
        d.push_str(&alloc::format!(
            "      \"expected_attachment_id_hex\": \"{}\"\n",
            hex_lower(&id_a)
        ));
        d.push_str("    },\n");

        // id_determinism b (different bytes → different id)
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"attachment-blob/v0.1/id-determinism-b\",\n");
        d.push_str("      \"description\": \"Different file bytes under the same root → a different attachment_id (content-addressed).\",\n");
        d.push_str("      \"case_kind\": \"id_determinism\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&id_root)
        ));
        d.push_str(&alloc::format!(
            "      \"input_file_plaintext_hex\": \"{}\",\n",
            hex_lower(id_file_b)
        ));
        d.push_str(&alloc::format!(
            "      \"expected_attachment_id_hex\": \"{}\"\n",
            hex_lower(&id_b)
        ));
        d.push_str("    }\n");

        d.push_str("  ]\n");
        d.push_str("}\n");

        std::fs::write("/tmp/myne_attachment_blob_vectors.json", d.as_bytes())
            .expect("write attachment-blob vectors dump");
    }

    // ---- KAT vector APPEND generator: structural parse rejects --------

    /// Emits a JSON **array fragment** of 9 additional cases for
    /// `myne-test-vectors/vectors/attachment-blob/v0.1/cases.json` at
    /// `/tmp/myne_attachment_blob_parse_fail_vectors.json` (MYND-227),
    /// spliced by hand into the existing `cases` array. The original
    /// `emit_attachment_blob_vectors_for_paste` stays byte-stable and is
    /// NOT re-run (vector_id immutability).
    ///
    /// Run with:
    /// `cargo test -p protocol --lib emit_attachment_blob_parse_fail_vectors -- --ignored`
    ///
    /// 8 `parse_fail` cases — one per named structural check in
    /// `decode_attachment_blob_with_cause` (§9.9 layout + strict-trailing)
    /// — plus 1 `decrypt_aead_fail` items_key_id-mismatch case (rides the
    /// existing schema branch). All nine collapse to the single
    /// non-distinguishing `AttachmentBlobError::CannotDecrypt`. As in the
    /// myn-blob sibling, the cases carry the REAL `items_key`: header
    /// bytes are not AAD-bound, so a port skipping a structural check
    /// decodes the tampered blob successfully and returns Ok — which the
    /// runner catches.
    #[test]
    #[ignore]
    fn emit_attachment_blob_parse_fail_vectors() {
        extern crate std;

        // Identical fixture to emit_attachment_blob_vectors_for_paste; the
        // base blob equals the landed encrypt-small expected blob.
        let items_key: [u8; AEAD_KEY_LEN] = [0xAA; 32];
        let items_key_id: [u8; ITEMS_KEY_ID_LEN] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let attachment_id: [u8; ATTACHMENT_ID_LEN] = [0x5A; 32];
        let attachment_key: [u8; AEAD_KEY_LEN] = [0xCC; 32];
        let attachment_key_nonce: [u8; AEAD_NONCE_LEN] = [0x10; 24];
        let content_nonce: [u8; AEAD_NONCE_LEN] = [0x20; 24];
        let content_type: &[u8] = b"image/png";
        let file_small: &[u8] = b"\x89PNG\r\n\x1a\n attachment vector payload";

        let base = encode_attachment_blob_raw(
            &items_key,
            &items_key_id,
            &attachment_id,
            content_type,
            &attachment_key,
            &attachment_key_nonce,
            &content_nonce,
            file_small,
        )
        .expect("encode base");
        decode_attachment_blob(
            &base,
            &attachment_id,
            content_type,
            &items_key,
            &items_key_id,
        )
        .expect("base fixture must decode");

        let header_short: alloc::vec::Vec<u8> = ATTACHMENT_BLOB_MAGIC.to_vec();
        let mut magic_tamper = base.clone();
        magic_tamper[0] = b'X';
        let mut version_tamper = base.clone();
        version_tamper[OFFSET_PROTOCOL_VERSION] = 0x02;
        let mut reserved_tamper = base.clone();
        reserved_tamper[OFFSET_RESERVED] = 0x01;
        let mut key_len_tamper = base.clone();
        key_len_tamper[OFFSET_ENC_ATTACHMENT_KEY_LEN..OFFSET_ENC_ATTACHMENT_KEY]
            .copy_from_slice(&65u16.to_be_bytes());
        let mut len_below_tag = base.clone();
        len_below_tag[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .copy_from_slice(&31u32.to_be_bytes());
        let mut len_overflow = base.clone();
        len_overflow[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        let mut trailing = base.clone();
        trailing.push(0x00);

        struct PfCase<'a> {
            slug: &'a str,
            description: &'a str,
            blob: &'a [u8],
            tamper: &'a str,
        }
        let parse_fails = [
            PfCase {
                slug: "parse-fail-header-too-short",
                description: "Only the 4-byte MYA1 magic — shorter than the 140-byte fixed prefix. Rejected before any field read. Like every structural reject in this category it collapses to the single non-distinguishing CannotDecrypt; the per-case naming documents WHICH check a conforming implementation must perform, not a distinguishable error surface.",
                blob: header_short.as_slice(),
                tamper: "blob is the 4 magic bytes only (4 < 140)",
            },
            PfCase {
                slug: "parse-fail-magic-mismatch",
                description: "First byte of the MYA1 magic corrupted to 'X'. A foreign file, a different artifact type, or a forward-incompatible MYA5 blob all fail here, before any decryption.",
                blob: magic_tamper.as_slice(),
                tamper: "byte 0 (magic[0]) 'M' → 'X'",
            },
            PfCase {
                slug: "parse-fail-protocol-version-mismatch",
                description: "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting.",
                blob: version_tamper.as_slice(),
                tamper: "byte 4 (protocol_version) 0x01 → 0x02",
            },
            PfCase {
                slug: "parse-fail-reserved-nonzero",
                description: "reserved byte (offset 5) set to 0x01 instead of 0x00. Reserved bytes are flag carriers for future v0.1.x revisions; non-zero is an unconditional reject.",
                blob: reserved_tamper.as_slice(),
                tamper: "byte 5 (reserved) 0x00 → 0x01",
            },
            PfCase {
                slug: "parse-fail-enc-attachment-key-len",
                description: "enc_attachment_key_len field (offset 46..48) set to 65 instead of 64 (= 32-byte wrapped attachment_key + 32-byte CTX tag). v0.1 admits exactly one wrapped-key length.",
                blob: key_len_tamper.as_slice(),
                tamper: "bytes 46..48 (enc_attachment_key_len) 64 → 65",
            },
            PfCase {
                slug: "parse-fail-ciphertext-len-below-tag",
                description: "ciphertext_len field (offset 136..140) set to 31 — below the 32-byte CTX commitment tag, so the advertised ciphertext cannot even contain a tag.",
                blob: len_below_tag.as_slice(),
                tamper: "bytes 136..140 (ciphertext_len) → 31 (< 32-byte CTX tag)",
            },
            PfCase {
                slug: "parse-fail-ciphertext-len-overflow",
                description: "ciphertext_len field (offset 136..140) set to 0xFFFFFFFF, far above MAX_ATTACHMENT_LEN + 32 (64 MiB + 32). A port MUST bound-check ciphertext_len before allocating or indexing (§9.9 DoS-allocation defense).",
                blob: len_overflow.as_slice(),
                tamper: "bytes 136..140 (ciphertext_len) → 0xffffffff",
            },
            PfCase {
                slug: "parse-fail-trailing-byte",
                description: "One 0x00 byte appended after a fully valid blob. Strict-trailing: blob length MUST equal the declared layout exactly. A port that tolerantly ignores trailing bytes decodes this blob successfully and returns Ok, which the runner catches (the AEAD tags still verify; only the length discipline rejects it).",
                blob: trailing.as_slice(),
                tamper: "one 0x00 byte appended (blob length = declared layout + 1)",
            },
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");
        for case in &parse_fails {
            assert!(
                matches!(
                    decode_attachment_blob(
                        case.blob,
                        &attachment_id,
                        content_type,
                        &items_key,
                        &items_key_id
                    ),
                    Err(AttachmentBlobError::CannotDecrypt)
                ),
                "[{}] tampered blob must reject with CannotDecrypt",
                case.slug
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"attachment-blob/v0.1/{}\",\n",
                case.slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(case.description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_attachment_blob_hex\": \"{}\",\n",
                hex_lower(case.blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_attachment_id_hex\": \"{}\",\n",
                hex_lower(&attachment_id)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_content_type_utf8_hex\": \"{}\",\n",
                hex_lower(content_type)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_hex\": \"{}\",\n",
                hex_lower(&items_key)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                hex_lower(&items_key_id)
            ));
            dump.push_str("      \"expected_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(case.tamper)
            ));
            dump.push_str("    },\n");
        }

        // decrypt_aead_fail: intact blob, mismatched caller items_key_id.
        // Field set matches the existing decrypt_aead_fail branch (which
        // carries no informational_tamper_description) — the description
        // documents the mismatch.
        let other_items_key_id: [u8; ITEMS_KEY_ID_LEN] = [0xBD; ITEMS_KEY_ID_LEN];
        assert!(
            matches!(
                decode_attachment_blob(
                    &base,
                    &attachment_id,
                    content_type,
                    &items_key,
                    &other_items_key_id
                ),
                Err(AttachmentBlobError::CannotDecrypt)
            ),
            "items_key_id mismatch must reject with CannotDecrypt"
        );
        dump.push_str("    {\n");
        dump.push_str(
            "      \"vector_id\": \"attachment-blob/v0.1/decrypt-items-key-id-mismatch\",\n",
        );
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape(
                "A fully intact small blob decoded with a MISMATCHED caller items_key_id (0xbd×16; the blob embeds the 0x00..0xff pattern). The decoder compares the embedded items_key_id against the caller's active one before any AEAD work and rejects with the same non-distinguishing CannotDecrypt. Pins that a port performs the comparison at all — skipping it would proceed to the outer unwrap and (with the right items_key, as here) decode successfully."
            )
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_attachment_blob_hex\": \"{}\",\n",
            hex_lower(&base)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            hex_lower(&attachment_id)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_content_type_utf8_hex\": \"{}\",\n",
            hex_lower(content_type)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&other_items_key_id)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\"\n");
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_attachment_blob_parse_fail_vectors.json",
            dump.as_bytes(),
        )
        .expect("write attachment-blob parse_fail vectors dump");
    }
}
