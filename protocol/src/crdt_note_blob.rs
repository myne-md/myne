// SPDX-License-Identifier: AGPL-3.0-only
//! `NC05` next-major CRDT note-type blob codec (`docs/spec/protocol.md` § 10.7,
//! automerge-sync-migration epic, myne-md/myne#418 task 2).
//!
//! A CRDT note is stored under the **same § 9.2 three-level envelope layout** as
//! a `MY01` `.myn` note — magic · version · reserved · `items_key_id` ·
//! `item_key_nonce` · `enc_item_key` · `content_nonce` · `ciphertext_len` ·
//! `ciphertext` — reusing [`crate::blob`]'s offset constants verbatim as the
//! single layout source. It differs from `MY01` in exactly three load-bearing
//! ways, all of which domain-separate the next major from v0.1:
//!
//! 1. the 4-byte magic is [`NC05_MAGIC`] (`b"NC05"`), not `b"MY01"`;
//! 2. the header `protocol_version` byte is [`NC05_PROTOCOL_VERSION`] (`0x02`);
//! 3. both AEAD tags bind the **next-major AAD prefix** `"myne.v0.2|"` +
//!    version `0x02` (via [`crate::aead::aad_nc05_item_key_wrap`] /
//!    [`crate::aead::aad_nc05_content_encrypt`]), so an `NC05` tag never
//!    verifies under a v0.1 AAD and vice versa.
//!
//! The inner plaintext is **opaque** — the caller supplies the note's Automerge
//! `save()` bytes (`myne-core`'s `notes::crdt` bridge) and this codec never
//! parses them, exactly like `vault.search` / `vault.workspace`. `content_type`
//! stays the hardcoded `"text/markdown"` (the magic, not the AAD, is the codec
//! discriminator). This codec derives **no** subkey (the per-note `item_key` is
//! random, wrapped under the caller-supplied `items_key`), so it adds no
//! `SubkeyRole` — the v0.2 key hierarchy is the migration layer's concern (#420).

