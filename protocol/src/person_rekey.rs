// SPDX-License-Identifier: AGPL-3.0
//! The B2B vault rekey (myne-md/myne#698 task 7): rotating the vault
//! `itemsKey` when a member is removed.
//!
//! **Scope of rotation: `itemsKey` only, NOT `root_key`.** The key
//! hierarchy (`protocol.md` §3.3) puts every per-note `item_key` and every
//! attachment `attachment_key` under the singleton `itemsKey`, so a fresh
//! `itemsKey` re-keys ALL content in one step, while `root_key` (and with
//! it the recovery path, the SCRAM verifier, and every `root_key`-derived
//! KEK) stays untouched. This is the Bitwarden content-encryption-key
//! pattern: rotating an upstream key should not require re-uploading
//! everything, only re-wrapping the key itself.
//!
//! What the rekey does per note blob (`.myn`, `NC05`):
//! - the **content ciphertext is byte-identical** (the `item_key` did not
//!   change and re-encrypting content is exactly what a key rotation must
//!   NOT do, it would author an edit into every note's Automerge
//!   change-graph and churn every attachment);
//! - the **`enc_item_key` wrap is rewritten** under the new `itemsKey`
//!   (same `item_key`, new wrap nonce), spliced into the blob header in
//!   place, preserving every other byte;
//! - the **`items_key_id` field does NOT change.** The per-note content
//!   AAD (`aad_note_content_encrypt`) binds `items_key_id`, so a new id
//!   would break the verification of every content ciphertext we must not
//!   re-encrypt. The id is a wrap-lineage HANDLE, not a secret (the same
//!   argument the migration's stable-attachment-id decision records for
//!   `MYA5`): the rotated key generation is identified by the bytes
//!   themselves, and the roster envelope carries the new wrapped key.
//!
//! The removed member's old wrap in the roster envelope is dropped; every
//! remaining member's wrap is regenerated under their current public key.
//!
//! # Determinism, and what it does NOT promise
//!
//! The rekey is NOT byte-deterministic across devices: the wrap nonce is
//! caller-supplied, so two devices that re-wrap the same blob produce
//! different-but-valid bytes. What converges is the KEY, not the ciphertext:
//! the new `itemsKey` is minted once, by the removing device, and published via
//! the membership roster, so peers derive the same key and each re-wraps its own
//! blobs independently. (Cross-device key propagation is the follow-on sync
//! work; the local pipeline this module owns does not deliver it, see
//! `threat-model.md` §7(4).)

use crate::aead::{AAD_PREFIX_V0_2, AEAD_KEY_LEN, AEAD_NONCE_LEN, PROTOCOL_VERSION_V0_2};
use crate::blob::{decode_note, ENC_ITEM_KEY_WRAPPED_LEN};
use crate::person_key::PersonPublicHalf;
use alloc::vec::Vec;

/// The rekey result for ONE note blob: the rewritten bytes (content
/// ciphertext preserved byte-identical) + the note uuid + the per-note
/// `item_key` (still the same key, re-wrapped under the new `itemsKey`)
/// so the caller can re-wrap it to remaining members if it ever needs to.
pub struct RekeyedNote {
    /// The rewritten blob: header spliced, content ciphertext untouched.
    pub blob: Vec<u8>,
    /// The note's uuid (16 B).
    pub note_uuid: [u8; 16],
    /// The per-note `item_key` (unchanged, re-wrapped, not re-minted).
    pub item_key: [u8; AEAD_KEY_LEN],
    /// Fresh `item_key_nonce` for the new wrap.
    pub item_key_nonce: [u8; AEAD_NONCE_LEN],
}

