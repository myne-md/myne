// SPDX-License-Identifier: AGPL-3.0-only

//! `vault.personality` 34-byte-header encrypted agent-personality singleton
//! codec (myne-md/myne#697; `docs/spec/protocol.md` § 9.27).
//!
//! `vault.personality` is a vault-level singleton artifact carrying the
//! **agent-personality block**: the user's standing voice directives for the
//! AI (tone, length, language preferences, formatting habits). It is
//! Class-1 Authoritative data: synced, backed up, addressed by the reserved
//! blob-id `agent_personality_sync_id` (§ 3.4). It exists **only** when
//! `ai_enabled` is on (§ 9.25's gate, verbatim).
//!
//! It is **user-authored only**: the personality blob is written by the
//! Settings surface (and the mobile twin) and never by the agent (no verb
//! writes it, `decisions.md` 2026-09-10). The write path is a whole-value
//! replace, the prefs/themes singleton shape, and its inner plaintext is
//! canonical JSON of one object whose keys are emitted in lexicographic
//! order.
//!
//! ## On-disk layout (spec § 9.27.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYZ1" (v0.1) / "MYZ5" (v0.2)
//! 4       1     protocol_version     0x01 always (the singleton-family
//!                                     envelope convention)
//! 5       1     personality_format_version  0x01 (inner schema)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes, strict-trailing (§ 10.3.1). The
//! `personality_format_version` is NOT a plaintext key: it is the header
//! byte at offset 5, the singleton-family convention.
//!
//! ## Read semantic (spec § 9.27.3)
//!
//! Report-don't-empty, the § 9.23.3 rule verbatim: the personality is the
//! standing instruction set the agent's system turn is built from, and an
//! unreadable blob read as absent would, on the next write, persist that
//! absence over a real one.

use crate::aead::aad_agent_personality_blob;
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

/// Magic bytes at offset 0: ASCII `"MYZ1"` (Myne-personality v1; a
/// free-pool § 10.3 allocation, myne-md/myne#697).
pub const AGENT_PERSONALITY_BLOB_MAGIC: [u8; 4] = *b"MYZ1";

/// Magic bytes for the migrated v0.2 personality singleton: ASCII `"MYZ5"`
/// (§10.3 registry). A v0.2 vault's personality blob is written under this
/// magic + the v0.2 AAD prefix + a `derive_subkey_v0_2` KEK. Named in the
/// same change as the base magic (rule 5).
pub const AGENT_PERSONALITY_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYZ5";

/// AAD role string bound into both generations' `vault.personality` AAD.
pub const AGENT_PERSONALITY_BLOB_AAD_ROLE: &[u8] = b"personality-blob";

/// `protocol_version` byte at offset 4: always `0x01` (the envelope version,
/// not the vault generation; the generation travels in the magic + AAD, the
/// singleton-family convention).
pub const AGENT_PERSONALITY_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `personality_format_version` byte at offset 5: the schema generation that
/// produced the plaintext. `0x01` is the baseline (§ 9.27).
pub const AGENT_PERSONALITY_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const AGENT_PERSONALITY_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const AGENT_PERSONALITY_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (the canonical-JSON directives block).
/// 256 KiB (§ 9.27.3, the themes § 9.21.4 cap discipline).
pub const MAX_AGENT_PERSONALITY_PLAINTEXT_LEN: usize = 256 * 1024;

