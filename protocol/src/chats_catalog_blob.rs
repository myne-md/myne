// SPDX-License-Identifier: AGPL-3.0

//! `vault.chats` 34-byte-header encrypted AI conversations catalog codec
//! (myne-md/myne#675; `docs/spec/protocol.md` § 9.23).
//!
//! The catalog singleton holds the conversation roster (one entry per
//! persisted conversation: id, title, created/updated timestamps, causal
//! `version`, deletion tombstone (§ 9.23). It is the enumerable index over
//! the per-conversation `MYJ1` files of `chats_blob.rs` (§ 9.24), the same
//! pair shape as `vault.attachments` (§ 9.10) over `attachments/` (§ 9.9).
//! AEAD-encrypted under `chats_catalog_key = DeriveSubkey(root_key,
//! SubkeyRole::ChatsCatalogKey)`; synced as one addressed singleton via the
//! reserved `chats_catalog_sync_id` (§ 3.4).
//!
//! This codec is **payload-agnostic** like its singleton siblings: the inner
//! plaintext is the client layer's canonical-JSON roster map (§ 9.23); the
//! protocol crate owns only the crypto framing.
//!
//! ## On-disk layout (spec § 9.23.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYM1" (v0.1) / "MYM5" (v0.2)
//! 4       1     protocol_version     0x01 always (the envelope version; the
//!                                     generation travels in the magic + AAD,
//!                                     the singleton-family convention)
//! 5       1     chats_catalog_format_version  0x01 (roster schema generation)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes, strict-trailing (§ 10.3.1). Omitted-when-empty at
//! the FILE level: a vault with no conversations has no `vault.chats` file
//! at all, and the first conversation create writes it (§ 9.23).
//!
//! ## Read semantic (spec § 9.23.3)
//!
//! Conversations are load-bearing user content, so a read failure is an
//! honest error, never a silent empty (report-don't-empty, argued in
//! `decisions/ai/0575`): an unreadable catalog read as empty would, on the
//! next write, persist that emptiness over real conversation records.

use crate::aead::aad_chats_catalog;
use crate::aead::{AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_singleton_versioned, encode_blob_envelope, encode_blob_envelope_raw,
    encode_singleton_versioned, EnvelopeError,
};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0: ASCII `"MYM1"` (Myne Manifest/roster v1; a
/// free-pool § 10.3 allocation, myne-md/myne#675).
pub const CHATS_CATALOG_BLOB_MAGIC: [u8; 4] = *b"MYM1";

/// Magic bytes for the migrated v0.2 conversations catalog: ASCII `"MYM5"`
/// (§10.3 registry). A v0.2 vault's catalog is written under this magic +
/// the v0.2 AAD prefix + a `derive_subkey_v0_2` KEK. Named in the same
/// change as the base magic (rule 5).
pub const CHATS_CATALOG_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYM5";

/// AAD role string bound into both generations' `vault.chats` AAD.
pub const CHATS_CATALOG_BLOB_AAD_ROLE: &[u8] = b"chats-catalog";

/// `protocol_version` byte at offset 4: always `0x01` (the envelope version,
/// not the vault generation; the generation travels in the magic + AAD, the
/// singleton-family convention shared with `encode_blob_envelope`).
pub const CHATS_CATALOG_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `chats_catalog_format_version` byte at offset 5: the roster-schema
/// generation that produced the plaintext. `0x01` is the baseline (§ 9.23).
/// A future schema bumps this so an older client rejects cleanly
/// ([`ChatsCatalogError::FormatUnsupported`]).
pub const CHATS_CATALOG_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const CHATS_CATALOG_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const CHATS_CATALOG_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (the canonical-JSON roster). 4 MiB
/// (§ 9.23.3, the themes § 9.21.4 cap precedent).
pub const MAX_CHATS_CATALOG_PLAINTEXT_LEN: usize = 4 * 1024 * 1024;

/// Failure modes of the conversations-catalog codec. Distinct variants for
/// observability; the caller REPORTS them (§ 9.23.3 report-don't-empty:
/// never collapse to "no conversations").
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChatsCatalogError {
    /// Input shorter than [`CHATS_CATALOG_HEADER_LEN`] bytes.
    #[error("conversations catalog too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYM1`.
    #[error("conversations catalog magic mismatch (expected MYM1)")]
    MagicMismatch,
    /// `protocol_version` byte is neither `0x01` nor `0x02`.
    #[error("conversations catalog protocol_version mismatch (expected 0x01 or 0x02)")]
    ProtocolVersionMismatch,
    /// `chats_catalog_format_version` is not understood by this client.
    #[error("conversations catalog format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_CHATS_CATALOG_PLAINTEXT_LEN`] + 32.
    #[error("conversations catalog ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob length does not equal `header + ciphertext_len` (§ 10.3.1
    /// strict-trailing).
    #[error("conversations catalog length does not match its declared ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD,
    /// including a wrong `account_number_hash` or tampered version bytes,
    /// all AAD-bound).
    #[error("conversations catalog AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_CHATS_CATALOG_PLAINTEXT_LEN`].
    /// Refused rather than truncated (§ 9.23.3).
    #[error("conversations catalog plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for conversations catalog nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for ChatsCatalogError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        ChatsCatalogError::CannotDecrypt
    }
}

