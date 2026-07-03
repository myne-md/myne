// SPDX-License-Identifier: AGPL-3.0

//! `attachments-text/<attachment-id-hex>` 34-byte-header encrypted
//! extracted-attachment-text codec (MYND-328; `docs/spec/protocol.md` § 9.15).
//!
//! Each attachment whose text has been extracted gets a per-attachment cache
//! blob holding the on-device-extracted text (PDF text-layer / Word `.docx` /
//! text-like). The blob lives at `<vault-root>/attachments-text/<id-hex>` —
//! one file per attachment, named by the lowercase-hex `attachment_id` — and is
//! AEAD-encrypted under `attachment_text_key = DeriveSubkey(root_key,
//! SubkeyRole::AttachmentTextKey)`. The extracted text feeds the search index
//! (§ 9.6) so a note becomes findable by the contents of its attachments.
//!
//! This codec is **payload-agnostic**, exactly like `search_blob.rs` /
//! `dictionary_blob.rs`: the inner plaintext is an opaque byte string produced
//! by the desktop layer (the `extractor_version 0x01` format is a
//! postcard-serialized `{status, source_format, text, char_count, truncated}`
//! struct — the extracted text is plaintext-derived AS3-Sensitive content and
//! so MUST live INSIDE this AEAD envelope, never in the cleartext header). The
//! protocol crate owns only the crypto framing (magic, version, AEAD, AAD) —
//! the load-bearing parts.
//!
//! ## On-disk layout (spec § 9.15.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYE1"
//! 4       1     protocol_version     0x01
//! 5       1     extractor_version    0x01 (the extractor generation; a future
//!                                     extractor — incl. the OCR layer MYND-441 —
//!                                     bumps this so an old decoder rejects and
//!                                     the caller re-extracts)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes. The `attachment_id` is NOT a header field — the file
//! name carries it and the AAD (§ 9.15.3) binds it cryptographically, so a blob
//! can never be served for the wrong attachment. No public `account_number_hash`
//! byte either (it binds via the AAD), exactly like `vault.search`.
//!
//! ## Cache semantic (spec § 9.15.4)
//!
//! Like `search_blob.rs`, this module emits **honest errors** for each failure
//! mode; the desktop caller collapses any error (absent / truncated / AEAD-fail
//! / unsupported-version) to a **cache miss** and re-extracts from the source
//! `MYA1` attachment. A replayed/tampered/stale blob is non-load-bearing — the
//! worst case is one re-extraction, never a weakened guarantee. The
//! `extractor_version` byte is the forward hook: a future extractor (incl. OCR,
//! MYND-441) writes a higher value, and a `0x01`-only client returns
//! [`AttachmentTextBlobError::ExtractorVersionUnsupported`] → re-extract.

use crate::aead::{
    aad_attachment_text_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::attachment_blob::ATTACHMENT_ID_LEN;
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYE1"` (Myne Extracted-text v1).
pub const ATTACHMENT_TEXT_BLOB_MAGIC: [u8; 4] = *b"MYE1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `extractor_version` byte at offset 5 — the extractor generation that
/// produced the inner plaintext. `0x01` = the v0.1 baseline extractor set
/// (PDF text-layer, DOCX OOXML text, text-like UTF-8). A future extractor set
/// (better extraction, or the OCR layer MYND-441) bumps this so an older
/// decoder rejects cleanly and the caller re-extracts. Bound into the AAD as
/// well as this header byte (§ 9.15.3).
pub const ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + extractor 1 + nonce 24 + len 4).
pub const ATTACHMENT_TEXT_BLOB_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (serialized extracted text). 4 MiB —
/// generous headroom over the extractor's own `MAX_EXTRACTED_TEXT_LEN` cap plus
/// postcard overhead — that turns a hostile `ciphertext_len` into a clean error
/// instead of an absurd allocation / panicking slice index (§ 9.15.4, mirroring
/// the § 9.13.4 / § 9.6.5 DoS-allocation discipline).
pub const MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN: usize = 4 * 1024 * 1024;