/// Failure modes of the agent-personality codec. Distinct variants for
/// observability; the caller REPORTS them (§ 9.27.3 report-don't-empty).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentPersonalityBlobError {
    /// Input shorter than [`AGENT_PERSONALITY_HEADER_LEN`] bytes.
    #[error("agent-personality blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYZ1`.
    #[error("agent-personality blob magic mismatch (expected MYZ1)")]
    MagicMismatch,
    /// `protocol_version` byte is neither `0x01` nor `0x02`.
    #[error("agent-personality blob protocol_version mismatch (expected 0x01 or 0x02)")]
    ProtocolVersionMismatch,
    /// `personality_format_version` is not understood by this client.
    #[error("agent-personality blob format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds
    /// [`MAX_AGENT_PERSONALITY_PLAINTEXT_LEN`] + 32.
    #[error("agent-personality blob ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob length does not equal `header + ciphertext_len` (§ 10.3.1
    /// strict-trailing).
    #[error("agent-personality blob length does not match its declared ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD,
    /// including a wrong `account_number_hash` or tampered version bytes,
    /// all AAD-bound).
    #[error("agent-personality blob AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds
    /// [`MAX_AGENT_PERSONALITY_PLAINTEXT_LEN`]. Refused rather than
    /// truncated (§ 9.27.3).
    #[error("agent-personality blob plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for agent-personality blob nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for AgentPersonalityBlobError {
    fn from(_: ProtocolError) -> Self {
        AgentPersonalityBlobError::CannotDecrypt
    }
}

crate::blob_envelope::impl_from_envelope_error!(AgentPersonalityBlobError);