impl From<EnvelopeError> for ChatsCatalogError {
    /// Map the shared-envelope error into this codec's public variant so the
    /// distinguishable-reject surface stays unchanged.
    fn from(e: EnvelopeError) -> Self {
        match e {
            EnvelopeError::HeaderTooShort => ChatsCatalogError::HeaderTooShort,
            EnvelopeError::MagicMismatch => ChatsCatalogError::MagicMismatch,
            EnvelopeError::ProtocolVersionMismatch => ChatsCatalogError::ProtocolVersionMismatch,
            EnvelopeError::FormatUnsupported => ChatsCatalogError::FormatUnsupported,
            EnvelopeError::CiphertextLenOverflow => ChatsCatalogError::CiphertextLenOverflow,
            EnvelopeError::CiphertextTruncated => ChatsCatalogError::CiphertextTruncated,
            EnvelopeError::CannotDecrypt => ChatsCatalogError::CannotDecrypt,
            EnvelopeError::PlaintextTooLarge => ChatsCatalogError::PlaintextTooLarge,
            EnvelopeError::RandomnessUnavailable => ChatsCatalogError::RandomnessUnavailable,
        }
    }
}

/// Encode a conversations-catalog blob from an opaque `plaintext` (the client
/// layer's canonical-JSON roster), sealing under `chats_catalog_key` with
/// `nonce`. Bound to `account_number_hash` via the AAD (§ 9.23.2).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source. Nonce reuse
/// under the same `chats_catalog_key` is catastrophic. Production callers
/// SHOULD use [`encode_chats_catalog_blob`], which pulls from `getrandom`.
pub fn encode_chats_catalog_blob_raw(
    chats_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ChatsCatalogError> {
    let aad = aad_chats_catalog(account_number_hash);
    encode_blob_envelope_raw(
        chats_catalog_key,
        &CHATS_CATALOG_BLOB_MAGIC,
        CHATS_CATALOG_FORMAT_VERSION,
        &aad,
        MAX_CHATS_CATALOG_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(ChatsCatalogError::from)
}

/// Encode a conversations-catalog blob, pulling the 24-byte nonce from the
/// OS CSPRNG.
pub fn encode_chats_catalog_blob(
    chats_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ChatsCatalogError> {
    let aad = aad_chats_catalog(account_number_hash);
    encode_blob_envelope(
        chats_catalog_key,
        &CHATS_CATALOG_BLOB_MAGIC,
        CHATS_CATALOG_FORMAT_VERSION,
        &aad,
        MAX_CHATS_CATALOG_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(ChatsCatalogError::from)
}

/// Version-aware seal of `vault.chats`: `MYM1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYM5` + v0.2 AAD for [`MetaVersion::V0_2`]. The
/// `chats_catalog_key` MUST be derived under the same generation
/// (`derive_subkey_versioned(version, root_key, ChatsCatalogKey)`).
pub fn encode_chats_catalog_blob_versioned(
    version: MetaVersion,
    chats_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ChatsCatalogError> {
    encode_singleton_versioned(
        version,
        chats_catalog_key,
        &CHATS_CATALOG_BLOB_MAGIC,
        &CHATS_CATALOG_BLOB_V0_2_MAGIC,
        CHATS_CATALOG_FORMAT_VERSION,
        CHATS_CATALOG_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_CHATS_CATALOG_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(ChatsCatalogError::from)
}

/// Decode a conversations-catalog blob into its opaque inner plaintext (the
/// canonical-JSON roster, for the client layer to deserialize). The generation
/// is detected from the magic (`MYM5` → v0.2, anything else must be `MYM1`);
/// all structural checks run BEFORE any decryption, and strict-trailing
/// (§ 10.3.1) is enforced by the shared envelope. AEAD failure (incl. a wrong
/// `account_number_hash`, AAD-bound) collapses to
/// [`ChatsCatalogError::CannotDecrypt`].
pub fn decode_chats_catalog_blob(
    chats_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_CATALOG_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ChatsCatalogError> {
    let version = if blob.get(0..4) == Some(CHATS_CATALOG_BLOB_V0_2_MAGIC.as_slice()) {
        MetaVersion::V0_2
    } else if blob.get(0..4) == Some(CHATS_CATALOG_BLOB_MAGIC.as_slice()) {
        MetaVersion::V0_1
    } else {
        if blob.len() < CHATS_CATALOG_HEADER_LEN {
            return Err(ChatsCatalogError::HeaderTooShort);
        }
        return Err(ChatsCatalogError::MagicMismatch);
    };
    decode_chats_catalog_blob_versioned(version, chats_catalog_key, account_number_hash, blob)
}

/// Version-aware open of `vault.chats`: the mirror of
/// [`encode_chats_catalog_blob_versioned`], selecting the expected magic +
/// AAD from `version`.
pub fn decode_chats_catalog_blob_versioned(
    version: MetaVersion,
    chats_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_CATALOG_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ChatsCatalogError> {
    let decoded = decode_singleton_versioned(
        version,
        chats_catalog_key,
        &CHATS_CATALOG_BLOB_MAGIC,
        &CHATS_CATALOG_BLOB_V0_2_MAGIC,
        CHATS_CATALOG_FORMAT_VERSION,
        CHATS_CATALOG_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_CHATS_CATALOG_PLAINTEXT_LEN,
        blob,
    )
    .map_err(ChatsCatalogError::from)?;
    // § 10.3.1 strict-trailing is enforced HERE, not inherited leniently
    // (the shared envelope reads exactly `ciphertext_len` bytes and ignores
    // a tail; a tolerated tail is unauthenticated bytes a syncing client
    // would persist and re-upload verbatim). The header read below is safe:
    // the shared decode already rejected short inputs.
    let declared = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
    if blob.len() != CHATS_CATALOG_HEADER_LEN + declared {
        return Err(ChatsCatalogError::CiphertextTruncated);
    }
    Ok(decoded)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::aead::CTX_COMMITMENT_TAG_LEN;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x43; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; CHATS_CATALOG_ACCOUNT_HASH_LEN] =
        [0x7c; CHATS_CATALOG_ACCOUNT_HASH_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x98; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_chats_catalog_blob_raw(&KEY, &ACCOUNT_HASH, plaintext, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = b"{\"0184a2b3c4d5e6f708192a3b4c5d6e7f\":{\"created_at\":1725417600000,\"title\":\"Help me with taxes\",\"updated_at\":1725417600000,\"version\":3}}";
        let blob = encode(payload);
        let decoded = decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn empty_roster_round_trips() {
        // The first conversation create writes the file; an empty roster map
        // ("{}") is a legal mid-state (§ 9.23's file-level omit-when-empty is
        // a no-file rule, not a no-empty-plaintext rule).
        let blob = encode(b"{}");
        let decoded = decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), b"{}");
    }

    #[test]
    fn header_layout_is_magic_versions_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYM1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], CHATS_CATALOG_FORMAT_VERSION);
        assert_eq!(&blob[6..30], &NONCE);
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), CHATS_CATALOG_HEADER_LEN + 35);
    }

    #[test]
    fn v0_2_protocol_version_round_trips_under_its_own_stamp() {
        // The versioned entry points select MYM5 + the v0.2 AAD; the header
        // version byte stays 0x01 (the envelope version, not the generation).
        let payload = b"v0.2 roster";
        let blob =
            encode_chats_catalog_blob_versioned(MetaVersion::V0_2, &KEY, &ACCOUNT_HASH, payload)
                .expect("encode");
        assert_eq!(&blob[0..4], b"MYM5");
        assert_eq!(blob[4], 0x01);
        let decoded =
            decode_chats_catalog_blob_versioned(MetaVersion::V0_2, &KEY, &ACCOUNT_HASH, &blob)
                .expect("decode");
        assert_eq!(decoded.as_slice(), payload);
        // And the magic-detecting base decode opens the MYM5 blob too.
        let also = decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(also.as_slice(), payload);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::MagicMismatch)
        );
    }

    #[test]
    fn unsupported_format_version_rejects() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future roster-schema generation
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::FormatUnsupported)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"roster");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let blob = encode(b"roster");
        let other_hash = [0x44; CHATS_CATALOG_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &other_hash, &blob),
            Err(ChatsCatalogError::CannotDecrypt)
        );
    }

    #[test]
    fn strict_trailing_bytes_reject() {
        let mut blob = encode(b"abc");
        blob.push(0x00);
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::CiphertextTruncated)
        );
    }

    #[test]
    fn truncated_relative_to_ciphertext_len_rejects() {
        let mut blob = encode(b"roster");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::CiphertextTruncated)
        );
    }

    #[test]
    fn hostile_oversize_ciphertext_len_rejects_before_allocation() {
        let mut blob = encode(b"abc");
        let over_cap = (MAX_CHATS_CATALOG_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
        blob[30..34].copy_from_slice(&over_cap.to_be_bytes());
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(ChatsCatalogError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn over_cap_plaintext_refused_at_encode() {
        let too_big = vec![0x61u8; MAX_CHATS_CATALOG_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_chats_catalog_blob_raw(&KEY, &ACCOUNT_HASH, &too_big, &NONCE),
            Err(ChatsCatalogError::PlaintextTooLarge)
        );
    }

    #[test]
    fn at_cap_plaintext_encodes() {
        let at_cap = vec![0x61u8; MAX_CHATS_CATALOG_PLAINTEXT_LEN];
        let blob = encode_chats_catalog_blob_raw(&KEY, &ACCOUNT_HASH, &at_cap, &NONCE)
            .expect("at-cap encode");
        assert_eq!(
            blob.len(),
            CHATS_CATALOG_HEADER_LEN + at_cap.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    #[test]
    fn v0_1_reader_rejects_v0_2_magic_before_decrypt() {
        // Cross-generation serve fails at the magic check (which runs first,
        // like every family), before any decryption: a MYM5 blob is not a
        // v0.1 catalog. The magic-detecting base decode still opens it (it
        // selects the generation from the magic).
        let payload = b"v0.2 roster";
        let blob =
            encode_chats_catalog_blob_versioned(MetaVersion::V0_2, &KEY, &ACCOUNT_HASH, payload)
                .expect("encode");
        let mut wrong_magic = blob.clone();
        wrong_magic[0] = b'X';
        assert_eq!(
            decode_chats_catalog_blob(&KEY, &ACCOUNT_HASH, &wrong_magic),
            Err(ChatsCatalogError::MagicMismatch)
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits `myne-test-vectors/vectors/chats-catalog/v0.1/cases.json` to
    /// `/tmp/myne_chats_catalog_vectors.json` and the v0.2 side to
    /// `/tmp/myne_chats_catalog_v0_2_vectors.json`. `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_chats_catalog_vectors_for_paste -- --ignored`
    ///
    /// Cases (v0.1 case_kind): `encrypt` (MYM1 byte output over the roster
    /// plaintext, incl. empty `{}` and the tombstoned enrollment-seed roster),
    /// `decrypt_ok` (round-trip), `decrypt_aead_fail` (cross-vault + tamper,
    /// non-distinguishing), `parse_fail` (one per `ChatsCatalogError` decode
    /// reject). v0.2: `encrypt` (MYM5) + `decode_fail_v0_1` (the v0.1
    /// expectation refuses MYM5).
    ///
    /// The roster plaintexts are the client layer's canonical roster JSON
    /// (conversation-id keys sorted; per-entry keys alphabetical
    /// `created_at` < `deleted_at` < `title` < `updated_at` < `version`, with
    /// `version: 0` omitted and `deleted_at` present only on tombstones).
    /// The codec treats them as opaque bytes; the runner pins the bytes.
    #[test]
    #[ignore]
    fn emit_chats_catalog_vectors_for_paste() {
        extern crate std;
        use crate::subkey::{derive_subkey, SubkeyRole};
        use crate::test_vector_fmt::hex_lower;
        use alloc::string::String;

        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key = derive_subkey(&root_key, SubkeyRole::ChatsCatalogKey);
        let account_hash: [u8; CHATS_CATALOG_ACCOUNT_HASH_LEN] = [0x33; 16];
        let other_account_hash: [u8; CHATS_CATALOG_ACCOUNT_HASH_LEN] = [0x34; 16];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let pt_empty: &[u8] = b"{}";
        let pt_populated: &[u8] = "{\"0184a2b3c4d5e6f708192a3b4c5d6e7f\":{\"created_at\":1725417600000,\"title\":\"Help me with taxes\",\"updated_at\":1725417600000,\"version\":3},\"1184a2b3c4d5e6f708192a3b4c5d6e7f0\":{\"created_at\":1725417600001,\"title\":\"Görev listesi\",\"updated_at\":1725417700000}}".as_bytes();
        // A roster as an enrolling device receives it: one live conversation
        // beside a tombstone (deleted before the enrollment). The seed is
        // wholesale: the tombstone survives the decode intact, so the
        // conversation does not resurrect on the new device
        // (`sync-protocol.md` enrollment seed).
        let pt_tombstoned: &[u8] = br#"{"0184a2b3c4d5e6f708192a3b4c5d6e7f":{"created_at":1725417600000,"title":"Help me with taxes","updated_at":1725417600000,"version":3},"2184a2b3c4d5e6f708192a3b4c5d6e7f0":{"created_at":1725417500000,"deleted_at":1725417800000,"title":"Old draft","updated_at":1725417800000,"version":5}}"#;
        // A roster carrying the note anchor added by myne-md/myne#771. Pins the
        // lexicographic position of `note_id`, which sorts between `deleted_at`
        // and `title`; an implementation emitting sorted keys must match these
        // bytes.
        let pt_noteid: &[u8] = br#"{"0184a2b3c4d5e6f708192a3b4c5d6e7f":{"created_at":1725417600000,"note_id":"9f2ab3c4d5e6f708192a3b4c5d6e7f0","title":"Anchored to a note","updated_at":1725417600000,"version":1}}"#;

        let blob_empty =
            encode_chats_catalog_blob_raw(&catalog_key, &account_hash, pt_empty, &nonce)
                .expect("encode empty");
        let blob_populated =
            encode_chats_catalog_blob_raw(&catalog_key, &account_hash, pt_populated, &nonce)
                .expect("encode populated");
        let blob_tombstoned =
            encode_chats_catalog_blob_raw(&catalog_key, &account_hash, pt_tombstoned, &nonce)
                .expect("encode tombstoned");
        let blob_noteid =
            encode_chats_catalog_blob_raw(&catalog_key, &account_hash, pt_noteid, &nonce)
                .expect("encode note-anchored");

        // Round-trip sanity on every sealed plaintext.
        for (blob, pt) in [
            (&blob_empty, pt_empty),
            (&blob_populated, pt_populated),
            (&blob_tombstoned, pt_tombstoned),
            (&blob_noteid, pt_noteid),
        ] {
            let dec = decode_chats_catalog_blob(&catalog_key, &account_hash, blob)
                .expect("decode round-trip");
            assert_eq!(dec.as_slice(), pt);
        }

        // Tamper: flip the last ciphertext byte.
        let mut blob_tamper = blob_populated.clone();
        let last = blob_tamper.len() - 1;
        blob_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &blob_tamper),
            Err(ChatsCatalogError::CannotDecrypt)
        );
        // Cross-vault: the sealed bytes under another account hash.
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &other_account_hash, &blob_populated),
            Err(ChatsCatalogError::CannotDecrypt)
        );

        // Structural rejects, one per decode-reachable variant.
        let short: &[u8] = &[0u8; 10];
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, short),
            Err(ChatsCatalogError::HeaderTooShort)
        );
        let mut bad_magic = blob_populated.clone();
        bad_magic[0] = b'X';
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &bad_magic),
            Err(ChatsCatalogError::MagicMismatch)
        );
        let mut bad_version = blob_populated.clone();
        bad_version[4] = 0x09;
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &bad_version),
            Err(ChatsCatalogError::ProtocolVersionMismatch)
        );
        let mut bad_format = blob_populated.clone();
        bad_format[5] = 0x09;
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &bad_format),
            Err(ChatsCatalogError::FormatUnsupported)
        );
        let mut bad_len = blob_populated.clone();
        bad_len[30..34].copy_from_slice(&0x0050_0000u32.to_be_bytes());
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &bad_len),
            Err(ChatsCatalogError::CiphertextLenOverflow)
        );
        let mut truncated = blob_populated.clone();
        truncated.pop();
        assert_eq!(
            decode_chats_catalog_blob(&catalog_key, &account_hash, &truncated),
            Err(ChatsCatalogError::CiphertextTruncated)
        );

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"chats-catalog\",\n");
        d.push_str("  \"protocol_version\": \"v0.1\",\n");
        d.push_str("  \"spec_section\": \"protocol.md §9.23 + §5.2 + §3.4\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_chats_catalog_blob_raw + decode_chats_catalog_blob (MYM1) + aad_chats_catalog. Inner plaintext is the client layer's canonical roster JSON: object mapping conversation-id hex -> {created_at,deleted_at?,note_id?,title,updated_at,version?} with id keys sorted and per-entry keys alphabetical (version 0 omitted, deleted_at tombstones only, note_id on note-anchored rows only); empty roster = {}. KEK = DeriveSubkey(root,'chats-catalog-key'). Reference impl: protocol/src/chats_catalog_blob.rs.\",\n");
        d.push_str("  \"cases\": [\n");
        let mut first = true;
        let mut case = |id: &str, desc: &str, kind: &str, body: &str| {
            if !first {
                d.push_str(",\n");
            }
            first = false;
            d.push_str("    {\n");
            d.push_str(&alloc::format!("      \"vector_id\": \"{id}\",\n"));
            d.push_str(&alloc::format!("      \"description\": \"{desc}\",\n"));
            d.push_str(&alloc::format!("      \"case_kind\": \"{kind}\",\n"));
            d.push_str(body);
            d.push_str("    }");
        };
        let hex = |b: &[u8]| hex_lower(b);
        // encrypt empty
        case(
            "chats-catalog/v0.1/encrypt-empty",
            "Empty roster encodes inner plaintext {} then a MYM1 blob.",
            "encrypt",
            &alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n      \"input_catalog_nonce_hex\": \"{}\",\n      \"informational_catalog_key_hex\": \"{}\",\n      \"expected_catalog_blob_hex\": \"{}\"\n",
                hex(&root_key),
                hex(&account_hash),
                hex(pt_empty),
                hex(&nonce),
                hex(catalog_key.as_slice()),
                hex(&blob_empty),
            ),
        );
        // encrypt populated
        case(
            "chats-catalog/v0.1/encrypt-populated",
            "Two-entry roster; pins id-key sorting and per-entry created_at<title<updated_at<version order (version 0 omitted on the second row) plus a multibyte title.",
            "encrypt",
            &alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n      \"input_catalog_nonce_hex\": \"{}\",\n      \"informational_catalog_key_hex\": \"{}\",\n      \"expected_catalog_blob_hex\": \"{}\"\n",
                hex(&root_key),
                hex(&account_hash),
                hex(pt_populated),
                hex(&nonce),
                hex(catalog_key.as_slice()),
                hex(&blob_populated),
            ),
        );
        // encrypt tombstoned (enrollment seed)
        case(
            "chats-catalog/v0.1/encrypt-tombstoned",
            "A roster as an enrolling device receives it: a live conversation beside a tombstone. The tombstone keeps every field plus deleted_at, so the wholesale seed carries the deletion and the conversation does not resurrect.",
            "encrypt",
            &alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n      \"input_catalog_nonce_hex\": \"{}\",\n      \"informational_catalog_key_hex\": \"{}\",\n      \"expected_catalog_blob_hex\": \"{}\"\n",
                hex(&root_key),
                hex(&account_hash),
                hex(pt_tombstoned),
                hex(&nonce),
                hex(catalog_key.as_slice()),
                hex(&blob_tombstoned),
            ),
        );
        // encrypt note-anchored (myne-md/myne#771)
        case(
            "chats-catalog/v0.1/encrypt-note-anchored",
            "One conversation carrying note_id (myne-md/myne#771); pins its lexicographic position between deleted_at and title (created_at<note_id<title<updated_at<version).",
            "encrypt",
            &alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n      \"input_catalog_nonce_hex\": \"{}\",\n      \"informational_catalog_key_hex\": \"{}\",\n      \"expected_catalog_blob_hex\": \"{}\"\n",
                hex(&root_key),
                hex(&account_hash),
                hex(pt_noteid),
                hex(&nonce),
                hex(catalog_key.as_slice()),
                hex(&blob_noteid),
            ),
        );
        // decrypt_ok
        case(
            "chats-catalog/v0.1/decrypt-ok",
            "Decode the populated MYM1 blob back to roster plaintext.",
            "decrypt_ok",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
                hex(&blob_populated),
                hex(&root_key),
                hex(&account_hash),
                hex(pt_populated),
            ),
        );
        // decrypt_ok tombstoned
        case(
            "chats-catalog/v0.1/decrypt-ok-tombstoned",
            "Decode the tombstoned roster: the tombstone survives intact (deleted_at present), pinning the wholesale enrollment seed.",
            "decrypt_ok",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_plaintext_canonical_utf8_hex\": \"{}\"\n",
                hex(&blob_tombstoned),
                hex(&root_key),
                hex(&account_hash),
                hex(pt_tombstoned),
            ),
        );
        // decrypt_aead_fail tamper + cross-vault
        case(
            "chats-catalog/v0.1/decrypt-fail-tamper",
            "Last ciphertext byte flipped: non-distinguishing AEAD failure.",
            "decrypt_aead_fail",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_kind\": \"aead_fail\",\n      \"informational_tamper_description\": \"last ciphertext byte flipped\"\n",
                hex(&blob_tamper),
                hex(&root_key),
                hex(&account_hash),
            ),
        );
        case(
            "chats-catalog/v0.1/decrypt-fail-cross-vault",
            "Same blob under another account hash: non-distinguishing AEAD failure (the hash is AAD-bound).",
            "decrypt_aead_fail",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_kind\": \"aead_fail\",\n      \"informational_tamper_description\": \"account_number_hash swapped for 0x34 fill\"\n",
                hex(&blob_populated),
                hex(&root_key),
                hex(&other_account_hash),
            ),
        );
        // parse_fail x6
        let parse = |id: &str,
                     desc: &str,
                     blob: &[u8],
                     err: &str,
                     d: &mut String,
                     first: &mut bool| {
            if !*first {
                d.push_str(",\n");
            }
            *first = false;
            d.push_str("    {\n");
            d.push_str(&alloc::format!("      \"vector_id\": \"{id}\",\n"));
            d.push_str(&alloc::format!("      \"description\": \"{desc}\",\n"));
            d.push_str("      \"case_kind\": \"parse_fail\",\n");
            d.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_error\": \"{err}\"\n",
                hex_lower(blob),
                hex_lower(&root_key),
                hex_lower(&account_hash),
            ));
            d.push_str("    }");
        };
        parse(
            "chats-catalog/v0.1/parse-fail-header-too-short",
            "Ten bytes cannot hold a 34-byte header.",
            short,
            "header_too_short",
            &mut d,
            &mut first,
        );
        parse(
            "chats-catalog/v0.1/parse-fail-magic-mismatch",
            "First byte changed: not a catalog blob.",
            &bad_magic,
            "magic_mismatch",
            &mut d,
            &mut first,
        );
        parse(
            "chats-catalog/v0.1/parse-fail-protocol-version-mismatch",
            "Version byte 0x09 is neither 0x01 nor 0x02.",
            &bad_version,
            "protocol_version_mismatch",
            &mut d,
            &mut first,
        );
        parse(
            "chats-catalog/v0.1/parse-fail-format-unsupported",
            "Format byte 0x09 is not the 0x01 envelope this client reads.",
            &bad_format,
            "format_unsupported",
            &mut d,
            &mut first,
        );
        parse(
            "chats-catalog/v0.1/parse-fail-ciphertext-len-overflow",
            "Declared length exceeds the 4 MiB plaintext cap plus tag.",
            &bad_len,
            "ciphertext_len_overflow",
            &mut d,
            &mut first,
        );
        parse(
            "chats-catalog/v0.1/parse-fail-ciphertext-truncated",
            "One byte shaved off the end: strict-trailing total-length check.",
            &truncated,
            "ciphertext_truncated",
            &mut d,
            &mut first,
        );
        d.push_str("\n  ]\n}\n");
        std::fs::write("/tmp/myne_chats_catalog_vectors.json", d.as_bytes())
            .expect("write chats-catalog vectors dump");

        // v0.2 side: MYM5 envelope over the same populated roster, plus the
        // cross-generation refusal the v0.1 expectation owes. Sealed under
        // the v0.2 KEK (derive_subkey_versioned, the migration's own
        // derivation), not the v0.1 one: the vector must pin what production
        // writes, and production never seals a v0.2 envelope under a v0.1 KEK.
        //
        // Deterministic nonce via the shared raw envelope assembler (the same
        // function production's versioned encode delegates to (only the
        // nonce source differs), because a getrandom nonce would make the
        // emitter unreproducible and the vector unpinnable.
        use crate::aead::aad_singleton_blob_v0_2;
        use crate::subkey::derive_subkey_versioned;
        let catalog_key_v0_2 =
            derive_subkey_versioned(MetaVersion::V0_2, &root_key, SubkeyRole::ChatsCatalogKey);
        let nonce_v0_2: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];
        let blob_v0_2 = encode_blob_envelope_raw(
            &catalog_key_v0_2,
            &CHATS_CATALOG_BLOB_V0_2_MAGIC,
            CHATS_CATALOG_FORMAT_VERSION,
            &aad_singleton_blob_v0_2(CHATS_CATALOG_BLOB_AAD_ROLE, &account_hash),
            MAX_CHATS_CATALOG_PLAINTEXT_LEN,
            pt_populated,
            &nonce_v0_2,
        )
        .expect("encode v0.2");
        assert_eq!(&blob_v0_2[0..4], b"MYM5");
        assert_eq!(blob_v0_2[4], CHATS_CATALOG_BLOB_PROTOCOL_VERSION);
        assert_eq!(&blob_v0_2[6..30], &nonce_v0_2);
        let dec_v0_2 = decode_chats_catalog_blob_versioned(
            MetaVersion::V0_2,
            &catalog_key_v0_2,
            &account_hash,
            &blob_v0_2,
        )
        .expect("decode v0.2");
        assert_eq!(dec_v0_2.as_slice(), pt_populated);
        assert!(
            decode_chats_catalog_blob_versioned(
                MetaVersion::V0_1,
                &catalog_key,
                &account_hash,
                &blob_v0_2
            )
            .is_err(),
            "a MYM5 blob must not open under the v0.1 expectation"
        );
        let mut d2 = String::new();
        d2.push_str("{\n");
        d2.push_str("  \"schema\": \"chats-catalog\",\n");
        d2.push_str("  \"protocol_version\": \"v0.2\",\n");
        d2.push_str("  \"spec_section\": \"protocol.md §9.23 + §10.4.1\",\n");
        d2.push_str("  \"description\": \"Pins the migrated chats catalog envelope (MYM5): the v0.2 seal (v0.2 KEK + v0.2 AAD) over the same roster bytes, and the bidirectional generation refusal (v0.1 expectation refuses MYM5).\",\n");
        d2.push_str("  \"cases\": [\n");
        d2.push_str("    {\n");
        d2.push_str("      \"vector_id\": \"chats-catalog/v0.2/encrypt\",\n");
        d2.push_str("      \"description\": \"Populated roster sealed as MYM5 under the v0.2 AAD. The header version byte stays 0x01 (the envelope version, not the generation), like the themes family.\",\n");
        d2.push_str("      \"case_kind\": \"encrypt\",\n");
        d2.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"expected_magic_ascii\": \"MYM5\",\n      \"expected_blob_hex\": \"{}\",\n      \"expected_version_byte_hex\": \"01\"\n",
            hex(&root_key),
            hex(&account_hash),
            hex(pt_populated),
            hex(&blob_v0_2),
        ));
        d2.push_str("    },\n");
        d2.push_str("    {\n");
        d2.push_str("      \"vector_id\": \"chats-catalog/v0.2/rejects-v0-1-expectation\",\n");
        d2.push_str("      \"description\": \"The MYM5 blob refused under the v0.1 expectation (magic mismatch, before any decryption).\",\n");
        d2.push_str("      \"case_kind\": \"decode_fail_v0_1\",\n");
        d2.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_error\": \"magic_mismatch\"\n",
            hex(&blob_v0_2),
            hex(&root_key),
            hex(&account_hash),
        ));
        d2.push_str("    }\n  ]\n}\n");
        std::fs::write("/tmp/myne_chats_catalog_v0_2_vectors.json", d2.as_bytes())
            .expect("write chats-catalog v0.2 vectors dump");

        // Paste lines for the hkdf-sha256 + aad-construction families.
        std::println!(
            "HKDF chats-catalog-key: {}",
            hex_lower(derive_subkey(&root_key, SubkeyRole::ChatsCatalogKey).as_slice())
        );
        std::println!(
            "HKDF chats-catalog-sync-id: {}",
            hex_lower(derive_subkey(&root_key, SubkeyRole::ChatsCatalogSyncId).as_slice())
        );
        std::println!(
            "HKDF chats-key: {}",
            hex_lower(derive_subkey(&root_key, SubkeyRole::ChatsKey).as_slice())
        );
        std::println!(
            "AAD chats-catalog: {}",
            hex_lower(&aad_chats_catalog(&account_hash))
        );
    }
}
