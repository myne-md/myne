// SPDX-License-Identifier: AGPL-3.0

//! `pending-shares/<share-id>` share-import staging blob codec (`MYF1`;
//! `docs/spec/protocol.md` § 9.19).
//!
//! A **shared file** arrives from the OS share sheet (iOS Share Extension /
//! Android `ACTION_SEND`) at a process that may not hold `root_key` (the iOS
//! extension is a separate sandbox; on Android the vault may be locked). It
//! cannot be written into the vault yet (that needs the unlocked `items_key`),
//! so it is held in a **device-local encrypted queue** until the next unlock,
//! when it is drained into the vault's attachment library (§ 9.9/§ 9.10) via
//! `attachment_import`.
//!
//! This is the file-carrying sibling of the pending-capture codec (`MYK1`,
//! § 9.18): same device-local `wrap_key` seal, same vault-agnostic
//! per-entry-id AAD binding — but the plaintext is **arbitrary binary** (a
//! shared file's bytes, framed with its filename + declared MIME by the core
//! layer, `myne_core::plugins::share_import`) and the cap is **64 MiB**
//! ([`MAX_SHARE_IMPORT_PLAINTEXT_LEN`], matching the `MYA1` attachment cap)
//! rather than 16 KiB.
//!
//! Like `MYK1`, this blob is sealed under a **device-local `wrap_key`** — a
//! random 32-byte key held in the OS keychain / Android Keystore, NOT a
//! `DeriveSubkey(root_key, …)` subkey. The queue is created while the vault is
//! locked and is **vault-agnostic**: it binds neither an `account_number_hash`
//! nor an `items_key_id`, only the per-entry **`share_id`** (16 random bytes,
//! also the queue filename) into the AAD, so an attacker with write access to
//! the queue directory cannot swap or duplicate one entry's ciphertext under
//! another entry's slot.
//!
//! The codec is **provider-agnostic** (it only ever sees a symmetric
//! `wrap_key`) and has **no `SubkeyRole`**. The plaintext framing (filename /
//! MIME / bytes) is the core's concern — the codec seals opaque bytes.
//!
//! ## On-disk layout (spec § 9.19.3)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  ------------------------------------
//! 0       4     magic             ASCII "MYF1"
//! 4       1     protocol_version  0x01
//! 5       16    share_id          16 random bytes; ALSO the queue filename; AAD-bound
//! 21      24    wrap_nonce        XChaCha20-Poly1305 nonce
//! 45      4     ciphertext_len    big-endian uint32, = plaintext_len + 32
//! 49      ..    ciphertext        framed file record AEAD-sealed + 32-byte CTX tag
//! ```
//!
//! Header = 49 bytes. `share_id` sits in the public header (it is the queue
//! filename) AND is bound into the AAD (§ 9.19.3), so tampering with the header
//! `share_id` fails AEAD rather than silently re-labelling the entry.

use crate::aead::{
    aad_share_import_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYF1"` (Myne share-import **F**ile v1).
/// `F` is a free letter in the § 10.3 registry; allocated here the same way
/// every family's magic is (implementer-chosen from the free pool — cf. `MYK1`'s
/// "K because C is taken"). A later letter change would be a mechanical rename.
pub const SHARE_IMPORT_BLOB_MAGIC: [u8; 4] = *b"MYF1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const SHARE_IMPORT_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// Length of the 16-byte `share_id` carried in the header and bound into the
/// AAD.
pub const SHARE_ID_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + share_id 16 + nonce 24 + len 4).
pub const SHARE_IMPORT_BLOB_HEADER_LEN: usize = 49;

/// Maximum framed-plaintext a single share may carry (64 MiB) — matches the
/// `MYA1` attachment cap so a staged file that drains into the library fits the
/// pipeline. The framed plaintext is `filename_len ∥ filename ∥ mime_len ∥ mime
/// ∥ file_bytes`, so the actual file is a few hundred bytes under this ceiling.
/// The decoder rejects `ciphertext_len > MAX_SHARE_IMPORT_PLAINTEXT_LEN + 32`
/// before allocating. See spec § 9.19.4.
pub const MAX_SHARE_IMPORT_PLAINTEXT_LEN: usize = 64 * 1024 * 1024;