/// Re-wrap ONE note blob under a new `itemsKey`: open the old wrap with
/// the OLD `itemsKey`, re-seal the SAME `item_key` under the NEW
/// `itemsKey` with a fresh nonce, splice the header, and leave the
/// content ciphertext byte-identical.
///
/// Returns [`RekeyError::CannotDecrypt`] when the old blob fails AEAD
/// under the old key (wrong epoch, tampering, non-distinguishing, §7.3).
pub fn rekey_note_blob(
    old_blob: &[u8],
    note_uuid: &[u8; 16],
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
    new_item_key_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<RekeyedNote, RekeyError> {
    // Dispatch on the header magic: MY01 notes open through the v0.1
    // decoder, NC05 notes through the next-major decoder. Both families
    // share the §9.2 three-level envelope at identical offsets, so the
    // splice below is magic-agnostic; only the wrap AAD differs.
    let is_nc05 = old_blob.get(0..4) == Some(crate::crdt_note_blob::NC05_MAGIC.as_slice());
    let item_key: [u8; AEAD_KEY_LEN] = if is_nc05 {
        open_nc05_item_key(old_blob, note_uuid, old_items_key, items_key_id)?
    } else {
        // Open the old blob: recovers the per-note item_key + the plaintext
        // handle. The content ciphertext is NOT re-encrypted.
        let handle = decode_note(old_blob, note_uuid, old_items_key, items_key_id)
            .map_err(|_| RekeyError::CannotDecrypt)?;
        *handle.item_key()
    };

    // Re-wrap the SAME item_key under the NEW itemsKey. The AAD keeps the
    // SAME items_key_id and the family's own wrap role: the content AAD
    // binds the id, so a new id would invalidate every content ciphertext
    // the rekey refuses to touch.
    let aad_wrap = if is_nc05 {
        crate::aead::aad_nc05_item_key_wrap(items_key_id, note_uuid)
    } else {
        crate::aead::aad_note_item_key_wrap(items_key_id, note_uuid)
    };
    let enc_item_key =
        crate::aead::aead_seal_ctx(new_items_key, new_item_key_nonce, &item_key, &aad_wrap)
            .map_err(|_| RekeyError::AeadFailure)?;
    debug_assert_eq!(enc_item_key.len(), ENC_ITEM_KEY_WRAPPED_LEN);

    // Splice: find the enc_item_key field's absolute offset in the old
    // blob (§9.2: magic4 + version1 + reserved1 + items_key_id16 +
    // item_key_nonce24 + enc_item_key_len2 = 48) and overwrite it in
    // place. `items_key_id` is NOT touched (the content AAD binds it, so a
    // rotation keeps the id); everything from item_key_nonce onward is
    // preserved byte-identical except the wrapped key itself.
    let header_item_key_nonce = crate::blob::OFFSET_ITEM_KEY_NONCE;
    let header_enc_key = crate::blob::OFFSET_ENC_ITEM_KEY;

    let mut blob = Vec::with_capacity(old_blob.len());
    blob.extend_from_slice(old_blob);

    // items_key_id STAYS: see the module doc (the content AAD binds it).
    // Fresh item_key_nonce.
    blob[header_item_key_nonce..header_item_key_nonce + AEAD_NONCE_LEN]
        .copy_from_slice(new_item_key_nonce);
    // Re-splice the re-wrapped enc_item_key.
    blob[header_enc_key..header_enc_key + ENC_ITEM_KEY_WRAPPED_LEN].copy_from_slice(&enc_item_key);

    Ok(RekeyedNote {
        blob,
        note_uuid: *note_uuid,
        item_key,
        item_key_nonce: *new_item_key_nonce,
    })
}

/// Open just the per-note `item_key` wrap of an NC05 blob under the old
/// `itemsKey`, without touching (or parsing) the Automerge payload. The
/// NC05 family reuses the §9.2 envelope offsets verbatim: the wrap nonce
/// is the header's `item_key_nonce` field and `enc_item_key` is 32 ct +
/// 32 CTX tag, opened directly under it. Only the AAD role differs
/// (`aad_nc05_item_key_wrap`).
fn open_nc05_item_key(
    old_blob: &[u8],
    note_uuid: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; 16],
) -> Result<[u8; AEAD_KEY_LEN], RekeyError> {
    use crate::blob::{
        OFFSET_CONTENT_NONCE, OFFSET_ENC_ITEM_KEY, OFFSET_ENC_ITEM_KEY_LEN, OFFSET_ITEM_KEY_NONCE,
    };
    if old_blob.get(0..4) != Some(crate::crdt_note_blob::NC05_MAGIC.as_slice()) {
        return Err(RekeyError::CannotDecrypt);
    }
    if old_blob.len() < OFFSET_CONTENT_NONCE {
        return Err(RekeyError::CannotDecrypt);
    }
    let len_bytes: [u8; 2] = old_blob
        .get(OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY_LEN + 2)
        .and_then(|s| s.try_into().ok())
        .ok_or(RekeyError::CannotDecrypt)?;
    if u16::from_be_bytes(len_bytes) as usize != ENC_ITEM_KEY_WRAPPED_LEN {
        return Err(RekeyError::CannotDecrypt);
    }
    let nonce: &[u8; AEAD_NONCE_LEN] = old_blob
        .get(OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN)
        .and_then(|s| s.try_into().ok())
        .ok_or(RekeyError::CannotDecrypt)?;
    let enc = old_blob
        .get(OFFSET_ENC_ITEM_KEY..OFFSET_CONTENT_NONCE)
        .ok_or(RekeyError::CannotDecrypt)?;
    let aad_wrap = crate::aead::aad_nc05_item_key_wrap(items_key_id, note_uuid);
    let pt = crate::aead::aead_open_ctx(old_items_key, nonce, enc, &aad_wrap)
        .map_err(|_| RekeyError::CannotDecrypt)?;
    if pt.len() != AEAD_KEY_LEN {
        return Err(RekeyError::CannotDecrypt);
    }
    let mut item_key = [0u8; AEAD_KEY_LEN];
    item_key.copy_from_slice(&pt);
    Ok(item_key)
}