use crate::aead::{
    aad_nc05_content_encrypt, aad_nc05_item_key_wrap, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::blob::{
    ENC_ITEM_KEY_WRAPPED_LEN, ITEMS_KEY_ID_LEN, NOTE_UUID_LEN, OFFSET_CIPHERTEXT,
    OFFSET_CIPHERTEXT_LEN, OFFSET_CONTENT_NONCE, OFFSET_ENC_ITEM_KEY, OFFSET_ENC_ITEM_KEY_LEN,
    OFFSET_ITEMS_KEY_ID, OFFSET_ITEM_KEY_NONCE, OFFSET_PROTOCOL_VERSION, OFFSET_RESERVED,
    RESERVED_BYTE,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use zeroize::Zeroizing;

/// `NC05` per-note CRDT blob magic (`protocol.md` § 10.3 registry — finalized
/// from the reserved placeholder). Extension `.myn` unchanged (the magic, read
/// from the cleartext header, is what a reader dispatches on).
pub const NC05_MAGIC: &[u8; 4] = b"NC05";

/// Header `protocol_version` byte for the `NC05` family (offset 4) — `0x02`, the
/// next major. Equals [`crate::aead::PROTOCOL_VERSION_V0_2`] (asserted in tests).
pub const NC05_PROTOCOL_VERSION: u8 = 0x02;

/// Per-note opaque-payload cap (§ 9.2 per-note bound, 16 MiB). A CRDT note's
/// Automerge `save()` grows with edit history (unbounded for now, ASM-12→B;
/// bounding is #423), so the cap is the pre-AEAD backstop against an oversized
/// blob rather than a content-size limit.
pub const NC05_MAX_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

/// Single-variant public decode failure — the § 6.4 non-distinguishing collapse
/// for the IPC surface. The distinguishable [`CrdtNoteBlobCause`] stays crate-
/// internal for the tampering tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CannotDecryptCrdtNote;

/// Crate-internal distinguishable decode cause, mirroring [`crate::blob`]'s
/// `DecryptCause`: the tampering tests assert specific causes; the public
/// [`decode_crdt_note_blob`] collapses them all to [`CannotDecryptCrdtNote`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CrdtNoteBlobCause {
    /// A pre-decryption structural reject (§ 6.4 step 1): truncation, magic,
    /// version, reserved byte, `enc_item_key_len`, size cap, strict-trailing.
    Parse,
    /// `items_key_id` in the header does not match the caller's (§ 6.4 step 2).
    ItemsKeyIdMismatch,
    /// The outer AEAD unwrap of `item_key` under `itemsKey` failed (§ 6.4 step 3).
    OuterAead,
    /// The inner AEAD decrypt of the opaque payload under `item_key` failed
    /// (§ 6.4 step 4).
    InnerAead,
}

/// Encode an `NC05` CRDT note blob from caller-supplied randomness (`_raw`: the
/// caller MUST source `item_key`, `item_key_nonce`, `content_nonce` from a
/// CSPRNG and never reuse a nonce under a fixed key — see the crate's `_raw`
/// convention). `plaintext` is the note's opaque Automerge `save()` bytes.
///
/// **Errors:** [`ProtocolError::PlaintextTooLarge`] if the payload exceeds
/// [`NC05_MAX_PLAINTEXT_LEN`]; [`ProtocolError::AeadFailure`] on a seal error.
#[allow(clippy::too_many_arguments)]
pub fn encode_crdt_note_blob_raw(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    note_uuid: &[u8; NOTE_UUID_LEN],
    item_key: &[u8; AEAD_KEY_LEN],
    item_key_nonce: &[u8; AEAD_NONCE_LEN],
    content_nonce: &[u8; AEAD_NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if plaintext.len() > NC05_MAX_PLAINTEXT_LEN {
        return Err(ProtocolError::PlaintextTooLarge);
    }

    // (1) Wrap item_key under itemsKey with the next-major AAD.
    let aad_wrap = aad_nc05_item_key_wrap(items_key_id, note_uuid);
    let enc_item_key = aead_seal_ctx(items_key, item_key_nonce, item_key, &aad_wrap)?;
    debug_assert_eq!(enc_item_key.len(), ENC_ITEM_KEY_WRAPPED_LEN);

    // (2) Encrypt the opaque payload under item_key with the next-major AAD.
    let aad_content = aad_nc05_content_encrypt(items_key_id, note_uuid);
    let ciphertext = aead_seal_ctx(item_key, content_nonce, plaintext, &aad_content)?;
    debug_assert_eq!(ciphertext.len(), plaintext.len() + CTX_COMMITMENT_TAG_LEN);

    // (3) Assemble the § 9.2 byte sequence with the NC05 magic + version.
    let total_len = OFFSET_CIPHERTEXT + ciphertext.len();
    let mut blob = Vec::with_capacity(total_len);
    blob.extend_from_slice(NC05_MAGIC);
    blob.push(NC05_PROTOCOL_VERSION);
    blob.push(RESERVED_BYTE);
    blob.extend_from_slice(items_key_id);
    blob.extend_from_slice(item_key_nonce);
    blob.extend_from_slice(&(ENC_ITEM_KEY_WRAPPED_LEN as u16).to_be_bytes());
    blob.extend_from_slice(&enc_item_key);
    blob.extend_from_slice(content_nonce);
    let ciphertext_len_u32 =
        u32::try_from(ciphertext.len()).map_err(|_| ProtocolError::PlaintextTooLarge)?;
    blob.extend_from_slice(&ciphertext_len_u32.to_be_bytes());
    blob.extend_from_slice(&ciphertext);

    debug_assert_eq!(blob.len(), total_len);
    Ok(blob)
}

/// Encode an `NC05` CRDT note blob, sourcing `item_key` + both nonces from
/// `getrandom` (the production convenience wrapper). `plaintext` is the note's
/// opaque Automerge `save()` bytes.
///
/// **Errors:** [`ProtocolError::Csprng`] if the OS/Worker entropy source fails;
/// otherwise as [`encode_crdt_note_blob_raw`].
pub fn encode_crdt_note_blob(
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
    note_uuid: &[u8; NOTE_UUID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    let mut item_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    getrandom::getrandom(item_key.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;
    let mut item_key_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut item_key_nonce).map_err(|_| ProtocolError::Csprng)?;
    let mut content_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut content_nonce).map_err(|_| ProtocolError::Csprng)?;
    encode_crdt_note_blob_raw(
        items_key,
        items_key_id,
        note_uuid,
        &item_key,
        &item_key_nonce,
        &content_nonce,
        plaintext,
    )
}

/// Decode an `NC05` CRDT note blob to its opaque Automerge payload bytes, or
/// [`CannotDecryptCrdtNote`] (the single-variant § 6.4 collapse). The returned
/// bytes are `Zeroizing` — they are decrypted note content.
pub fn decode_crdt_note_blob(
    blob: &[u8],
    note_uuid: &[u8; NOTE_UUID_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<Zeroizing<Vec<u8>>, CannotDecryptCrdtNote> {
    decode_crdt_note_blob_with_cause(blob, note_uuid, items_key, items_key_id).map_err(|cause| {
        tracing::debug!(stage = ?cause, "decode_crdt_note_blob failed");
        CannotDecryptCrdtNote
    })
}

/// Crate-internal decode returning the distinguishable [`CrdtNoteBlobCause`].
/// Implements § 6.4 in order: parse checks (step 1) → `items_key_id` (step 2) →
/// outer AEAD unwrap (step 3) → inner AEAD decrypt (step 4).
pub(crate) fn decode_crdt_note_blob_with_cause(
    blob: &[u8],
    note_uuid: &[u8; NOTE_UUID_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; ITEMS_KEY_ID_LEN],
) -> Result<Zeroizing<Vec<u8>>, CrdtNoteBlobCause> {
    // ---- Step 1: parse-level checks ----
    if blob.len() < OFFSET_CIPHERTEXT {
        return Err(CrdtNoteBlobCause::Parse);
    }
    if &blob[0..NC05_MAGIC.len()] != NC05_MAGIC {
        return Err(CrdtNoteBlobCause::Parse);
    }
    if blob[OFFSET_PROTOCOL_VERSION] != NC05_PROTOCOL_VERSION {
        return Err(CrdtNoteBlobCause::Parse);
    }
    if blob[OFFSET_RESERVED] != RESERVED_BYTE {
        return Err(CrdtNoteBlobCause::Parse);
    }
    let enc_item_key_len = u16::from_be_bytes(
        blob[OFFSET_ENC_ITEM_KEY_LEN..OFFSET_ENC_ITEM_KEY]
            .try_into()
            .expect("2-byte slice fits a [u8; 2] by construction"),
    ) as usize;
    if enc_item_key_len != ENC_ITEM_KEY_WRAPPED_LEN {
        return Err(CrdtNoteBlobCause::Parse);
    }
    let ciphertext_len = u32::from_be_bytes(
        blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .try_into()
            .expect("4-byte slice fits a [u8; 4] by construction"),
    ) as usize;
    if ciphertext_len < CTX_COMMITMENT_TAG_LEN {
        return Err(CrdtNoteBlobCause::Parse);
    }
    // Cap check BEFORE allocation (mirrors § 9.2).
    if ciphertext_len > NC05_MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(CrdtNoteBlobCause::Parse);
    }
    // Strict-trailing (§ 10.1): the blob length MUST equal the declared layout.
    let expected_total = OFFSET_CIPHERTEXT + ciphertext_len;
    if blob.len() != expected_total {
        return Err(CrdtNoteBlobCause::Parse);
    }

    // ---- Step 2: items_key_id mismatch ----
    if &blob[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE] != items_key_id.as_slice() {
        return Err(CrdtNoteBlobCause::ItemsKeyIdMismatch);
    }

    // ---- Step 3: outer AEAD — unwrap item_key under itemsKey ----
    let item_key_nonce: [u8; AEAD_NONCE_LEN] = blob[OFFSET_ITEM_KEY_NONCE..OFFSET_ENC_ITEM_KEY_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let enc_item_key_bytes = &blob[OFFSET_ENC_ITEM_KEY..OFFSET_CONTENT_NONCE];
    let aad_wrap = aad_nc05_item_key_wrap(items_key_id, note_uuid);
    let item_key_zeroizing =
        aead_open_ctx(items_key, &item_key_nonce, enc_item_key_bytes, &aad_wrap)
            .map_err(|_| CrdtNoteBlobCause::OuterAead)?;
    if item_key_zeroizing.len() != AEAD_KEY_LEN {
        return Err(CrdtNoteBlobCause::OuterAead);
    }
    let mut item_key = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    item_key.copy_from_slice(&item_key_zeroizing);

    // ---- Step 4: inner AEAD — decrypt the opaque payload under item_key ----
    let content_nonce: [u8; AEAD_NONCE_LEN] = blob[OFFSET_CONTENT_NONCE..OFFSET_CIPHERTEXT_LEN]
        .try_into()
        .expect("24-byte slice fits AEAD_NONCE_LEN by construction");
    let ciphertext_bytes = &blob[OFFSET_CIPHERTEXT..];
    let aad_content = aad_nc05_content_encrypt(items_key_id, note_uuid);
    aead_open_ctx(&item_key, &content_nonce, ciphertext_bytes, &aad_content)
        .map_err(|_| CrdtNoteBlobCause::InnerAead)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::{aad_note_item_key_wrap, PROTOCOL_VERSION_V0_2};

    const ITEMS_KEY: [u8; AEAD_KEY_LEN] = [0x11; AEAD_KEY_LEN];
    const ITEMS_KEY_ID: [u8; ITEMS_KEY_ID_LEN] = [0x22; ITEMS_KEY_ID_LEN];
    const NOTE_UUID: [u8; NOTE_UUID_LEN] = [0x33; NOTE_UUID_LEN];
    const ITEM_KEY: [u8; AEAD_KEY_LEN] = [0x44; AEAD_KEY_LEN];
    const ITEM_KEY_NONCE: [u8; AEAD_NONCE_LEN] = [0x55; AEAD_NONCE_LEN];
    const CONTENT_NONCE: [u8; AEAD_NONCE_LEN] = [0x66; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_crdt_note_blob_raw(
            &ITEMS_KEY,
            &ITEMS_KEY_ID,
            &NOTE_UUID,
            &ITEM_KEY,
            &ITEM_KEY_NONCE,
            &CONTENT_NONCE,
            plaintext,
        )
        .expect("encode")
    }

    #[test]
    fn version_byte_matches_aead_next_major_constant() {
        assert_eq!(NC05_PROTOCOL_VERSION, PROTOCOL_VERSION_V0_2);
        assert_eq!(NC05_MAGIC, b"NC05");
    }

    #[test]
    fn round_trips_opaque_payloads_byte_for_byte() {
        for payload in [
            b"".as_slice(),
            b"opaque automerge save() bytes \x00\x01\x02\xff".as_slice(),
            &[0xABu8; 4096],
        ] {
            let blob = encode(payload);
            // Header discriminators are exactly the NC05 family's.
            assert_eq!(&blob[0..4], NC05_MAGIC);
            assert_eq!(blob[OFFSET_PROTOCOL_VERSION], NC05_PROTOCOL_VERSION);
            let out = decode_crdt_note_blob(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID)
                .expect("decode");
            assert_eq!(out.as_slice(), payload);
        }
    }

    #[test]
    fn nc05_wrap_tag_does_not_verify_under_the_v0_1_aad() {
        // Domain separation (§ 10.5): the same item_key sealed under the NC05
        // (v0.2) item-key-wrap AAD MUST NOT open under the v0.1 AAD.
        let aad_v0_2 = aad_nc05_item_key_wrap(&ITEMS_KEY_ID, &NOTE_UUID);
        let sealed =
            aead_seal_ctx(&ITEMS_KEY, &ITEM_KEY_NONCE, &ITEM_KEY, &aad_v0_2).expect("seal");
        let aad_v0_1 = aad_note_item_key_wrap(&ITEMS_KEY_ID, &NOTE_UUID);
        assert!(
            aead_open_ctx(&ITEMS_KEY, &ITEM_KEY_NONCE, &sealed, &aad_v0_1).is_err(),
            "an NC05 wrap tag must not verify under the v0.1 prefix"
        );
        // And it DOES open under its own AAD (control).
        assert!(aead_open_ctx(&ITEMS_KEY, &ITEM_KEY_NONCE, &sealed, &aad_v0_2).is_ok());
    }

    #[test]
    fn a_my01_magic_is_rejected_as_parse() {
        let mut blob = encode(b"payload");
        blob[0..4].copy_from_slice(b"MY01"); // wrong family magic
        assert_eq!(
            decode_crdt_note_blob_with_cause(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::Parse)
        );
    }

    #[test]
    fn version_reserved_and_trailing_tampers_are_parse() {
        let base = encode(b"payload");

        let mut wrong_version = base.clone();
        wrong_version[OFFSET_PROTOCOL_VERSION] = 0x01; // v0.1 byte in an NC05 blob
        assert_eq!(
            decode_crdt_note_blob_with_cause(&wrong_version, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::Parse)
        );

        let mut nonzero_reserved = base.clone();
        nonzero_reserved[OFFSET_RESERVED] = 0x01;
        assert_eq!(
            decode_crdt_note_blob_with_cause(
                &nonzero_reserved,
                &NOTE_UUID,
                &ITEMS_KEY,
                &ITEMS_KEY_ID
            ),
            Err(CrdtNoteBlobCause::Parse)
        );

        let mut trailing = base.clone();
        trailing.push(0x00); // one trailing byte
        assert_eq!(
            decode_crdt_note_blob_with_cause(&trailing, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::Parse)
        );
    }

    #[test]
    fn oversized_ciphertext_len_field_is_rejected_before_alloc() {
        // A declared `ciphertext_len` one byte past the §9.2 cap must be
        // refused by the cap check (line 213), and this fixture makes that the
        // ONLY check that can return `Parse`: the blob is padded so the
        // strict-trailing check passes (`blob.len() == declared layout`), and
        // the items_key_id is zeroed so that WITHOUT the cap the very next
        // check would return the distinct `ItemsKeyIdMismatch`. So the
        // assertion is falsifiable in a way the previous form was not, where
        // the trailing check masked the cap with the same `Parse`. Restored
        // after the myne-md/myne#802 audit flagged the cap as the one
        // collapsing-cause family (audit Part 1 #25).
        let mut blob = encode(b"payload");
        let declared = NC05_MAX_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1;
        blob[OFFSET_CIPHERTEXT_LEN..OFFSET_CIPHERTEXT]
            .copy_from_slice(&(declared as u32).to_be_bytes());
        blob.resize(OFFSET_CIPHERTEXT + declared, 0);
        blob[OFFSET_ITEMS_KEY_ID..OFFSET_ITEM_KEY_NONCE].fill(0);
        assert_eq!(
            decode_crdt_note_blob_with_cause(&blob, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::Parse)
        );
    }

    #[test]
    fn items_key_id_mismatch_is_distinguished() {
        let blob = encode(b"payload");
        let other_id = [0x77u8; ITEMS_KEY_ID_LEN];
        assert_eq!(
            decode_crdt_note_blob_with_cause(&blob, &NOTE_UUID, &ITEMS_KEY, &other_id),
            Err(CrdtNoteBlobCause::ItemsKeyIdMismatch)
        );
    }

    #[test]
    fn wrong_items_key_fails_the_outer_aead() {
        let blob = encode(b"payload");
        let wrong_items_key = [0x99u8; AEAD_KEY_LEN];
        assert_eq!(
            decode_crdt_note_blob_with_cause(&blob, &NOTE_UUID, &wrong_items_key, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::OuterAead)
        );
    }

    #[test]
    fn wrong_note_uuid_fails_the_outer_aead() {
        // note_uuid is AAD-bound into the wrap; a mismatch fails the outer AEAD.
        let blob = encode(b"payload");
        let other_uuid = [0x88u8; NOTE_UUID_LEN];
        assert_eq!(
            decode_crdt_note_blob_with_cause(&blob, &other_uuid, &ITEMS_KEY, &ITEMS_KEY_ID),
            Err(CrdtNoteBlobCause::OuterAead)
        );
    }

    /// Emits `myne-test-vectors/vectors/crdt-note-blob/v0.2/cases.json` to
    /// `/tmp/myne_crdt_note_blob_vectors.json` (automerge-sync-migration #418 t4).
    /// `#[ignore]` — run with:
    /// `cargo test -p protocol --lib emit_crdt_note_blob_vectors_for_paste -- --ignored`
    ///
    /// Cross-implementation contract for the `NC05` next-major (v0.2) note codec:
    /// `encrypt` (full byte output of `encode_crdt_note_blob_raw`), `decrypt_ok`
    /// (round-trip of the opaque payload), `decrypt_aead_fail` (wrong items_key +
    /// the **v0.1-AAD domain-separation** case — an `NC05` tag must not verify under
    /// the v0.1 prefix), `parse_fail` (magic / version / reserved / strict-trailing
    /// structural rejects), and `aad_construction` (both `aad_nc05_*` builders).
    #[test]
    #[ignore]
    fn emit_crdt_note_blob_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::{hex_lower, json_escape};

        // Distinct byte patterns per field (visual cross-check), fixed so the
        // output is byte-stable across runs.
        let items_key: [u8; AEAD_KEY_LEN] = [0x11; 32];
        let other_items_key: [u8; AEAD_KEY_LEN] = [0x99; 32];
        let items_key_id: [u8; ITEMS_KEY_ID_LEN] = [0x22; 16];
        let note_uuid: [u8; NOTE_UUID_LEN] = [0x33; 16];
        let item_key: [u8; AEAD_KEY_LEN] = [0x44; 32];
        let item_key_nonce: [u8; AEAD_NONCE_LEN] = [0x55; 24];
        let content_nonce: [u8; AEAD_NONCE_LEN] = [0x66; 24];
        // Opaque Automerge save() stand-in (the codec never parses it).
        let payload: &[u8] = b"automerge save() opaque bytes \x00\x01\x02\xff for the NC05 vector";

        let seal = |pt: &[u8]| {
            encode_crdt_note_blob_raw(
                &items_key,
                &items_key_id,
                &note_uuid,
                &item_key,
                &item_key_nonce,
                &content_nonce,
                pt,
            )
            .expect("encode")
        };
        let blob = seal(payload);
        // Round-trip sanity.
        assert_eq!(
            decode_crdt_note_blob(&blob, &note_uuid, &items_key, &items_key_id)
                .expect("decode")
                .as_slice(),
            payload
        );

        // decrypt_aead_fail (a): the v0.1-AAD domain-separation case. The SAME
        // item_key sealed under the NC05 v0.2 wrap AAD must not open under v0.1.
        let aad_v0_1 = aad_note_item_key_wrap(&items_key_id, &note_uuid);
        let v0_1_wrap_of_item_key =
            crate::aead::aead_seal_ctx(&items_key, &item_key_nonce, &item_key, &aad_v0_1)
                .expect("seal under v0.1 aad");
        // A hand-forged blob whose enc_item_key was sealed under the v0.1 AAD:
        // its outer unwrap fails under the NC05 (v0.2) decoder. Splice the v0.1
        // wrap into an otherwise-valid NC05 blob.
        let mut v0_1_aad_blob = blob.clone();
        v0_1_aad_blob[OFFSET_ENC_ITEM_KEY..OFFSET_CONTENT_NONCE]
            .copy_from_slice(&v0_1_wrap_of_item_key);

        // parse_fail fixtures.
        let mut magic_tamper = blob.clone();
        magic_tamper[0..4].copy_from_slice(b"MY01"); // v0.1 magic
        let mut version_tamper = blob.clone();
        version_tamper[OFFSET_PROTOCOL_VERSION] = 0x01; // v0.1 version byte
        let mut reserved_tamper = blob.clone();
        reserved_tamper[OFFSET_RESERVED] = 0x01;
        let mut trailing = blob.clone();
        trailing.push(0x00);

        let aad_wrap = aad_nc05_item_key_wrap(&items_key_id, &note_uuid);
        let aad_content = aad_nc05_content_encrypt(&items_key_id, &note_uuid);

        // Sanity-assert each negative before emitting it.
        assert!(
            decode_crdt_note_blob(&v0_1_aad_blob, &note_uuid, &items_key, &items_key_id).is_err()
        );
        assert!(decode_crdt_note_blob(&blob, &note_uuid, &other_items_key, &items_key_id).is_err());
        for b in [&magic_tamper, &version_tamper, &reserved_tamper, &trailing] {
            assert!(decode_crdt_note_blob(b, &note_uuid, &items_key, &items_key_id).is_err());
        }

        let mut d = std::string::String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"crdt-note-blob\",\n");
        d.push_str("  \"protocol_version\": \"v0.2\",\n");
        d.push_str("  \"spec_section\": \"protocol.md \u{00a7}10.7 + \u{00a7}5.2\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_crdt_note_blob_raw + decode_crdt_note_blob (NC05 next-major CRDT note-type, v0.2) and the two aad_nc05_* builders. Same \u{00a7}9.2 three-level envelope as MY01 with three changes: magic NC05, protocol_version 0x02, and both AEAD tags binding the v0.2 AAD prefix 'myne.v0.2|'. The inner plaintext is OPAQUE (the note's Automerge save() bytes) — never parsed. Reference impl: protocol/src/crdt_note_blob.rs.\",\n");
        d.push_str("  \"cases\": [\n");

        // encrypt
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"crdt-note-blob/v0.2/encrypt\",\n");
        d.push_str("      \"description\": \"Encode an opaque payload to an NC05 blob; pins full byte output.\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&std::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"input_item_key_hex\": \"{}\",\n",
            hex_lower(&item_key)
        ));
        d.push_str(&std::format!(
            "      \"input_item_key_nonce_hex\": \"{}\",\n",
            hex_lower(&item_key_nonce)
        ));
        d.push_str(&std::format!(
            "      \"input_content_nonce_hex\": \"{}\",\n",
            hex_lower(&content_nonce)
        ));
        d.push_str(&std::format!(
            "      \"input_plaintext_hex\": \"{}\",\n",
            hex_lower(payload)
        ));
        d.push_str(&std::format!(
            "      \"expected_blob_hex\": \"{}\"\n",
            hex_lower(&blob)
        ));
        d.push_str("    },\n");

        // decrypt_ok
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"crdt-note-blob/v0.2/decrypt-ok\",\n");
        d.push_str(
            "      \"description\": \"Decode the NC05 blob back to its opaque payload.\",\n",
        );
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&std::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&std::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(payload)
        ));
        d.push_str("    },\n");

        // decrypt_aead_fail: v0.1-AAD domain separation
        d.push_str("    {\n");
        d.push_str(
            "      \"vector_id\": \"crdt-note-blob/v0.2/decrypt-fail-v0_1-aad-domain-sep\",\n",
        );
        d.push_str("      \"description\": \"The enc_item_key was sealed under the v0.1 wrap AAD; the NC05 (v0.2) decoder's outer unwrap fails — an NC05 tag must never verify under 'myne.v0.1|' (\u{00a7}10.5 domain separation).\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&std::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&v0_1_aad_blob)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&items_key)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // decrypt_aead_fail: wrong items_key
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"crdt-note-blob/v0.2/decrypt-fail-wrong-items-key\",\n");
        d.push_str("      \"description\": \"Valid NC05 blob, wrong itemsKey (cross-vault) — non-distinguishing AEAD failure (\u{00a7}6.4).\",\n");
        d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        d.push_str(&std::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_hex\": \"{}\",\n",
            hex_lower(&other_items_key)
        ));
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str("      \"expected_kind\": \"aead_fail\"\n");
        d.push_str("    },\n");

        // parse_fail cases
        struct Pf<'a> {
            slug: &'a str,
            desc: &'a str,
            blob: &'a [u8],
        }
        let pfs = [
            Pf { slug: "parse-fail-my01-magic", desc: "MY01 (v0.1) magic in an NC05 slot — a v0.2 decoder rejects the wrong family magic before decrypting.", blob: &magic_tamper },
            Pf { slug: "parse-fail-v0_1-version", desc: "protocol_version 0x01 (v0.1) in an NC05 blob — rejected at parse.", blob: &version_tamper },
            Pf { slug: "parse-fail-reserved-nonzero", desc: "reserved byte set to 0x01 — unconditional reject.", blob: &reserved_tamper },
            Pf { slug: "parse-fail-trailing-byte", desc: "one 0x00 appended after a valid blob — strict-trailing (\u{00a7}10.3.1) rejects; a tolerant port decodes Ok and the runner catches it.", blob: &trailing },
        ];
        for pf in &pfs {
            d.push_str("    {\n");
            d.push_str(&std::format!(
                "      \"vector_id\": \"crdt-note-blob/v0.2/{}\",\n",
                pf.slug
            ));
            d.push_str(&std::format!(
                "      \"description\": \"{}\",\n",
                json_escape(pf.desc)
            ));
            d.push_str("      \"case_kind\": \"parse_fail\",\n");
            d.push_str(&std::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(pf.blob)
            ));
            d.push_str(&std::format!(
                "      \"input_note_uuid_hex\": \"{}\",\n",
                hex_lower(&note_uuid)
            ));
            d.push_str(&std::format!(
                "      \"input_items_key_hex\": \"{}\",\n",
                hex_lower(&items_key)
            ));
            d.push_str(&std::format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                hex_lower(&items_key_id)
            ));
            d.push_str("      \"expected_kind\": \"parse_fail\"\n");
            d.push_str("    },\n");
        }

        // aad_construction: wrap + content
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"crdt-note-blob/v0.2/aad-nc05-item-key-wrap\",\n");
        d.push_str("      \"description\": \"aad_nc05_item_key_wrap canonical bytes: 'myne.v0.2|' || 0x02 || items_key_id(16) || note_uuid(16).\",\n");
        d.push_str("      \"case_kind\": \"aad_construction\",\n");
        d.push_str("      \"input_aad_builder\": \"aad_nc05_item_key_wrap\",\n");
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad_wrap)
        ));
        d.push_str("    },\n");

        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"crdt-note-blob/v0.2/aad-nc05-content-encrypt\",\n");
        d.push_str("      \"description\": \"aad_nc05_content_encrypt canonical bytes: 'myne.v0.2|' || 0x02 || items_key_id(16) || note_uuid(16) || u16_be(13)||'text/markdown'.\",\n");
        d.push_str("      \"case_kind\": \"aad_construction\",\n");
        d.push_str("      \"input_aad_builder\": \"aad_nc05_content_encrypt\",\n");
        d.push_str(&std::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        ));
        d.push_str(&std::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        ));
        d.push_str(&std::format!(
            "      \"expected_aad_hex\": \"{}\"\n",
            hex_lower(&aad_content)
        ));
        d.push_str("    }\n");

        d.push_str("  ]\n");
        d.push_str("}\n");

        std::fs::write("/tmp/myne_crdt_note_blob_vectors.json", d.as_bytes())
            .expect("write crdt-note-blob vectors dump");
    }
}