/// Public (pre-decrypt) header field of a share-import blob. Exposed by
/// [`parse_share_import_header`] so a caller can read the `share_id` (e.g. for
/// the on-disk filename check) without a `wrap_key`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareImportHeader {
    /// The 16-byte `share_id` — also the queue filename.
    pub share_id: [u8; SHARE_ID_LEN],
}

/// Failure modes of the share-import codec. The mobile caller collapses a
/// decode failure to "drop this queue entry" (a corrupt/foreign entry can never
/// become an attachment).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ShareImportBlobError {
    /// Input shorter than [`SHARE_IMPORT_BLOB_HEADER_LEN`] bytes.
    #[error("share-import blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYF1`.
    #[error("share-import blob magic mismatch (expected MYF1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("share-import blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `ciphertext_len` exceeds [`MAX_SHARE_IMPORT_PLAINTEXT_LEN`] + 32, or an
    /// encode was asked to seal a plaintext larger than the cap. The read-side
    /// check runs BEFORE allocation so a hostile `ciphertext_len = 0xFFFFFFFF`
    /// cannot trigger a huge allocation.
    #[error("share-import ciphertext_len exceeds 64 MiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("share-import blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong wrap_key, tampered ciphertext/tag/AAD, or
    /// wrong `share_id` binding).
    #[error("share-import AEAD verification failed")]
    CannotDecrypt,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for share-import nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for ShareImportBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        ShareImportBlobError::CannotDecrypt
    }
}

