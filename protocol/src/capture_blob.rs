// SPDX-License-Identifier: AGPL-3.0

//! `captures/<capture-id>` pending-capture blob codec (`MYK1`;
//! `agent-tooling/docs/spec/protocol.md` § 9.18).
//!
//! A **pending capture** is a short piece of dictated note text that arrives
//! from the paired Apple Watch (via WatchConnectivity) while the phone's vault
//! may be **locked**. It cannot be written into the vault yet (that needs the
//! unlocked `items_key`), so it is held in a **device-local encrypted queue**
//! until the next unlock, when it is drained into the vault as a new note.
//!
//! Like `vault.quickunlock` (`MYQ1`, § 9.14), this blob is sealed under a
//! **device-local `wrap_key`** — a random 32-byte key held in the OS keychain,
//! NOT a `DeriveSubkey(root_key, …)` subkey. The queue is created while the
//! vault is locked and is **vault-agnostic**: it does not know which vault the
//! capture will land in, so — unlike every § 9 vault blob — it binds neither an
//! `account_number_hash` nor an `items_key_id`. Instead it binds the per-entry
//! **`capture_id`** (a random UUIDv7, also the queue filename) into the AAD, so
//! a tampered header `capture_id` fails AEAD rather than silently re-labelling
//! the entry.
//!
//! Note the limit of that property, because it is easy to over-read: the AAD
//! binds the id in the **header**, not the id in the **filename**. Renaming a
//! sealed file, or copying it to a second name, produces a blob that still
//! opens — its header and AAD are internally consistent and the seal was never
//! broken. Preventing a copy from draining twice is therefore a reader-side
//! check (§ 9.18.4), not something this construction guarantees.
//!
//! The codec is **provider-agnostic**: it only ever sees a symmetric
//! `wrap_key`. There is **no `SubkeyRole`** (a `root_key`-derived KEK would be
//! wrong here — the whole point is that the queue survives while `root_key` is
//! unavailable). The plaintext is arbitrary-length UTF-8 (a dictated note),
//! capped at [`MAX_CAPTURE_PLAINTEXT_LEN`] — the variable-length twist relative
//! to `MYQ1`'s fixed 64-byte payload.
//!
//! ## On-disk layout (spec § 9.18.1)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  ------------------------------------
//! 0       4     magic             ASCII "MYK1"
//! 4       1     protocol_version  0x01
//! 5       16    capture_id        random UUIDv7; ALSO the queue filename; AAD-bound
//! 21      24    wrap_nonce        XChaCha20-Poly1305 nonce
//! 45      4     ciphertext_len    big-endian uint32, = plaintext_len + 32
//! 49      ..    ciphertext        dictated UTF-8 AEAD-sealed + 32-byte CTX tag
//! ```
//!
//! Header = 49 bytes. `capture_id` sits in the public header (it is the queue
//! filename) AND is bound into the AAD (§ 9.18.3), so tampering with the header
//! `capture_id` fails AEAD rather than silently re-labelling the entry.

use crate::aead::{
    aad_capture_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYK1"` (Myne capture v1; `K` because `C`
/// is taken by the `MYC1` attachments catalog).
pub const CAPTURE_BLOB_MAGIC: [u8; 4] = *b"MYK1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const CAPTURE_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// Length of the 16-byte `capture_id` (a UUIDv7) carried in the header and
/// bound into the AAD.
pub const CAPTURE_ID_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + capture_id 16 + nonce 24 +
/// len 4).
pub const CAPTURE_BLOB_HEADER_LEN: usize = 49;

/// Maximum dictated-text plaintext a single capture may carry (16 KiB). A
/// dictated note is short; the cap bounds a hostile `ciphertext_len` and mirrors
/// the [`crate::prefs::MAX_PREFS_PLAINTEXT_LEN`] discipline. The decoder rejects
/// `ciphertext_len > MAX_CAPTURE_PLAINTEXT_LEN + 32` before allocating. See spec
/// § 9.18.4.
pub const MAX_CAPTURE_PLAINTEXT_LEN: usize = 16 * 1024;

/// Public (pre-decrypt) header field of a pending-capture blob. Exposed by
/// [`parse_capture_header`] so a caller can read the `capture_id` (e.g. for
/// dedup / logging) without a `wrap_key`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHeader {
    /// The 16-byte `capture_id` (UUIDv7) — also the queue filename.
    pub capture_id: [u8; CAPTURE_ID_LEN],
}