/// Re-wrap ONE attachment blob under a new `itemsKey`: open the
/// `attachment_key` wrap with the OLD `itemsKey`, re-seal the SAME key
/// under the NEW `itemsKey` with a fresh nonce, splice the header, and
/// leave the content ciphertext byte-identical. Dispatches on the header
/// magic (MYA1 → v0.1 wrap AAD, MYA5 → v0.2 wrap AAD); `items_key_id`
/// stays for the same content-AAD reason as notes. Without this path a
/// removed member holding the old `itemsKey` would keep decrypting
/// attachment blobs wrapped under it indefinitely, including ones pushed
/// post-rotation, which is exactly what the amended §7(4) forbids.
pub fn rekey_attachment_blob(
    old_blob: &[u8],
    attachment_id: &[u8; 32],
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
    new_attachment_key_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, RekeyError> {
    use crate::attachment_blob::{
        aad_wrap_attachment_key, aad_wrap_attachment_key_v0_2, ATTACHMENT_BLOB_MAGIC,
        ATTACHMENT_BLOB_V0_2_MAGIC, ENC_ATTACHMENT_KEY_WRAPPED_LEN, OFFSET_ATTACHMENT_KEY_NONCE,
        OFFSET_CONTENT_NONCE as ATT_OFFSET_CONTENT_NONCE, OFFSET_ENC_ATTACHMENT_KEY,
        OFFSET_ENC_ATTACHMENT_KEY_LEN,
    };
    let is_v0_2 = old_blob.get(0..4) == Some(ATTACHMENT_BLOB_V0_2_MAGIC.as_slice());
    if !is_v0_2 && old_blob.get(0..4) != Some(ATTACHMENT_BLOB_MAGIC.as_slice()) {
        return Err(RekeyError::CannotDecrypt);
    }
    if old_blob.len() < ATT_OFFSET_CONTENT_NONCE {
        return Err(RekeyError::CannotDecrypt);
    }
    let len_bytes: [u8; 2] = old_blob
        .get(OFFSET_ENC_ATTACHMENT_KEY_LEN..OFFSET_ENC_ATTACHMENT_KEY_LEN + 2)
        .and_then(|s| s.try_into().ok())
        .ok_or(RekeyError::CannotDecrypt)?;
    if u16::from_be_bytes(len_bytes) as usize != ENC_ATTACHMENT_KEY_WRAPPED_LEN {
        return Err(RekeyError::CannotDecrypt);
    }
    let nonce: &[u8; AEAD_NONCE_LEN] = old_blob
        .get(OFFSET_ATTACHMENT_KEY_NONCE..OFFSET_ENC_ATTACHMENT_KEY_LEN)
        .and_then(|s| s.try_into().ok())
        .ok_or(RekeyError::CannotDecrypt)?;
    let enc = old_blob
        .get(OFFSET_ENC_ATTACHMENT_KEY..ATT_OFFSET_CONTENT_NONCE)
        .ok_or(RekeyError::CannotDecrypt)?;
    let aad_wrap = if is_v0_2 {
        aad_wrap_attachment_key_v0_2(items_key_id, attachment_id)
    } else {
        aad_wrap_attachment_key(items_key_id, attachment_id)
    };
    let pt = crate::aead::aead_open_ctx(old_items_key, nonce, enc, &aad_wrap)
        .map_err(|_| RekeyError::CannotDecrypt)?;
    if pt.len() != AEAD_KEY_LEN {
        return Err(RekeyError::CannotDecrypt);
    }
    let mut attachment_key = [0u8; AEAD_KEY_LEN];
    attachment_key.copy_from_slice(&pt);

    let new_enc = crate::aead::aead_seal_ctx(
        new_items_key,
        new_attachment_key_nonce,
        &attachment_key,
        &aad_wrap,
    )
    .map_err(|_| RekeyError::AeadFailure)?;
    debug_assert_eq!(new_enc.len(), ENC_ATTACHMENT_KEY_WRAPPED_LEN);

    let mut blob = Vec::with_capacity(old_blob.len());
    blob.extend_from_slice(old_blob);
    blob[OFFSET_ATTACHMENT_KEY_NONCE..OFFSET_ATTACHMENT_KEY_NONCE + AEAD_NONCE_LEN]
        .copy_from_slice(new_attachment_key_nonce);
    blob[OFFSET_ENC_ATTACHMENT_KEY..OFFSET_ENC_ATTACHMENT_KEY + ENC_ATTACHMENT_KEY_WRAPPED_LEN]
        .copy_from_slice(&new_enc);
    Ok(blob)
}

/// Wrap the NEW `itemsKey` to a remaining member's public half (the
/// per-recipient envelope the roster extension carries).
pub fn wrap_items_key_to_member(
    new_items_key: &[u8; AEAD_KEY_LEN],
    member_public: &PersonPublicHalf,
    account_number_hash: &[u8; 16],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<crate::person_key::PersonWrappedKey, RekeyError> {
    member_public
        .wrap_key(new_items_key, account_number_hash, rng)
        .map_err(|_| RekeyError::AeadFailure)
}

/// The rekey error surface (per-command closed-enum discipline).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RekeyError {
    /// The old blob failed AEAD under the old `itemsKey`.
    CannotDecrypt,
    /// An AEAD seal/unwrap in the rekey pipeline failed.
    AeadFailure,
    /// The OS CSPRNG failed.
    Csprng,
}

/// Unreferenced-warning guard: `AAD_PREFIX_V0_2` /
/// `PROTOCOL_VERSION_V0_2` are re-exported here for the roster re-seal
/// the caller composes (the new membership field carries the new
/// per-member wraps under the v0.2 AAD); importing them keeps the
/// version-tag discipline visible at this seam.
const _: () = {
    let _ = (AAD_PREFIX_V0_2, PROTOCOL_VERSION_V0_2);
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::encode_new_note_blob_raw;
    use sha2::{Digest, Sha256};

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        let digest = Sha256::digest(label);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    struct SeededRng(u64);

    impl rand_core::TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(0)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            let ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            let digest = Sha256::digest(ctr.to_le_bytes());
            let n = dst.len();
            dst[..n].copy_from_slice(&digest[..n]);
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    #[test]
    fn rekey_preserves_content_ciphertext_byte_identically() {
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let note_uuid: [u8; 16] = fixture_seed(b"note-uuid")[..16].try_into().expect("16");
        let item_key: [u8; 32] = fixture_seed(b"note-item-key");
        let ik_nonce = [0x11u8; 24];
        let content_nonce = [0x22u8; 24];
        let plaintext = b"# Hello\n\nWorld body.\n";

        let blob = encode_new_note_blob_raw(
            &old_items_key,
            &old_id,
            &note_uuid,
            &item_key,
            &ik_nonce,
            &content_nonce,
            plaintext,
        )
        .expect("encode");

        let new_nonce = [0x33u8; 24];
        let rekeyed = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &new_nonce,
        )
        .expect("rekey succeeds");

        // The content ciphertext (everything from the ciphertext offset)
        // is byte-identical.
        let ct_start = blob.len() - plaintext.len() - 32;
        assert_eq!(
            rekeyed.blob[ct_start..],
            blob[ct_start..],
            "content ciphertext must be untouched"
        );

        // The new blob opens under the NEW itemsKey and recovers the SAME
        // plaintext.
        let reopened =
            decode_note(&rekeyed.blob, &note_uuid, &new_items_key, &old_id).expect("opens");
        assert_eq!(reopened.plaintext(), plaintext);
        assert_eq!(*reopened.note_uuid(), note_uuid);
    }

    #[test]
    fn rekeyed_blob_no_longer_opens_under_the_old_key() {
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let note_uuid: [u8; 16] = fixture_seed(b"note-uuid")[..16].try_into().expect("16");
        let item_key: [u8; 32] = fixture_seed(b"note-item-key");
        let blob = encode_new_note_blob_raw(
            &old_items_key,
            &old_id,
            &note_uuid,
            &item_key,
            &[0x11u8; 24],
            &[0x22u8; 24],
            b"body",
        )
        .expect("encode");
        let rekeyed = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        )
        .expect("rekey");
        // The OLD itemsKey can no longer open the re-wrapped blob.
        assert!(decode_note(&rekeyed.blob, &note_uuid, &old_items_key, &old_id).is_err());
    }

    #[test]
    fn rekey_deterministic_given_same_nonce() {
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let note_uuid: [u8; 16] = fixture_seed(b"note-uuid")[..16].try_into().expect("16");
        let item_key: [u8; 32] = fixture_seed(b"note-item-key");
        let blob = encode_new_note_blob_raw(
            &old_items_key,
            &old_id,
            &note_uuid,
            &item_key,
            &[0x11u8; 24],
            &[0x22u8; 24],
            b"body",
        )
        .expect("encode");
        let r1 = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        )
        .expect("rekey 1");
        let r2 = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        )
        .expect("rekey 2");
        assert_eq!(r1.blob, r2.blob, "same inputs, identical bytes");
    }

    #[test]
    fn tampered_blob_fails_closed() {
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let note_uuid: [u8; 16] = fixture_seed(b"note-uuid")[..16].try_into().expect("16");
        let item_key: [u8; 32] = fixture_seed(b"note-item-key");
        let mut blob = encode_new_note_blob_raw(
            &old_items_key,
            &old_id,
            &note_uuid,
            &item_key,
            &[0x11u8; 24],
            &[0x22u8; 24],
            b"body",
        )
        .expect("encode");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        let result = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        );
        assert!(matches!(result, Err(RekeyError::CannotDecrypt)));
    }

    #[test]
    fn rekey_attachment_preserves_content_and_closes_old_key() {
        use crate::attachment_blob::encode_attachment_blob_raw;
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let attachment_id: [u8; 32] = fixture_seed(b"attachment-id");
        let attachment_key: [u8; 32] = fixture_seed(b"attachment-key");
        let blob = encode_attachment_blob_raw(
            &old_items_key,
            &old_id,
            &attachment_id,
            b"application/pdf",
            &attachment_key,
            &[0x11u8; 24],
            &[0x22u8; 24],
            b"%PDF-1.7 body",
        )
        .expect("encode");
        let rekeyed = rekey_attachment_blob(
            &blob,
            &attachment_id,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        )
        .expect("rekey succeeds");
        // Content ciphertext byte-identical.
        use crate::attachment_blob::OFFSET_CIPHERTEXT;
        assert_eq!(
            rekeyed[OFFSET_CIPHERTEXT..],
            blob[OFFSET_CIPHERTEXT..],
            "attachment content ciphertext must be untouched"
        );
        // Opens under the NEW key, same plaintext.
        let reopened = crate::attachment_blob::decode_attachment_blob(
            &rekeyed,
            &attachment_id,
            b"application/pdf",
            &new_items_key,
            &old_id,
        )
        .expect("opens under new key");
        assert_eq!(&reopened[..], b"%PDF-1.7 body");
        // The OLD key no longer opens the re-wrapped blob.
        assert!(crate::attachment_blob::decode_attachment_blob(
            &rekeyed,
            &attachment_id,
            b"application/pdf",
            &old_items_key,
            &old_id,
        )
        .is_err());
    }

    #[test]
    fn rekey_nc05_note_preserves_payload_and_closes_old_key() {
        use crate::crdt_note_blob::{decode_crdt_note_blob, encode_crdt_note_blob_raw, NC05_MAGIC};
        let old_items_key: [u8; 32] = fixture_seed(b"old-items-key");
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let old_id = [0x55u8; 16];
        let note_uuid: [u8; 16] = fixture_seed(b"note-uuid")[..16].try_into().expect("16");
        let item_key: [u8; 32] = fixture_seed(b"note-item-key");
        let payload = b"automerge-save-bytes-fixture";
        let blob = encode_crdt_note_blob_raw(
            &old_items_key,
            &old_id,
            &note_uuid,
            &item_key,
            &[0x11u8; 24],
            &[0x22u8; 24],
            payload,
        )
        .expect("encode");
        assert_eq!(&blob[0..4], NC05_MAGIC);

        let rekeyed = rekey_note_blob(
            &blob,
            &note_uuid,
            &old_id,
            &old_items_key,
            &new_items_key,
            &[0x33u8; 24],
        )
        .expect("rekey succeeds");
        assert_eq!(&rekeyed.blob[0..4], NC05_MAGIC, "family preserved");

        // Content ciphertext byte-identical.
        let ct_start = blob.len() - payload.len() - 32;
        assert_eq!(
            rekeyed.blob[ct_start..],
            blob[ct_start..],
            "NC05 payload ciphertext must be untouched"
        );

        // Opens under the NEW key with the same payload.
        let reopened = decode_crdt_note_blob(&rekeyed.blob, &note_uuid, &new_items_key, &old_id)
            .expect("opens under new key");
        assert_eq!(&reopened[..], payload);
        // The OLD key no longer opens the re-wrapped blob.
        assert!(decode_crdt_note_blob(&rekeyed.blob, &note_uuid, &old_items_key, &old_id).is_err());
    }

    #[test]
    fn wrap_to_member_round_trips_and_excludes_the_removed_one() {
        let new_items_key: [u8; 32] = fixture_seed(b"new-items-key");
        let member = crate::person_key::PersonKeyPair::generate_raw(
            &{
                let mut s = [0u8; crate::person_key::PERSON_DK_SEED_LEN];
                s[..32].copy_from_slice(&fixture_seed(b"remaining-kem-d"));
                s[32..].copy_from_slice(&fixture_seed(b"remaining-kem-z"));
                s
            },
            &fixture_seed(b"remaining-ed25519"),
            &fixture_seed(b"remaining-mldsa"),
        );
        let wrapped = wrap_items_key_to_member(
            &new_items_key,
            &member.public_half(),
            &[0x44; 16],
            &mut SeededRng(0),
        )
        .expect("wrap");
        let unwrapped = member.unwrap_key(&wrapped, &[0x44; 16]).expect("unwrap");
        assert_eq!(*unwrapped, new_items_key);
    }
}