/// Encode a share-import blob, sealing `plaintext` under `wrap_key` with
/// `nonce`. `share_id` is written into the public header (and bound into the
/// AAD).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse under
/// the same `wrap_key` is catastrophic. Production callers SHOULD use
/// [`encode_share_import_blob`].
pub fn encode_share_import_blob_raw(
    wrap_key: &[u8; AEAD_KEY_LEN],
    share_id: &[u8; SHARE_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ShareImportBlobError> {
    if plaintext.len() > MAX_SHARE_IMPORT_PLAINTEXT_LEN {
        return Err(ShareImportBlobError::CiphertextLenOverflow);
    }

    let aad = aad_share_import_blob(share_id);
    let sealed = aead_seal_ctx(wrap_key, nonce, plaintext, &aad)?;

    // ciphertext_len in the header = sealed.len() = plaintext.len() + 32.
    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "sealed length is plaintext || CTX tag",
    );

    let mut out = Vec::with_capacity(SHARE_IMPORT_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&SHARE_IMPORT_BLOB_MAGIC);
    out.push(SHARE_IMPORT_BLOB_PROTOCOL_VERSION);
    out.extend_from_slice(share_id);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a share-import blob, pulling the 24-byte nonce from the OS CSPRNG.
/// Production callers SHOULD use this rather than the `_raw` variant.
pub fn encode_share_import_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    share_id: &[u8; SHARE_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ShareImportBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| ShareImportBlobError::RandomnessUnavailable)?;
    let result = encode_share_import_blob_raw(wrap_key, share_id, plaintext, &nonce);
    nonce.zeroize();
    result
}

/// Parse the **public** `share_id` header field of a share-import blob WITHOUT a
/// wrap key. Checks magic / protocol_version only.
pub fn parse_share_import_header(blob: &[u8]) -> Result<ShareImportHeader, ShareImportBlobError> {
    if blob.len() < SHARE_IMPORT_BLOB_HEADER_LEN {
        return Err(ShareImportBlobError::HeaderTooShort);
    }
    if blob[0..4] != SHARE_IMPORT_BLOB_MAGIC {
        return Err(ShareImportBlobError::MagicMismatch);
    }
    if blob[4] != SHARE_IMPORT_BLOB_PROTOCOL_VERSION {
        return Err(ShareImportBlobError::ProtocolVersionMismatch);
    }
    let mut share_id = [0u8; SHARE_ID_LEN];
    share_id.copy_from_slice(&blob[5..21]);
    Ok(ShareImportHeader { share_id })
}

/// Decode a share-import blob into its framed-file plaintext. Magic /
/// protocol_version / ciphertext_len are all checked BEFORE any decryption;
/// AEAD failure collapses to [`ShareImportBlobError::CannotDecrypt`]. The
/// `share_id` bound into the AAD is read from the blob's own header, so a
/// tampered header `share_id` fails AEAD.
pub fn decode_share_import_blob(
    wrap_key: &[u8; AEAD_KEY_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ShareImportBlobError> {
    // ---- parse the 49-byte header (all checks BEFORE decryption) -------
    let header = parse_share_import_header(blob)?;

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[21..45]);

    let ciphertext_len = u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize;
    // Reject an oversize length BEFORE indexing/allocating (a hostile
    // ciphertext_len = 0xFFFFFFFF must not cause a huge allocation).
    if ciphertext_len > MAX_SHARE_IMPORT_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(ShareImportBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = SHARE_IMPORT_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(ShareImportBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt (share_id bound into the AAD) -------------------
    let aad = aad_share_import_blob(&header.share_id);
    let plaintext = aead_open_ctx(
        wrap_key,
        &nonce,
        &blob[SHARE_IMPORT_BLOB_HEADER_LEN..ciphertext_end],
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
    const SHARE_ID: [u8; SHARE_ID_LEN] = [0x7c; SHARE_ID_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
    // Non-UTF-8 binary payload (a shared file is arbitrary bytes).
    const FILE: &[u8] = &[0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    fn encode(pt: &[u8]) -> Vec<u8> {
        encode_share_import_blob_raw(&WRAP_KEY, &SHARE_ID, pt, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_binary_plaintext() {
        let blob = encode(FILE);
        let plaintext = decode_share_import_blob(&WRAP_KEY, &blob).expect("decode");
        assert_eq!(plaintext.as_slice(), FILE);
    }

    #[test]
    fn round_trips_empty_and_large_binary() {
        // Empty (edge — a caller SHOULD avoid enqueuing this) and a ~1 MiB
        // binary payload (byte transparency at size).
        let big = alloc::vec![0xa5u8; 1024 * 1024];
        for pt in [&b""[..], big.as_slice()] {
            let blob = encode(pt);
            let plaintext = decode_share_import_blob(&WRAP_KEY, &blob).expect("decode");
            assert_eq!(plaintext.as_slice(), pt);
        }
    }

    #[test]
    fn header_layout_is_magic_version_share_id_nonce_len() {
        let blob = encode(FILE);
        assert_eq!(&blob[0..4], b"MYF1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(&blob[5..21], &SHARE_ID);
        assert_eq!(&blob[21..45], &NONCE);
        let ct_len = u32::from_be_bytes([blob[45], blob[46], blob[47], blob[48]]) as usize;
        assert_eq!(ct_len, FILE.len() + CTX_COMMITMENT_TAG_LEN);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(FILE);
        blob[0] = b'X';
        assert_eq!(
            decode_share_import_blob(&WRAP_KEY, &blob),
            Err(ShareImportBlobError::MagicMismatch)
        );
    }

    #[test]
    fn version_checked_before_decrypt() {
        let mut blob = encode(FILE);
        blob[4] = 0x02;
        assert_eq!(
            decode_share_import_blob(&WRAP_KEY, &blob),
            Err(ShareImportBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn hostile_ciphertext_len_rejected_before_alloc() {
        // A 49-byte header claiming a 4 GiB ciphertext must be rejected on the
        // length check, never reaching an allocation.
        let mut blob = encode(FILE);
        blob[45..49].copy_from_slice(&0xffff_ffffu32.to_be_bytes());
        assert_eq!(
            decode_share_import_blob(&WRAP_KEY, &blob),
            Err(ShareImportBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn truncated_ciphertext_rejected() {
        let blob = encode(FILE);
        let short = &blob[..blob.len() - 1];
        assert_eq!(
            decode_share_import_blob(&WRAP_KEY, short),
            Err(ShareImportBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn wrong_key_cannot_decrypt() {
        let blob = encode(FILE);
        let other = [0x11u8; AEAD_KEY_LEN];
        assert_eq!(
            decode_share_import_blob(&other, &blob),
            Err(ShareImportBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn tampered_share_id_fails_aead() {
        // Flip a byte in the header share_id — it is AAD-bound, so decryption
        // fails (rather than silently re-labelling the entry).
        let mut blob = encode(FILE);
        blob[5] ^= 0x01;
        assert_eq!(
            decode_share_import_blob(&WRAP_KEY, &blob),
            Err(ShareImportBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short() {
        let short = SHARE_IMPORT_BLOB_MAGIC.to_vec(); // 4 < 49
        assert_eq!(
            parse_share_import_header(&short),
            Err(ShareImportBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn encode_rejects_oversize_plaintext() {
        // One byte over the 64 MiB cap is rejected before sealing.
        let big = alloc::vec![0x61u8; MAX_SHARE_IMPORT_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_share_import_blob_raw(&WRAP_KEY, &SHARE_ID, &big, &NONCE),
            Err(ShareImportBlobError::CiphertextLenOverflow)
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/share-import/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_share_import_vectors.json`, ready
    /// to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a side
    /// effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_share_import_blob_vectors_for_paste -- --ignored`
    ///
    /// 11 cases pin (§ 9.19), mirroring the `MYK1` pending-capture family:
    /// - 2 `encrypt` — a short binary share + a genuinely non-UTF-8 binary share
    ///   (pins the `MYF1` byte output, byte transparency, and two different
    ///   variable ciphertext_lens). `wrap_key` is the device-local key, supplied
    ///   DIRECTLY (provider-agnostic codec).
    /// - 1 `decrypt_ok` (round-trip → the framed-file plaintext).
    /// - 3 `decrypt_aead_fail` — (a) CTX-tag tamper, (b) cross-`share_id`
    ///   (header id flipped; AAD-bound), (c) wrong `wrap_key`. All collapse to
    ///   `ShareImportBlobError::CannotDecrypt` (non-distinguishing, § 6.4);
    ///   real-key fixtures make a skipped check observable.
    /// - 5 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`MagicMismatch`, `ProtocolVersionMismatch`, `CiphertextLenOverflow`,
    ///   `HeaderTooShort`, `CiphertextTruncated`).
    ///
    /// `RandomnessUnavailable` (encode-side) cannot be expressed as a
    /// decode-a-blob case, so it is not vectored.
    #[test]
    #[ignore]
    fn emit_share_import_blob_vectors_for_paste() {
        extern crate std;

        let wrap_key: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
        let other_wrap_key: [u8; AEAD_KEY_LEN] = [0x01; AEAD_KEY_LEN];
        let share_id: [u8; SHARE_ID_LEN] = [0x7c; SHARE_ID_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
        // A short binary payload (a shared file is arbitrary bytes — PNG-ish
        // magic here, with an embedded NUL and a 0xFF that are non-UTF-8).
        let file_small: &[u8] = &[0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        // A genuinely non-UTF-8 binary payload of a DIFFERENT length: a lone
        // continuation byte (0x80), 0xC0, a UTF-16 surrogate encoding
        // (0xED 0xA0 0x80), and an out-of-range 4-byte lead (0xF4 0x90 0x80 0x80)
        // — none of which is valid UTF-8. Pins byte transparency (this codec
        // seals opaque bytes, unlike MYK1's dictated UTF-8) + a distinct
        // variable ciphertext_len.
        let file_binary: &[u8] = &[
            0x80, 0x00, 0xc0, 0xff, 0xfe, 0x01, 0x02, 0x03, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80,
            0x80,
        ];

        let blob_small =
            encode_share_import_blob_raw(&wrap_key, &share_id, file_small, &nonce).expect("small");
        let blob_binary = encode_share_import_blob_raw(&wrap_key, &share_id, file_binary, &nonce)
            .expect("binary");

        // Round-trip sanity.
        assert_eq!(
            decode_share_import_blob(&wrap_key, &blob_small)
                .expect("decode small")
                .as_slice(),
            file_small
        );
        assert_eq!(
            decode_share_import_blob(&wrap_key, &blob_binary)
                .expect("decode binary")
                .as_slice(),
            file_binary
        );

        // decrypt_aead_fail (a): flip the final byte (inside the CTX tag).
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_share_import_blob(&wrap_key, &blob_tag_tamper),
            Err(ShareImportBlobError::CannotDecrypt),
            "tag tamper must reject"
        );
        // decrypt_aead_fail (b): flip a byte in the header share_id (AAD-bound).
        let mut blob_id_flip = blob_small.clone();
        blob_id_flip[5] ^= 0x01;
        assert_eq!(
            decode_share_import_blob(&wrap_key, &blob_id_flip),
            Err(ShareImportBlobError::CannotDecrypt),
            "cross-share_id must reject"
        );
        // decrypt_aead_fail (c): intact blob decrypted under a wrong wrap_key.
        assert_eq!(
            decode_share_import_blob(&other_wrap_key, &blob_small),
            Err(ShareImportBlobError::CannotDecrypt),
            "wrong wrap_key must reject"
        );

        // parse_fail blobs: corrupt a valid blob per structural reject.
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[45..49].copy_from_slice(&u32::MAX.to_be_bytes());
        let pf_header_short: Vec<u8> = SHARE_IMPORT_BLOB_MAGIC.to_vec(); // 4 < 49
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);

        // Sanity: each corrupted blob hits its intended reject (real key — a
        // port skipping a structural check would surface CannotDecrypt, which
        // the runner catches as a mismatch).
        assert_eq!(
            decode_share_import_blob(&wrap_key, &pf_magic),
            Err(ShareImportBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_share_import_blob(&wrap_key, &pf_version),
            Err(ShareImportBlobError::ProtocolVersionMismatch)
        );
        assert_eq!(
            decode_share_import_blob(&wrap_key, &pf_len_overflow),
            Err(ShareImportBlobError::CiphertextLenOverflow)
        );
        assert_eq!(
            decode_share_import_blob(&wrap_key, &pf_header_short),
            Err(ShareImportBlobError::HeaderTooShort)
        );
        assert_eq!(
            decode_share_import_blob(&wrap_key, &pf_truncated),
            Err(ShareImportBlobError::CiphertextTruncated)
        );

        let wrap_key_hex = hex_lower(&wrap_key);
        let other_wrap_key_hex = hex_lower(&other_wrap_key);
        let share_id_hex = hex_lower(&share_id);
        let nonce_hex = hex_lower(&nonce);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"share-import\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.19 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::encode_share_import_blob_raw + protocol::decode_share_import_blob byte mapping for the MYF1 share-import staging blob codec (§9.19). The blob seals an arbitrary-binary framed-file record (filename + declared MIME + file bytes, framed by the core layer) under a device-local wrap_key — the codec is PROVIDER-AGNOSTIC and vault-agnostic: it never runs Argon2id and binds NEITHER account_number_hash NOR items_key_id (the queue is created while the vault is locked, or from a separate OS share-extension sandbox that does not hold root_key). It binds the per-entry share_id (also the queue filename) via aad_share_import_blob (AAD role 'share-import-blob'); there is NO HKDF SubkeyRole (a root_key-derived KEK would be wrong — the queue must survive while root_key is unavailable). ciphertext_len is variable (plaintext_len + 32), capped at MAX_SHARE_IMPORT_PLAINTEXT_LEN (64 MiB, matching the MYA1 attachment cap); an oversize ciphertext_len is a CiphertextLenOverflow reject before allocation. The MYF1 magic is a free-pool §10.3 allocation (F=file, MYND-507), implementer-chosen like every family magic. 11 cases: 2 encrypt (short binary + non-UTF-8 binary) + 1 decrypt_ok + 3 decrypt_aead_fail (tag-tamper + cross-share_id + wrong-wrap-key, all non-distinguishing per §6.4) + 5 parse_fail (one per distinguishable pre-decryption structural reject). Cases generated by `cargo test -p protocol --lib emit_share_import_blob_vectors_for_paste -- --ignored` (in protocol/src/share_import_blob.rs).\",\n");
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
                "      \"vector_id\": \"share-import/v0.1/{}\",\n",
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
                "      \"input_share_id_hex\": \"{}\",\n",
                share_id_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_plaintext_hex\": \"{}\",\n",
                hex_lower(plaintext)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_nonce_hex\": \"{}\",\n",
                nonce_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_share_import_blob_hex\": \"{}\"\n",
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
            "encrypt-binary-small",
            "Encode a short binary shared file (10 bytes, PNG-ish magic incl. an embedded NUL + 0xFF) under the device-local wrap_key. Expected blob = 49-byte header + plaintext_len + 32-byte CTX tag.",
            file_small,
            &blob_small,
            true,
        );
        emit_encrypt(
            &mut dump,
            "encrypt-binary-nonutf8",
            "Encode a genuinely non-UTF-8 binary payload (lone 0x80 continuation, 0xC0, a surrogate encoding 0xED 0xA0 0x80, an out-of-range 0xF4 0x90 0x80 0x80) to pin byte transparency — this codec seals OPAQUE bytes (unlike MYK1's dictated UTF-8) — and a different variable ciphertext_len.",
            file_binary,
            &blob_binary,
            true,
        );

        // ---- decrypt_ok ---------------------------------------------
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"share-import/v0.1/decrypt-ok-binary\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the short-binary blob back to the framed-file plaintext under the matching wrap_key. Proves the decoder's header parse + AEAD unwrap (share_id read from the header, bound into the AAD) reconstruct the exact bytes.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_small)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_wrap_key_hex\": \"{}\",\n",
            wrap_key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(file_small)
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
                "      \"vector_id\": \"share-import/v0.1/{}\",\n",
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
            "Take the short-binary blob and flip the final byte (inside the 32-byte CTX commitment tag) via XOR 0xFF. The decoder MUST surface a non-distinguishing CannotDecrypt (spec §6.4).",
            &blob_tag_tamper,
            &wrap_key_hex,
            "final byte (inside CTX tag) flipped via XOR 0xFF",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-cross-share-id",
            "Take the short-binary blob and flip one byte of the header share_id (offset 5). Any 16-byte id is structurally valid, so this passes the header checks — but share_id is read from the header and bound into the AAD (§9.19.3), so the AEAD verification fails. Proves an entry cannot be relabelled / swapped to another share_id slot.",
            &blob_id_flip,
            &wrap_key_hex,
            "header share_id byte at offset 5 flipped via XOR 0x01; AAD-bound",
            true,
        );
        emit_aead_fail(
            &mut dump,
            "decrypt-wrong-wrap-key",
            "Take the intact short-binary blob but decrypt under a DIFFERENT device wrap_key (0x01×32 instead of 0x42×32). Collapses to the same CannotDecrypt; ports MUST NOT distinguish.",
            &blob_small,
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
                "      \"vector_id\": \"share-import/v0.1/{}\",\n",
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
            "First byte of the MYF1 magic corrupted to 'X'. Rejected at offset 0 before any decryption (magic-byte-before-decrypt discipline, §9.19.3).",
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
            "ciphertext_len field (offset 45..49) set to 0xFFFFFFFF (4 GiB), far over the MAX_SHARE_IMPORT_PLAINTEXT_LEN + 32 cap (64 MiB + 32). Rejected BEFORE allocation so a hostile length cannot trigger a huge allocation (contrast the fixed-size vault-quickunlock, which rejects any length != 64).",
            &pf_len_overflow,
            "ciphertext_len_overflow",
            true,
        );
        emit_parse_fail(
            &mut dump,
            "parse-fail-header-too-short",
            "Only the 4-byte MYF1 magic, no room for the 49-byte header. Rejected before any field read.",
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

        std::fs::write("/tmp/myne_share_import_vectors.json", dump.as_bytes())
            .expect("write share-import vectors dump");
    }
}