/// Encode an agent-personality blob from an opaque `plaintext` (the client
/// layer's canonical-JSON directives block), sealing under
/// `agent_personality_key` with `nonce`. Bound to `account_number_hash` via
/// the AAD (§ 9.27.2).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source. Nonce reuse
/// under the same `agent_personality_key` is catastrophic. Production callers
/// SHOULD use [`encode_agent_personality_blob`], which pulls from `getrandom`.
pub fn encode_agent_personality_blob_raw(
    personality_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AgentPersonalityBlobError> {
    let aad = aad_agent_personality_blob(account_number_hash);
    encode_blob_envelope_raw(
        personality_key,
        &AGENT_PERSONALITY_BLOB_MAGIC,
        AGENT_PERSONALITY_FORMAT_VERSION,
        &aad,
        MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(AgentPersonalityBlobError::from)
}

/// Encode an agent-personality blob, pulling the 24-byte nonce from the OS
/// CSPRNG.
pub fn encode_agent_personality_blob(
    personality_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentPersonalityBlobError> {
    let aad = aad_agent_personality_blob(account_number_hash);
    encode_blob_envelope(
        personality_key,
        &AGENT_PERSONALITY_BLOB_MAGIC,
        AGENT_PERSONALITY_FORMAT_VERSION,
        &aad,
        MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(AgentPersonalityBlobError::from)
}

/// Version-aware seal of `vault.personality`: `MYZ1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYZ5` + v0.2 AAD for [`MetaVersion::V0_2`]. The
/// `personality_key` MUST be derived under the same generation
/// (`derive_subkey_versioned(version, root_key, AgentPersonalityKey)`).
pub fn encode_agent_personality_blob_versioned(
    version: MetaVersion,
    personality_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentPersonalityBlobError> {
    encode_singleton_versioned(
        version,
        personality_key,
        &AGENT_PERSONALITY_BLOB_MAGIC,
        &AGENT_PERSONALITY_BLOB_V0_2_MAGIC,
        AGENT_PERSONALITY_FORMAT_VERSION,
        AGENT_PERSONALITY_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(AgentPersonalityBlobError::from)
}

/// Decode an agent-personality blob into its opaque inner plaintext (the
/// canonical-JSON directives block, for the client layer to deserialize).
/// The generation is detected from the magic (`MYZ5` → v0.2, anything else
/// must be `MYZ1`); all structural checks run BEFORE any decryption, and
/// strict-trailing (§ 10.3.1) is enforced by the shared envelope. AEAD
/// failure (incl. a wrong `account_number_hash`, AAD-bound) collapses to
/// [`AgentPersonalityBlobError::CannotDecrypt`].
pub fn decode_agent_personality_blob(
    personality_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentPersonalityBlobError> {
    let version = if blob.get(0..4) == Some(AGENT_PERSONALITY_BLOB_V0_2_MAGIC.as_slice()) {
        MetaVersion::V0_2
    } else if blob.get(0..4) == Some(AGENT_PERSONALITY_BLOB_MAGIC.as_slice()) {
        MetaVersion::V0_1
    } else {
        if blob.len() < AGENT_PERSONALITY_HEADER_LEN {
            return Err(AgentPersonalityBlobError::HeaderTooShort);
        }
        return Err(AgentPersonalityBlobError::MagicMismatch);
    };
    decode_agent_personality_blob_versioned(version, personality_key, account_number_hash, blob)
}

/// Version-aware open of `vault.personality`: the mirror of
/// [`encode_agent_personality_blob_versioned`], selecting the expected magic
/// + AAD from `version`.
pub fn decode_agent_personality_blob_versioned(
    version: MetaVersion,
    personality_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentPersonalityBlobError> {
    let decoded = decode_singleton_versioned(
        version,
        personality_key,
        &AGENT_PERSONALITY_BLOB_MAGIC,
        &AGENT_PERSONALITY_BLOB_V0_2_MAGIC,
        AGENT_PERSONALITY_FORMAT_VERSION,
        AGENT_PERSONALITY_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
        blob,
    )
    .map_err(AgentPersonalityBlobError::from)?;
    // § 10.3.1 strict-trailing is enforced HERE, not inherited leniently
    // (the shared envelope reads exactly `ciphertext_len` bytes and ignores
    // a tail; a tolerated tail is unauthenticated bytes a syncing client
    // would persist and re-upload verbatim). The header read below is safe:
    // the shared decode already rejected short inputs.
    let declared = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
    if blob.len() != AGENT_PERSONALITY_HEADER_LEN + declared {
        return Err(AgentPersonalityBlobError::CiphertextTruncated);
    }
    Ok(decoded)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::aead::CTX_COMMITMENT_TAG_LEN;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x45; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN] =
        [0x7e; AGENT_PERSONALITY_ACCOUNT_HASH_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x9a; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_agent_personality_blob_raw(&KEY, &ACCOUNT_HASH, plaintext, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = br#"{"directives":[{"text":"Keep answers short and put the conclusion first.","updated_at":1725417600000}]}"#;
        let blob = encode(payload);
        let decoded = decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn header_layout_is_magic_versions_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYZ1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], AGENT_PERSONALITY_FORMAT_VERSION);
        assert_eq!(&blob[6..30], &NONCE);
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), AGENT_PERSONALITY_HEADER_LEN + 35);
    }

    #[test]
    fn v0_2_protocol_version_round_trips_under_its_own_stamp() {
        let payload = b"v0.2 directives";
        let blob = encode_agent_personality_blob_versioned(
            MetaVersion::V0_2,
            &KEY,
            &ACCOUNT_HASH,
            payload,
        )
        .expect("encode");
        assert_eq!(&blob[0..4], b"MYZ5");
        assert_eq!(blob[4], 0x01);
        let decoded =
            decode_agent_personality_blob_versioned(MetaVersion::V0_2, &KEY, &ACCOUNT_HASH, &blob)
                .expect("decode");
        assert_eq!(decoded.as_slice(), payload);
        let also = decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(also.as_slice(), payload);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentPersonalityBlobError::MagicMismatch)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"directives");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentPersonalityBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let blob = encode(b"directives");
        let other_hash = [0x46; AGENT_PERSONALITY_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_agent_personality_blob(&KEY, &other_hash, &blob),
            Err(AgentPersonalityBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn strict_trailing_bytes_reject() {
        let mut blob = encode(b"abc");
        blob.push(0x00);
        assert_eq!(
            decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentPersonalityBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn hostile_oversize_ciphertext_len_rejects_before_allocation() {
        let mut blob = encode(b"abc");
        let over_cap = (MAX_AGENT_PERSONALITY_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
        blob[30..34].copy_from_slice(&over_cap.to_be_bytes());
        assert_eq!(
            decode_agent_personality_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentPersonalityBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn over_cap_plaintext_refused_at_encode() {
        let too_big = vec![0x61u8; MAX_AGENT_PERSONALITY_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_agent_personality_blob_raw(&KEY, &ACCOUNT_HASH, &too_big, &NONCE),
            Err(AgentPersonalityBlobError::PlaintextTooLarge)
        );
    }

    /// Emits `myne-test-vectors/vectors/agent-personality/v0.2/cases.json`
    /// to stdout. `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_agent_personality_v0_2_vectors_for_paste -- --ignored --nocapture`
    ///
    /// v0.2: `encrypt` (MYZ5 envelope over the directives JSON, sealed under
    /// the v0.2 KEK + v0.2 AAD: the bytes the §10.4.1 migration writes) +
    /// `decode_fail_v0_1` (the v0.1 expectation refuses MYZ5 at the magic
    /// check, the §10.5 anti-downgrade pin). Deterministic nonce via the
    /// shared raw envelope assembler (the same function production's
    /// versioned encode delegates to, only the nonce source differs).
    #[test]
    #[ignore]
    fn emit_agent_personality_v0_2_vectors_for_paste() {
        extern crate std;
        use crate::aead::aad_singleton_blob_v0_2;
        use crate::blob_envelope::encode_blob_envelope_raw;
        use crate::subkey::{derive_subkey_versioned, SubkeyRole};
        use crate::test_vector_fmt::hex_lower;
        use alloc::string::String;

        let root_key: [u8; 32] = [0x42; 32];
        let personality_key_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            SubkeyRole::AgentPersonalityKey,
        );
        let account_hash: [u8; AGENT_PERSONALITY_ACCOUNT_HASH_LEN] = [0x33; 16];
        let nonce_v0_2: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];
        let pt: &[u8] =
            b"{\"directives\":[{\"text\":\"Keep answers short.\",\"updated_at\":1725417600000}]}";

        let blob_v0_2 = encode_blob_envelope_raw(
            &personality_key_v0_2,
            &AGENT_PERSONALITY_BLOB_V0_2_MAGIC,
            AGENT_PERSONALITY_FORMAT_VERSION,
            &aad_singleton_blob_v0_2(AGENT_PERSONALITY_BLOB_AAD_ROLE, &account_hash),
            MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
            pt,
            &nonce_v0_2,
        )
        .expect("encode v0.2");
        assert_eq!(&blob_v0_2[0..4], b"MYZ5");
        assert_eq!(blob_v0_2[4], AGENT_PERSONALITY_BLOB_PROTOCOL_VERSION);
        assert_eq!(&blob_v0_2[6..30], &nonce_v0_2);
        let dec_v0_2 = decode_agent_personality_blob_versioned(
            MetaVersion::V0_2,
            &personality_key_v0_2,
            &account_hash,
            &blob_v0_2,
        )
        .expect("decode v0.2");
        assert_eq!(dec_v0_2.as_slice(), pt);

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"agent-personality\",\n");
        d.push_str("  \"protocol_version\": \"v0.2\",\n");
        d.push_str("  \"spec_section\": \"protocol.md \\u00a79.27 + \\u00a710.4.1\",\n");
        d.push_str("  \"description\": \"Pins the migrated personality envelope (MYZ5): the v0.2 seal (v0.2 KEK + v0.2 AAD) over the directives bytes, and the v0.1 expectation refusing MYZ5.\",\n");
        d.push_str("  \"cases\": [\n");
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"agent-personality/v0.2/encrypt\",\n");
        d.push_str("      \"description\": \"Directives JSON sealed as MYZ5 under the v0.2 AAD. The header version byte stays 0x01 (the envelope version, not the generation).\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"expected_magic_ascii\": \"MYZ5\",\n      \"expected_blob_hex\": \"{}\",\n      \"expected_version_byte_hex\": \"01\"\n",
            hex_lower(&root_key),
            hex_lower(&account_hash),
            hex_lower(pt),
            hex_lower(&blob_v0_2),
        ));
        d.push_str("    },\n");
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"agent-personality/v0.2/rejects-v0-1-expectation\",\n");
        d.push_str("      \"description\": \"The MYZ5 blob refused under the v0.1 expectation (magic mismatch, before any decryption).\",\n");
        d.push_str("      \"case_kind\": \"decode_fail_v0_1\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"expected_error\": \"magic_mismatch\"\n",
            hex_lower(&blob_v0_2),
            hex_lower(&root_key),
            hex_lower(&account_hash),
        ));
        d.push_str("    }\n  ]\n}\n");
        std::println!("{d}");
    }
}