/// Failure modes of the attachment-text codec. Distinct variants for
/// observability; the desktop caller collapses all of them to a cache miss
/// (fall-back-to-re-extract, § 9.15.4).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AttachmentTextBlobError {
    /// Input shorter than [`ATTACHMENT_TEXT_BLOB_HEADER_LEN`] bytes.
    #[error("attachment-text blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYE1`.
    #[error("attachment-text blob magic mismatch (expected MYE1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("attachment-text blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `extractor_version` is not understood by this client → re-extract.
    #[error("attachment-text blob extractor_version unsupported")]
    ExtractorVersionUnsupported,
    /// `ciphertext_len` exceeds [`MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN`] + 32.
    #[error("attachment-text ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`.
    #[error("attachment-text blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD —
    /// including a wrong `attachment_id`, `account_number_hash`, or tampered
    /// `extractor_version` byte, all AAD-bound).
    #[error("attachment-text AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN`].
    #[error("attachment-text plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for attachment-text nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for AttachmentTextBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline, mirroring
        // dictionary_blob.rs / search_blob.rs).
        AttachmentTextBlobError::CannotDecrypt
    }
}

/// Encode an attachment-text blob from an opaque `plaintext` (the desktop
/// layer's serialized extracted-text struct), sealing under
/// `attachment_text_key` with `nonce`. The blob is bound to `attachment_id`
/// and the v0.1 `extractor_version` via the AAD (§ 9.15.3).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source — nonce reuse under
/// the same `attachment_text_key` is catastrophic per the XChaCha20-Poly1305
/// contract. Production callers SHOULD use [`encode_attachment_text_blob`],
/// which pulls randomness from `getrandom`.
pub fn encode_attachment_text_blob_raw(
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AttachmentTextBlobError> {
    if plaintext.len() > MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN {
        return Err(AttachmentTextBlobError::PlaintextTooLarge);
    }

    let aad = aad_attachment_text_blob(
        account_number_hash,
        attachment_id,
        ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1,
    );
    let sealed = aead_seal_ctx(attachment_text_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(ATTACHMENT_TEXT_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&ATTACHMENT_TEXT_BLOB_MAGIC);
    out.push(ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION);
    out.push(ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode an attachment-text blob, pulling the 24-byte nonce from the OS
/// CSPRNG. Production callers SHOULD use this rather than
/// [`encode_attachment_text_blob_raw`].
pub fn encode_attachment_text_blob(
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AttachmentTextBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| AttachmentTextBlobError::RandomnessUnavailable)?;
    let result = encode_attachment_text_blob_raw(
        attachment_text_key,
        account_number_hash,
        attachment_id,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Decode an attachment-text blob into its opaque inner plaintext (the
/// serialized extracted-text struct, for the desktop layer to deserialize).
/// Magic / protocol_version / extractor_version are all checked BEFORE any
/// decryption; AEAD failure (incl. a wrong `attachment_id` or
/// `account_number_hash`, both AAD-bound) collapses to
/// [`AttachmentTextBlobError::CannotDecrypt`]. The caller supplies the same
/// `attachment_id` the blob was sealed for (the file name it was read from).
pub fn decode_attachment_text_blob(
    attachment_text_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN],
    attachment_id: &[u8; ATTACHMENT_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AttachmentTextBlobError> {
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < ATTACHMENT_TEXT_BLOB_HEADER_LEN {
        return Err(AttachmentTextBlobError::HeaderTooShort);
    }
    if blob[0..4] != ATTACHMENT_TEXT_BLOB_MAGIC {
        return Err(AttachmentTextBlobError::MagicMismatch);
    }
    if blob[4] != ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION {
        return Err(AttachmentTextBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1 {
        return Err(AttachmentTextBlobError::ExtractorVersionUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(AttachmentTextBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = ATTACHMENT_TEXT_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(AttachmentTextBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let aad = aad_attachment_text_blob(
        account_number_hash,
        attachment_id,
        ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1,
    );
    let plaintext = aead_open_ctx(
        attachment_text_key,
        &nonce,
        &blob[ATTACHMENT_TEXT_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN] =
        [0x7c; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN];
    const ATT_ID: [u8; ATTACHMENT_ID_LEN] = [0x5a; ATTACHMENT_ID_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_attachment_text_blob_raw(&KEY, &ACCOUNT_HASH, &ATT_ID, plaintext, &NONCE)
            .expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = b"\x00\x01extracted PDF/DOCX text payload\xff";
        let blob = encode(payload);
        let decoded =
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        // An empty/`status=empty` extraction result must round-trip.
        let blob = encode(b"");
        let decoded =
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob).expect("decode");
        assert!(decoded.is_empty());
    }

    #[test]
    fn header_layout_is_magic_version_extractor_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYE1");
        assert_eq!(blob[4], ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION);
        assert_eq!(blob[5], ATTACHMENT_TEXT_BLOB_EXTRACTOR_V1);
        assert_eq!(&blob[6..30], &NONCE);
        // ciphertext_len = plaintext (3) + CTX tag (32) = 35.
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), ATTACHMENT_TEXT_BLOB_HEADER_LEN + 35);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::MagicMismatch)
        );
    }

    #[test]
    fn protocol_version_mismatch_rejects() {
        let mut blob = encode(b"abc");
        blob[4] = 0x02;
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::ProtocolVersionMismatch)
        );
    }

    #[test]
    fn unsupported_extractor_version_rejects_for_reextract() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future extractor generation (e.g. OCR, MYND-441)
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::ExtractorVersionUnsupported)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"hello text");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_attachment_id_fails_aead() {
        // A blob sealed for attachment A fails AEAD when served as attachment
        // B (the AAD binds attachment_id) — the per-blob-safety property that
        // lets one KEK serve every attachment-text blob.
        let blob = encode(b"attachment A text");
        let other_id = [0x11; ATTACHMENT_ID_LEN];
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &other_id, &blob),
            Err(AttachmentTextBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_account_hash_fails_aead_cross_vault() {
        let blob = encode(b"vault A text");
        let other_hash = [0x11; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_attachment_text_blob(&KEY, &other_hash, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_key_fails_aead() {
        let blob = encode(b"text");
        let other_key = [0x01; AEAD_KEY_LEN];
        assert_eq!(
            decode_attachment_text_blob(&other_key, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn header_too_short_rejects() {
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, b"MYE1"),
            Err(AttachmentTextBlobError::HeaderTooShort)
        );
    }

    #[test]
    fn truncated_ciphertext_rejects() {
        let mut blob = encode(b"abc");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn ciphertext_len_overflow_rejects_before_alloc() {
        let mut blob = encode(b"abc");
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob),
            Err(AttachmentTextBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn plaintext_over_cap_rejects_on_encode() {
        let big = alloc::vec![0u8; MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_attachment_text_blob_raw(&KEY, &ACCOUNT_HASH, &ATT_ID, &big, &NONCE),
            Err(AttachmentTextBlobError::PlaintextTooLarge)
        );
    }

    #[test]
    fn convenience_encode_round_trips_via_getrandom() {
        let payload = b"convenience path";
        let blob =
            encode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, payload).expect("encode");
        let decoded =
            decode_attachment_text_blob(&KEY, &ACCOUNT_HASH, &ATT_ID, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn full_lineage_root_key_to_blob_round_trips() {
        // Exercise the full root_key → KEK → blob path with the real subkey
        // role, the way a production caller does.
        use crate::subkey::{derive_subkey, SubkeyRole};
        let root_key = [0x42u8; 32];
        let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
        let payload = b"extracted via the real KEK lineage";
        let blob = encode_attachment_text_blob_raw(&key, &ACCOUNT_HASH, &ATT_ID, payload, &NONCE)
            .expect("encode");
        let decoded =
            decode_attachment_text_blob(&key, &ACCOUNT_HASH, &ATT_ID, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/attachment-text/v0.1/cases.json` to
    /// `/tmp/myne_attachment_text_vectors.json`, ready to copy verbatim.
    ///
    /// `#[ignore]` (deliberate regen, not a `cargo test` side effect). Run:
    /// `cargo test -p protocol --lib emit_attachment_text_vectors_for_paste -- --ignored`
    ///
    /// 13 cases pin the `MYE1` codec (§9.15), mirroring `vault-dictionary` plus
    /// the two MYE1-specific AAD bindings (`attachment_id` + `extractor_version`):
    /// - 3 `encrypt` × {empty / small / 1-KB} — `attachment_text_key` is derived
    ///   from `root_key` via `SubkeyRole::AttachmentTextKey`, so the vector
    ///   exercises the full root_key → KEK → blob lineage.
    /// - 1 `decrypt_ok` (small round-trip).
    /// - 3 `decrypt_aead_fail` — (a) CTX-tag tamper, (b) cross-vault wrong
    ///   `account_number_hash`, (c) **wrong `attachment_id`** (the per-blob AAD
    ///   binding that lets one KEK serve every attachment-text blob). All
    ///   collapse to `CannotDecrypt` (non-distinguishing, §6.4).
    /// - 6 `parse_fail` — one per distinguishable pre-decryption reject
    ///   (`magic_mismatch`, `protocol_version_mismatch`,
    ///   `extractor_version_unsupported` (the forward hook, §9.15),
    ///   `header_too_short`, `ciphertext_truncated`, `ciphertext_len_overflow`).
    #[test]
    #[ignore]
    fn emit_attachment_text_vectors_for_paste() {
        extern crate std;
        use crate::subkey::{derive_subkey, SubkeyRole};

        // Distinct byte patterns per field (vault-singleton generator convention
        // + a new attachment_id axis). root_key (NOT the KEK): the runner derives
        // attachment_text_key from it via SubkeyRole::AttachmentTextKey.
        let root_key: [u8; 32] = [0x42; 32];
        let account_hash: [u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN];
        let other_account_hash: [u8; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN] =
            [0x44; ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN];
        let attachment_id: [u8; ATTACHMENT_ID_LEN] = [0x5a; ATTACHMENT_ID_LEN];
        let other_attachment_id: [u8; ATTACHMENT_ID_LEN] = [0x6b; ATTACHMENT_ID_LEN];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);

        // Deterministic opaque plaintexts (codec is payload-agnostic; the inner
        // format is the desktop's postcard ExtractedText struct).
        let pt_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let pt_small: alloc::vec::Vec<u8> =
            (*br#"{"status":"ok","source_format":"pdf","text":"crockford myne"}"#).to_vec();
        let pt_1kb: alloc::vec::Vec<u8> = (0..1024u32).map(|i| (i % 256) as u8).collect();

        let enc = |pt: &[u8]| {
            encode_attachment_text_blob_raw(&key, &account_hash, &attachment_id, pt, &nonce)
                .expect("encode")
        };
        let blob_empty = enc(&pt_empty);
        let blob_small = enc(&pt_small);
        let blob_1kb = enc(&pt_1kb);

        // round-trip sanity
        assert_eq!(
            decode_attachment_text_blob(&key, &account_hash, &attachment_id, &blob_small)
                .expect("decode")
                .as_slice(),
            pt_small.as_slice()
        );
        // aead_fail blobs
        let mut blob_tag_tamper = blob_small.clone();
        let last = blob_tag_tamper.len() - 1;
        blob_tag_tamper[last] ^= 0xFF;
        // parse_fail blobs
        let mut pf_magic = blob_small.clone();
        pf_magic[0] = b'X';
        let mut pf_version = blob_small.clone();
        pf_version[4] = 0x02;
        let mut pf_extractor = blob_small.clone();
        pf_extractor[5] = 0x02;
        let pf_header_short = ATTACHMENT_TEXT_BLOB_MAGIC.to_vec();
        let mut pf_truncated = blob_small.clone();
        pf_truncated.truncate(pf_truncated.len() - 1);
        let mut pf_len_overflow = blob_small.clone();
        pf_len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());

        let rk = hex_lower(&root_key);
        let ah = hex_lower(&account_hash);
        let oah = hex_lower(&other_account_hash);
        let aid = hex_lower(&attachment_id);
        let oaid = hex_lower(&other_attachment_id);
        let nh = hex_lower(&nonce);
        let kh = hex_lower(&*key);

        let mut d = alloc::string::String::new();
        d.push_str("{\n  \"schema\": \"attachment-text\",\n  \"protocol_version\": \"v0.1\",\n");
        d.push_str("  \"spec_section\": \"protocol.md §9.15 + §3.4 + §5.2 + §6.4\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_attachment_text_blob_raw + decode_attachment_text_blob byte mapping for the MYE1 per-attachment extracted-text codec (MYND-328; §9.15). Inner plaintext is OPAQUE (the desktop's postcard ExtractedText). attachment_text_key = derive_subkey(root_key, SubkeyRole::AttachmentTextKey) (HKDF role 'attachment-text-key'); the AAD (role 'attachment-text-blob') additionally binds attachment_id + extractor_version (v0.1 = 0x01). 13 cases: 3 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail (tag-tamper + cross-vault + wrong-attachment-id, all non-distinguishing §6.4) + 6 parse_fail (incl. the load-bearing extractor_version_unsupported forward hook). Generated by `cargo test -p protocol --lib emit_attachment_text_vectors_for_paste -- --ignored`.\",\n");
        d.push_str("  \"cases\": [\n");

        let emit_encrypt = |d: &mut alloc::string::String,
                            slug: &str,
                            desc: &str,
                            pt: &[u8],
                            blob: &[u8],
                            info: bool| {
            d.push_str("    {\n");
            d.push_str(&alloc::format!(
                "      \"vector_id\": \"attachment-text/v0.1/{}\",\n",
                slug
            ));
            d.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            d.push_str("      \"case_kind\": \"encrypt\",\n");
            d.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                rk
            ));
            d.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                ah
            ));
            d.push_str(&alloc::format!(
                "      \"input_attachment_id_hex\": \"{}\",\n",
                aid
            ));
            d.push_str(&alloc::format!(
                "      \"input_plaintext_hex\": \"{}\",\n",
                hex_lower(pt)
            ));
            d.push_str(&alloc::format!("      \"input_nonce_hex\": \"{}\",\n", nh));
            if info {
                d.push_str(&alloc::format!(
                    "      \"informational_attachment_text_key_hex\": \"{}\",\n",
                    kh
                ));
            }
            d.push_str(&alloc::format!(
                "      \"expected_attachment_text_blob_hex\": \"{}\"\n",
                hex_lower(blob)
            ));
            d.push_str("    },\n");
        };
        emit_encrypt(&mut d, "encrypt-empty", "Encode an empty inner plaintext. Smallest valid MYE1 blob: 34-byte header + 0 + 32-byte CTX tag = 66 bytes; ciphertext_len field = 32.", &pt_empty, &blob_empty, true);
        emit_encrypt(&mut d, "encrypt-small", "Encode a small opaque ExtractedText descriptor (illustrative JSON shape; the real payload is postcard).", &pt_small, &blob_small, false);
        emit_encrypt(&mut d, "encrypt-1kb", "Encode a 1024-byte plaintext where byte i = i mod 256. Blob = 34 + 1024 + 32 = 1090 bytes.", &pt_1kb, &blob_1kb, false);

        // decrypt_ok
        d.push_str("    {\n      \"vector_id\": \"attachment-text/v0.1/decrypt-ok-small\",\n");
        d.push_str(&alloc::format!("      \"description\": \"{}\",\n", json_escape("Round-trip the small blob under matching root_key (→ attachment_text_key) + account_number_hash + attachment_id.")));
        d.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_small)
        ));
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            rk
        ));
        d.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            ah
        ));
        d.push_str(&alloc::format!(
            "      \"input_attachment_id_hex\": \"{}\",\n",
            aid
        ));
        d.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n    }},\n",
            hex_lower(&pt_small)
        ));

        let emit_aead_fail = |d: &mut alloc::string::String,
                              slug: &str,
                              desc: &str,
                              blob: &[u8],
                              ah_arg: &str,
                              aid_arg: &str| {
            d.push_str("    {\n");
            d.push_str(&alloc::format!(
                "      \"vector_id\": \"attachment-text/v0.1/{}\",\n",
                slug
            ));
            d.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            d.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
            d.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            d.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                rk
            ));
            d.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                ah_arg
            ));
            d.push_str(&alloc::format!(
                "      \"input_attachment_id_hex\": \"{}\",\n",
                aid_arg
            ));
            d.push_str("      \"expected_kind\": \"aead_fail\"\n    },\n");
        };
        emit_aead_fail(&mut d, "decrypt-tampered-ctx-tag", "Final byte (inside the CTX tag) flipped via XOR 0xFF → non-distinguishing CannotDecrypt.", &blob_tag_tamper, &ah, &aid);
        emit_aead_fail(&mut d, "decrypt-cross-vault-account-hash", "Intact blob decrypted under a different account_number_hash (0x44×16) → AAD mismatch → CannotDecrypt.", &blob_small, &oah, &aid);
        emit_aead_fail(&mut d, "decrypt-wrong-attachment-id", "Intact blob decrypted under a different attachment_id (0x6b×32) → AAD mismatch → CannotDecrypt. The per-blob binding that makes one KEK safe across all attachment-text blobs.", &blob_small, &ah, &oaid);

        let emit_parse_fail = |d: &mut alloc::string::String,
                               slug: &str,
                               desc: &str,
                               blob: &[u8],
                               err: &str,
                               last: bool| {
            d.push_str("    {\n");
            d.push_str(&alloc::format!(
                "      \"vector_id\": \"attachment-text/v0.1/{}\",\n",
                slug
            ));
            d.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            d.push_str("      \"case_kind\": \"parse_fail\",\n");
            d.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            d.push_str(&alloc::format!("      \"expected_error\": \"{}\"\n", err));
            d.push_str(if last { "    }\n" } else { "    },\n" });
        };
        emit_parse_fail(
            &mut d,
            "parse-fail-magic-mismatch",
            "First magic byte corrupted to 'X' → rejected before decryption.",
            &pf_magic,
            "magic_mismatch",
            false,
        );
        emit_parse_fail(
            &mut d,
            "parse-fail-protocol-version-mismatch",
            "protocol_version (offset 4) = 0x02 → rejected.",
            &pf_version,
            "protocol_version_mismatch",
            false,
        );
        emit_parse_fail(&mut d, "parse-fail-extractor-version-unsupported", "extractor_version (offset 5) = 0x02 — a future extractor generation (incl. OCR, MYND-441) this client does not understand → rejected so the caller re-extracts. Load-bearing forward hook (§9.15).", &pf_extractor, "extractor_version_unsupported", false);
        emit_parse_fail(
            &mut d,
            "parse-fail-header-too-short",
            "Only the 4-byte MYE1 magic, no room for the 34-byte header.",
            &pf_header_short,
            "header_too_short",
            false,
        );
        emit_parse_fail(
            &mut d,
            "parse-fail-ciphertext-truncated",
            "Valid header advertising ciphertext_len N but blob is one byte short.",
            &pf_truncated,
            "ciphertext_truncated",
            false,
        );
        emit_parse_fail(&mut d, "parse-fail-ciphertext-len-overflow", "ciphertext_len = 0xFFFFFFFF, far above 4 MiB + 32 → overflow guard rejects before any slice index.", &pf_len_overflow, "ciphertext_len_overflow", true);

        d.push_str("  ]\n}\n");
        std::fs::write("/tmp/myne_attachment_text_vectors.json", d.as_bytes())
            .expect("write attachment-text vectors dump");
    }
}