/// Failure modes of the pending-capture codec. The mobile caller collapses a
/// decode failure to "drop this queue entry" (a corrupt/foreign entry can never
/// become a note).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum CaptureBlobError {
    /// Input shorter than [`CAPTURE_BLOB_HEADER_LEN`] bytes.
    #[error("pending-capture blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYK1`.
    #[error("pending-capture blob magic mismatch (expected MYK1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("pending-capture blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `ciphertext_len` exceeds [`MAX_CAPTURE_PLAINTEXT_LEN`] + 32, or an encode
    /// was asked to seal a plaintext larger than [`MAX_CAPTURE_PLAINTEXT_LEN`].
    /// The read-side check runs BEFORE allocation so a hostile
    /// `ciphertext_len = 0xFFFFFFFF` cannot trigger a huge allocation.
    #[error("pending-capture ciphertext_len exceeds 16 KiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("pending-capture blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong wrap_key, tampered ciphertext/tag/AAD, or
    /// wrong `capture_id` binding).
    #[error("pending-capture AEAD verification failed")]
    CannotDecrypt,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for pending-capture nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for CaptureBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        CaptureBlobError::CannotDecrypt
    }
}

/// Encode a pending-capture blob, sealing `plaintext` under `wrap_key` with
/// `nonce`. `capture_id` is written into the public header (and bound into the
/// AAD).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse under
/// the same `wrap_key` is catastrophic. Production callers SHOULD use
/// [`encode_capture_blob`].
pub fn encode_capture_blob_raw(
    wrap_key: &[u8; AEAD_KEY_LEN],
    capture_id: &[u8; CAPTURE_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, CaptureBlobError> {
    if plaintext.len() > MAX_CAPTURE_PLAINTEXT_LEN {
        return Err(CaptureBlobError::CiphertextLenOverflow);
    }

    let aad = aad_capture_blob(capture_id);
    let sealed = aead_seal_ctx(wrap_key, nonce, plaintext, &aad)?;

    // ciphertext_len in the header = sealed.len() = plaintext.len() + 32.
    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "sealed length is plaintext || CTX tag",
    );

    let mut out = Vec::with_capacity(CAPTURE_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&CAPTURE_BLOB_MAGIC);
    out.push(CAPTURE_BLOB_PROTOCOL_VERSION);
    out.extend_from_slice(capture_id);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a pending-capture blob, pulling the 24-byte nonce from the OS CSPRNG.
/// Production callers SHOULD use this rather than the `_raw` variant.
pub fn encode_capture_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    capture_id: &[u8; CAPTURE_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, CaptureBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| CaptureBlobError::RandomnessUnavailable)?;
    let result = encode_capture_blob_raw(wrap_key, capture_id, plaintext, &nonce);
    nonce.zeroize();
    result
}

/// Parse the **public** `capture_id` header field of a pending-capture blob
/// WITHOUT a wrap key. Checks magic / protocol_version only.
pub fn parse_capture_header(blob: &[u8]) -> Result<CaptureHeader, CaptureBlobError> {
    if blob.len() < CAPTURE_BLOB_HEADER_LEN {
        return Err(CaptureBlobError::HeaderTooShort);
    }
    if blob[0..4] != CAPTURE_BLOB_MAGIC {
        return Err(CaptureBlobError::MagicMismatch);
    }
    if blob[4] != CAPTURE_BLOB_PROTOCOL_VERSION {
        return Err(CaptureBlobError::ProtocolVersionMismatch);
    }
    let mut capture_id = [0u8; CAPTURE_ID_LEN];
    capture_id.copy_from_slice(&blob[5..21]);
    Ok(CaptureHeader { capture_id })
}

/// Decode a pending-capture blob into its dictated-text plaintext. Magic /
/// protocol_version / ciphertext_len are all checked BEFORE any decryption;
/// AEAD failure collapses to [`CaptureBlobError::CannotDecrypt`]. The
/// `capture_id` bound into the AAD is read from the blob's own header, so a
/// tampered header `capture_id` fails AEAD.
pub fn decode_capture_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CaptureBlobError> {
    // ---- parse the 49-byte header (all checks BEFORE decryption) -------
    let header = parse_capture_header(blob)?;

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[21..45]);

    let ciphertext_len = u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize;
    // Reject an oversize length BEFORE indexing/allocating (a hostile
    // ciphertext_len = 0xFFFFFFFF must not cause a huge allocation).
    if ciphertext_len > MAX_CAPTURE_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(CaptureBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = CAPTURE_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(CaptureBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt (capture_id bound into the AAD) -----------------
    let aad = aad_capture_blob(&header.capture_id);
    let plaintext = aead_open_ctx(
        wrap_key,
        &nonce,
        &blob[CAPTURE_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};

    const WRAP_KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const CAPTURE_ID: [u8; CAPTURE_ID_LEN] = [0x7c; CAPTURE_ID_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
    const TEXT: &[u8] = b"Buy oat milk on the way home";

    fn encode(text: &[u8]) -> Vec<u8> {
        encode_capture_blob_raw(&WRAP_KEY, &CAPTURE_ID, text, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_dictated_text() {
        let blob = encode(TEXT);
        let plaintext = decode_capture_blob(&WRAP_KEY, &blob).expect("decode");
        assert_eq!(plaintext.as_slice(), TEXT);
    }

    #[test]
    fn round_trips_empty_and_multibyte_utf8() {
        // Empty (edge — a caller SHOULD avoid enqueuing this, but the codec
        // must not corrupt it) and multibyte UTF-8 (byte transparency).
        for text in [&b""[..], "café — não 🎙️".as_bytes()] {
            let blob = encode(text);
            let plaintext = decode_capture_blob(&WRAP_KEY, &blob).expect("decode");
            assert_eq!(plaintext.as_slice(), text);
        }
    }

    #[test]
    fn header_layout_is_magic_version_capture_id_nonce_len() {
        let blob = encode(TEXT);
        assert_eq!(&blob[0..4], b"MYK1");
        assert_eq!(blob[4], CAPTURE_BLOB_PROTOCOL_VERSION);
        assert_eq!(&blob[5..21], &CAPTURE_ID);
        assert_eq!(&blob[21..45], &NONCE);
        // ciphertext_len = plaintext_len + CTX tag (32).
        assert_eq!(
            u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize,
            TEXT.len() + CTX_COMMITMENT_TAG_LEN
        );
        assert_eq!(
            blob.len(),
            CAPTURE_BLOB_HEADER_LEN + TEXT.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    #[test]
    fn parse_header_exposes_capture_id_without_key() {
        let blob = encode(TEXT);
        let header = parse_capture_header(&blob).expect("header");
        assert_eq!(&header.capture_id, &CAPTURE_ID);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(TEXT);
        blob[0] = b'X';
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::MagicMismatch)
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let mut blob = encode(TEXT);
        blob[4] = 0x02;
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn capture_id_is_aad_bound_cross_capture_fails() {
        // Flip a byte in the header capture_id. Any 16-byte id is structurally
        // valid, so this is NOT a parse reject — but the id is read from the
        // header and bound into the AAD, so the AEAD verification fails. This is
        // the swap/duplicate protection for the queue directory.
        let mut blob = encode(TEXT);
        blob[5] ^= 0x01;
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(TEXT);
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_wrap_key_fails_aead() {
        let blob = encode(TEXT);
        let other_key = [0x01; AEAD_KEY_LEN];
        assert_eq!(
            decode_capture_blob(&other_key, &blob),
            Err(CaptureBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short_rejects() {
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, b"MYK1"),
            Err(CaptureBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn truncated_ciphertext_rejects() {
        let mut blob = encode(TEXT);
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn oversize_ciphertext_len_rejects_before_alloc() {
        let mut blob = encode(TEXT);
        // Set ciphertext_len to 0xFFFFFFFF (4 GiB) — must reject before any
        // allocation, not truncate-check.
        blob[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_capture_blob(&WRAP_KEY, &blob),
            Err(CaptureBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn encode_rejects_oversize_plaintext() {
        let big = alloc::vec![0x61u8; MAX_CAPTURE_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_capture_blob_raw(&WRAP_KEY, &CAPTURE_ID, &big, &NONCE),
            Err(CaptureBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn encode_accepts_plaintext_at_cap() {
        let at_cap = alloc::vec![0x61u8; MAX_CAPTURE_PLAINTEXT_LEN];
        let blob = encode_capture_blob_raw(&WRAP_KEY, &CAPTURE_ID, &at_cap, &NONCE)
            .expect("encode at cap");
        let plaintext = decode_capture_blob(&WRAP_KEY, &blob).expect("decode at cap");
        assert_eq!(plaintext.len(), MAX_CAPTURE_PLAINTEXT_LEN);
    }

    #[test]
    fn convenience_encode_round_trips_via_getrandom() {
        let blob = encode_capture_blob(&WRAP_KEY, &CAPTURE_ID, TEXT).expect("encode");
        let plaintext = decode_capture_blob(&WRAP_KEY, &blob).expect("decode");
        assert_eq!(plaintext.as_slice(), TEXT);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/pending-capture/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_pending_capture_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a side
    /// effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_capture_blob_vectors_for_paste -- --ignored`
    ///
    /// 11 cases pin (§ 9.18):
    /// - 2 `encrypt` — a short ASCII capture + a multibyte-UTF8 capture (pins
    ///   the `MYK1` byte output + variable ciphertext_len). `wrap_key` is the
    ///   device-local key, supplied DIRECTLY (provider-agnostic codec).
    /// - 1 `decrypt_ok` (round-trip → the dictated plaintext).
    /// - 3 `decrypt_aead_fail` — (a) CTX-tag tamper, (b) cross-`capture_id`
    ///   (header id flipped; AAD-bound), (c) wrong `wrap_key`. All collapse to
    ///   `CaptureBlobError::CannotDecrypt` (non-distinguishing, § 6.4); real-key
    ///   fixtures make a skipped check observable.
    /// - 5 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `CiphertextLenOverflow`,
    ///   `HeaderTooShort`, `CiphertextTruncated`).
    ///
    /// `RandomnessUnavailable` (encode-side) cannot be expressed as a
    /// decode-a-blob case, so it is not vectored.
    #[test]
    #[ignore]
    fn emit_capture_blob_vectors_for_paste() {
        extern crate std;

        let wrap_key: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
        let other_wrap_key: [u8; AEAD_KEY_LEN] = [0x01; AEAD_KEY_LEN];
        let capture_id: [u8; CAPTURE_ID_LEN] = [0x7c; CAPTURE_ID_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
        let text_ascii: &[u8] = b"Buy oat milk on the way home";
        let text_utf8: &[u8] = "café — não 🎙️".as_bytes();

        let blob_ascii =
            encode_capture_blob_raw(&wrap_key, &capture_id, text_ascii, &nonce).expect("ascii");
        let blob_utf8 =
            encode_capture_blob_raw(&wrap_key, &capture_id, text_utf8, &nonce).expect("utf8");

        // Round-trip sanity.
        assert_eq!(
            decode_capture_blob(&wrap_key, &blob_ascii)
                .expect("decode ascii")
                .as_slice(),
            text_ascii
        );
        assert_eq!(
            decode_capture_blob(&wrap_key, &blob_utf8)
                .expect("decode utf8")
                .as_slice(),
            text_utf8
        );

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_ascii.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_capture_blob(&wrap_key, &blob_tag_tamper),
            Err(CaptureBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): flip a byte in the header capture_id (AAD-bound).
        let mut blob_id_flip = blob_ascii.clone();
        blob_id_flip[5] ^= 0x01;
        assert_eq!(
            decode_capture_blob(&wrap_key, &blob_id_flip),
            Err(CaptureBlobError::CannotDecrypt),
            "cross-capture_id must reject"
        );
        // decrypt_aead_fail (c): intact blob decrypted under a wrong wrap_key.
        assert_eq!(
            decode_capture_blob(&other_wrap_key, &blob_ascii),
            Err(CaptureBlobError::CannotDecrypt),
            "wrong wrap_key must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_ascii.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_ascii.clone();
        pf_version[4] = 0x02;
        let mut pf_len_overflow = blob_ascii.clone();
        pf_len_overflow[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
        let pf_header_short: Vec<u8> = CAPTURE_BLOB_MAGIC.to_vec(); // 4 < 49
        let mut pf_truncated = blob_ascii.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);

        // Sanity: each corrupted blob hits its intended reject (real key — a
        // port skipping a structural check would surface CannotDecrypt, which
        // the runner catches as a mismatch).
        assert_eq!(
            decode_capture_blob(&wrap_key, &pf_magic),
            Err(CaptureBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_capture_blob(&wrap_key, &pf_version),
            Err(CaptureBlobError::ProtocolVersionMismatch)
        );
        assert_eq!(
            decode_capture_blob(&wrap_key, &pf_len_overflow),
            Err(CaptureBlobError::CiphertextLenOverflow)
        );
        assert_eq!(
            decode_capture_blob(&wrap_key, &pf_header_short),
            Err(CaptureBlobError::HeaderTooShort)
        );
        assert_eq!(
            decode_capture_blob(&wrap_key, &pf_truncated),
            Err(CaptureBlobError::CiphertextTruncated)
        );

        let wrap_key_hex = hex_lower(&wrap_key);
        let other_wrap_key_hex = hex_lower(&other_wrap_key);
        let capture_id_hex = hex_lower(&capture_id);
        let nonce_hex = hex_lower(&nonce);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"pending-capture\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.18 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_capture_blob_raw + protocol::decode_capture_blob byte mapping for the MYK1 pending-capture device-local queue codec (§9.18). The blob seals arbitrary-length dictated note text under a device-local wrap_key — the codec is PROVIDER-AGNOSTIC and vault-agnostic: it never runs Argon2id and binds NEITHER account_number_hash NOR items_key_id (the queue is created while the vault is locked). It binds the per-entry capture_id (also the queue filename) via aad_capture_blob (AAD role 'pending-capture-blob'); there is NO HKDF SubkeyRole (a root_key-derived KEK would be wrong — the queue must survive while root_key is unavailable). ciphertext_len is variable (plaintext_len + 32), capped at MAX_CAPTURE_PLAINTEXT_LEN (16 KiB); an oversize ciphertext_len is a CiphertextLenOverflow reject before allocation. 11 cases: 2 encrypt (ascii + multibyte-utf8) + 1 decrypt_ok + 3 decrypt_aead_fail (tag-tamper + cross-capture_id + wrong-wrap-key, all non-distinguishing per §6.4) + 5 parse_fail (one per distinguishable pre-decryption structural reject). Cases generated by `cargo test -p protocol --lib emit_capture_blob_vectors_for_paste -- --ignored` (in protocol/src/capture_blob.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // ---- encrypt closure ----------------------------------------
        let emit_encrypt = |dump: &mut alloc::string::String,
                            slug: &str,
                            description: &str,
                            plaintext: &[u8],
                            blob: &[u8],
                            trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"pending-capture/v0.1/{}\",\n",
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
                "      \"input_capture_id_hex\": \"{}\",\n",
                capture_id_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_plaintext_utf8_hex\": \"{}\",\n",
                hex_lower(plaintext)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_nonce_hex\": \"{}\",\n",
                nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_pending_capture_blob_hex\": \"{}\"\n",
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
            "encrypt-ascii",
            "Encode a short ASCII dictated capture under the device-local wrap_key. Expected blob = 49-byte header + plaintext_len + 32-byte CTX tag.",
            text_ascii,
            &blob_ascii,
            true,
        );
        emit_encrypt(
            &mut dump,
            "encrypt-multibyte-utf8",
            "Encode a multibyte UTF-8 capture ('café — não 🎙️') to pin byte transparency across the AEAD boundary and a different variable ciphertext_len.",
            text_utf8,
            &blob_utf8,
            true,
        );

        // ---- decrypt_ok ---------------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"pending-capture/v0.1/decrypt-ok-ascii\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the ASCII blob back to the dictated plaintext under the matching wrap_key. Proves the decoder's header parse + AEAD unwrap (capture_id read from the header, bound into the AAD) reconstruct the exact UTF-8 bytes.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_ascii)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_wrap_key_hex\": \"{}\",\n",
            wrap_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_utf8_hex\": \"{}\"\n",
            hex_lower(text_ascii)
        ));
        dump.push_str("    },\n");

        // ---- decrypt_aead_fail closure ------------------------------
        let emit_aead_fail = |dump: &mut alloc::string::String,
                              slug: &str,
                              description: &str,
                              blob: &[u8],
                              wrap_key_arg_hex: &str,
                              tamper_desc: &str,
                              trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"pending-capture/v0.1/{}\",\n",
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
            "Take the ASCII blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt (spec §6.4).",
            &blob_tag_tamper,
            &wrap_key_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-cross-capture-id",
            "Take the ASCII blob and flip one byte of the header capture_id (offset 5). Any 16-byte id is structurally valid, so this passes the header checks — but capture_id is read from the header and bound into the AAD (§9.18.3), so the AEAD verification fails. Proves an entry cannot be relabelled / swapped to another capture_id slot.",
            &blob_id_flip,
            &wrap_key_hex,
            "header capture_id byte at offset 5 flipped via XOR 0x01; AAD-bound",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-wrong-wrap-key",
            "Take the intact ASCII blob but decrypt under a DIFFERENT device wrap_key (0x01×32 instead of 0x42×32). Collapses to the same CannotDecrypt; ports MUST NOT distinguish.",
            &blob_ascii,
            &other_wrap_key_hex,
            "intact blob decrypted under wrong wrap_key (0x01×32)",
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
                "      \"vector_id\": \"pending-capture/v0.1/{}\",\n",
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
            "First byte of the MYK1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.18.1).",
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
            "parse-fail-ciphertext-len-overflow",
            "ciphertext_len field (offset 45..49) set to 0xFFFFFFFF (4 GiB), far over the MAX_CAPTURE_PLAINTEXT_LEN + 32 cap. Rejected BEFORE allocation so a hostile length cannot trigger a huge allocation (contrast the fixed-size vault-quickunlock, which rejects any length != 64).",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYK1 magic, no room for the 49-byte header. Rejected before any field read.",
            &pf_header_short,
            "header_too_short",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-ciphertext-truncated",
            "Valid header advertising ciphertext_len = plaintext + 32, but the blob is one byte shorter than header + ciphertext_len. Rejected before the AEAD stage.",
            &pf_truncated,
            "ciphertext_truncated",
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_pending_capture_vectors.json", dump.as_bytes())
            .expect("write pending-capture vectors dump");
    }
}
