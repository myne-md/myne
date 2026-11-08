// SPDX-License-Identifier: AGPL-3.0

//! `vault.agent-memory` 34-byte-header encrypted agent-memory catalog codec
//! (myne-md/myne#697; `agent-tooling/docs/spec/protocol.md` § 9.25).
//!
//! The catalog singleton holds the memory roster (one entry per persisted
//! memory: id, created/updated timestamps, causal `version`, deletion
//! tombstone § 9.25). It is the enumerable index over the per-entry `MYX1`
//! files of `agent_memory_entry_blob.rs` (§ 9.26), the same pair shape as
//! `vault.chats` (§ 9.23) over `chats/` (§ 9.24) and `vault.attachments`
//! (§ 9.10) over `attachments/` (§ 9.9). AEAD-encrypted under
//! `agent_memory_catalog_key = DeriveSubkey(root_key, SubkeyRole::AgentMemoryCatalogKey)`;
//! synced as one addressed singleton via the reserved
//! `agent_memory_catalog_sync_id` (§ 3.4).
//!
//! This codec is **payload-agnostic** like its singleton siblings: the inner
//! plaintext is the client layer's canonical-JSON roster map (§ 9.25); the
//! protocol crate owns only the crypto framing.
//!
//! ## On-disk layout (spec § 9.25.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 4       1     protocol_version     0x01 always (the envelope version; the
//!                                     generation travels in the magic + AAD,
//!                                     the singleton-family convention)
//! 5       1     memory_catalog_format_version  0x01 (roster schema generation)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes, strict-trailing (§ 10.3.1). Omitted-when-empty at
//! the FILE level: a vault with no memories has no `vault.agent-memory`
//! file at all, and the first memory write creates it (§ 9.25).
//!
//! ## Read semantic (spec § 9.25.3)
//!
//! Memory is load-bearing user content, so a read failure is an honest
//! error, never a silent empty (report-don't-empty): an unreadable catalog
//! read as empty would, on the next write, persist that emptiness over real
//! memory records.

use crate::aead::aad_agent_memory_catalog;
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

/// Magic bytes at offset 0: ASCII `"MYN1"` (Myne-memory catalog v1; a
/// free-pool § 10.3 allocation, myne-md/myne#697).
pub const AGENT_MEMORY_CATALOG_BLOB_MAGIC: [u8; 4] = *b"MYN1";

/// Magic bytes for the migrated v0.2 memory catalog: ASCII `"MYN5"`
/// (§10.3 registry). A v0.2 vault's catalog is written under this magic
/// with the v0.2 AAD prefix and a `derive_subkey_v0_2` KEK. Named in the
/// same change as the base magic (rule 5: a file naming a family's BASE
/// magic must also name every LATER generation of it).
pub const AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYN5";

/// AAD role string bound into both generations' `vault.agent-memory` AAD.
pub const AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE: &[u8] = b"agent-memory-catalog";

/// `protocol_version` byte at offset 4: always `0x01` (the envelope version,
/// not the vault generation; the generation travels in the magic + AAD, the
/// singleton-family convention shared with `encode_blob_envelope`).
pub const AGENT_MEMORY_CATALOG_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `memory_catalog_format_version` byte at offset 5: the roster-schema
/// generation that produced the plaintext. `0x01` is the baseline (§ 9.25).
/// A future schema bumps this so an older client rejects cleanly
/// ([`AgentMemoryCatalogError::FormatUnsupported`]).
pub const AGENT_MEMORY_CATALOG_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const AGENT_MEMORY_CATALOG_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (the canonical-JSON roster). 1 MiB
/// (§ 9.25.3, the themes § 9.21.4 cap precedent; tighter than the chats
/// catalog because a memory roster is bounded by design).
pub const MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN: usize = 1024 * 1024;

/// Failure modes of the agent-memory catalog codec. Distinct variants for
/// observability; the caller REPORTS them (§ 9.25.3 report-don't-empty:
/// never collapse to "no memories").
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentMemoryCatalogError {
    /// Input shorter than [`AGENT_MEMORY_CATALOG_HEADER_LEN`] bytes.
    #[error("agent-memory catalog too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYN1`.
    #[error("agent-memory catalog magic mismatch (expected MYN1)")]
    MagicMismatch,
    /// `protocol_version` byte is neither `0x01` nor `0x02`.
    #[error("agent-memory catalog protocol_version mismatch (expected 0x01 or 0x02)")]
    ProtocolVersionMismatch,
    /// `memory_catalog_format_version` is not understood by this client.
    #[error("agent-memory catalog format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds
    /// [`MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN`] + 32.
    #[error("agent-memory catalog ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob length does not equal `header + ciphertext_len` (§ 10.3.1
    /// strict-trailing).
    #[error("agent-memory catalog length does not match its declared ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD,
    /// including a wrong `account_number_hash` or tampered version bytes,
    /// all AAD-bound).
    #[error("agent-memory catalog AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds
    /// [`MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN`]. Refused rather than
    /// truncated (§ 9.25.3).
    #[error("agent-memory catalog plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for agent-memory catalog nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for AgentMemoryCatalogError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline).
        AgentMemoryCatalogError::CannotDecrypt
    }
}

crate::blob_envelope::impl_from_envelope_error!(AgentMemoryCatalogError);

/// Encode an agent-memory catalog blob from an opaque `plaintext` (the client
/// layer's canonical-JSON roster), sealing under `agent_memory_catalog_key`
/// with `nonce`. Bound to `account_number_hash` via the AAD (§ 9.25.2).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source. Nonce reuse
/// under the same `agent_memory_catalog_key` is catastrophic. Production
/// callers SHOULD use [`encode_agent_memory_catalog_blob`], which pulls from
/// `getrandom`.
pub fn encode_agent_memory_catalog_blob_raw(
    memory_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AgentMemoryCatalogError> {
    let aad = aad_agent_memory_catalog(account_number_hash);
    encode_blob_envelope_raw(
        memory_catalog_key,
        &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        AGENT_MEMORY_CATALOG_FORMAT_VERSION,
        &aad,
        MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(AgentMemoryCatalogError::from)
}

/// Encode an agent-memory catalog blob, pulling the 24-byte nonce from the
/// OS CSPRNG.
pub fn encode_agent_memory_catalog_blob(
    memory_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentMemoryCatalogError> {
    let aad = aad_agent_memory_catalog(account_number_hash);
    encode_blob_envelope(
        memory_catalog_key,
        &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        AGENT_MEMORY_CATALOG_FORMAT_VERSION,
        &aad,
        MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(AgentMemoryCatalogError::from)
}

/// Version-aware seal of `vault.agent-memory`: `MYN1` + v0.1 AAD for
/// `memory_catalog_key` MUST be derived under the same generation
/// (`derive_subkey_versioned(version, root_key, AgentMemoryCatalogKey)`).
pub fn encode_agent_memory_catalog_blob_versioned(
    version: MetaVersion,
    memory_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentMemoryCatalogError> {
    encode_singleton_versioned(
        version,
        memory_catalog_key,
        &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        &AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC,
        AGENT_MEMORY_CATALOG_FORMAT_VERSION,
        AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(AgentMemoryCatalogError::from)
}

/// Decode an agent-memory catalog blob into its opaque inner plaintext (the
/// canonical-JSON roster, for the client layer to deserialize). The generation
/// all structural checks run BEFORE any decryption, and strict-trailing
/// (§ 10.3.1) is enforced by the shared envelope. AEAD failure (incl. a wrong
/// `account_number_hash`, AAD-bound) collapses to
/// [`AgentMemoryCatalogError::CannotDecrypt`].
pub fn decode_agent_memory_catalog_blob(
    memory_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentMemoryCatalogError> {
    let version = if blob.get(0..4) == Some(AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC.as_slice()) {
        MetaVersion::V0_2
    } else if blob.get(0..4) == Some(AGENT_MEMORY_CATALOG_BLOB_MAGIC.as_slice()) {
        MetaVersion::V0_1
    } else {
        if blob.len() < AGENT_MEMORY_CATALOG_HEADER_LEN {
            return Err(AgentMemoryCatalogError::HeaderTooShort);
        }
        return Err(AgentMemoryCatalogError::MagicMismatch);
    };
    decode_agent_memory_catalog_blob_versioned(
        version,
        memory_catalog_key,
        account_number_hash,
        blob,
    )
}

/// Version-aware open of `vault.agent-memory`: the mirror of
/// [`encode_agent_memory_catalog_blob_versioned`], selecting the expected magic
/// + AAD from `version`.
pub fn decode_agent_memory_catalog_blob_versioned(
    version: MetaVersion,
    memory_catalog_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentMemoryCatalogError> {
    let decoded = decode_singleton_versioned(
        version,
        memory_catalog_key,
        &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        &AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC,
        AGENT_MEMORY_CATALOG_FORMAT_VERSION,
        AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE,
        account_number_hash,
        MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
        blob,
    )
    .map_err(AgentMemoryCatalogError::from)?;
    // § 10.3.1 strict-trailing is enforced HERE, not inherited leniently
    // (the shared envelope reads exactly `ciphertext_len` bytes and ignores
    // a tail; a tolerated tail is unauthenticated bytes a syncing client
    // would persist and re-upload verbatim). The header read below is safe:
    // the shared decode already rejected short inputs.
    let declared = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
    if blob.len() != AGENT_MEMORY_CATALOG_HEADER_LEN + declared {
        return Err(AgentMemoryCatalogError::CiphertextTruncated);
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
    const ACCOUNT_HASH: [u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN] =
        [0x7c; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x98; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_agent_memory_catalog_blob_raw(&KEY, &ACCOUNT_HASH, plaintext, &NONCE)
            .expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = b"{\"0184a2b3c4d5e6f708192a3b4c5d6e7f\":{\"created_at\":1725417600000,\"text\":\"The user prefers concise answers with the conclusion first.\",\"updated_at\":1725417600000,\"version\":3}}";
        let blob = encode(payload);
        let decoded = decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn header_layout_is_magic_versions_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYN1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], AGENT_MEMORY_CATALOG_FORMAT_VERSION);
        assert_eq!(&blob[6..30], &NONCE);
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), AGENT_MEMORY_CATALOG_HEADER_LEN + 35);
    }

    #[test]
    fn v0_2_protocol_version_round_trips_under_its_own_stamp() {
        // version byte stays 0x01 (the envelope version, not the generation).
        let payload = b"v0.2 roster";
        let blob = encode_agent_memory_catalog_blob_versioned(
            MetaVersion::V0_2,
            &KEY,
            &ACCOUNT_HASH,
            payload,
        )
        .expect("encode");
        assert_eq!(blob[4], 0x01);
        let decoded = decode_agent_memory_catalog_blob_versioned(
            MetaVersion::V0_2,
            &KEY,
            &ACCOUNT_HASH,
            &blob,
        )
        .expect("decode");
        assert_eq!(decoded.as_slice(), payload);
        let also = decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(also.as_slice(), payload);
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::MagicMismatch)
        );
    }

    #[test]
    fn unsupported_format_version_rejects() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future roster-schema generation
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::FormatUnsupported)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"roster");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let blob = encode(b"roster");
        let other_hash = [0x44; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &other_hash, &blob),
            Err(AgentMemoryCatalogError::CannotDecrypt)
        );
    }

    #[test]
    fn strict_trailing_bytes_reject() {
        let mut blob = encode(b"abc");
        blob.push(0x00);
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::CiphertextTruncated)
        );
    }

    #[test]
    fn truncated_relative_to_ciphertext_len_rejects() {
        let mut blob = encode(b"roster");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::CiphertextTruncated)
        );
    }

    #[test]
    fn hostile_oversize_ciphertext_len_rejects_before_allocation() {
        let mut blob = encode(b"abc");
        let over_cap = (MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
        blob[30..34].copy_from_slice(&over_cap.to_be_bytes());
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &blob),
            Err(AgentMemoryCatalogError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn over_cap_plaintext_refused_at_encode() {
        let too_big = vec![0x61u8; MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_agent_memory_catalog_blob_raw(&KEY, &ACCOUNT_HASH, &too_big, &NONCE),
            Err(AgentMemoryCatalogError::PlaintextTooLarge)
        );
    }

    #[test]
    fn at_cap_plaintext_encodes() {
        let at_cap = vec![0x61u8; MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN];
        let blob = encode_agent_memory_catalog_blob_raw(&KEY, &ACCOUNT_HASH, &at_cap, &NONCE)
            .expect("at-cap encode");
        assert_eq!(
            blob.len(),
            AGENT_MEMORY_CATALOG_HEADER_LEN + at_cap.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    #[test]
    fn v0_1_reader_rejects_v0_2_magic_before_decrypt() {
        // Cross-generation serve fails at the magic check (which runs first,
        // v0.1 catalog. The magic-detecting base decode still opens it (it
        // selects the generation from the magic).
        let payload = b"v0.2 roster";
        let blob = encode_agent_memory_catalog_blob_versioned(
            MetaVersion::V0_2,
            &KEY,
            &ACCOUNT_HASH,
            payload,
        )
        .expect("encode");
        let mut wrong_magic = blob.clone();
        wrong_magic[0] = b'X';
        assert_eq!(
            decode_agent_memory_catalog_blob(&KEY, &ACCOUNT_HASH, &wrong_magic),
            Err(AgentMemoryCatalogError::MagicMismatch)
        );
    }

    /// Emits `myne-test-vectors/vectors/agent-memory-catalog/v0.2/cases.json`
    /// to stdout. `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_agent_memory_catalog_v0_2_vectors_for_paste -- --ignored --nocapture`
    ///
    /// v0.2: `encrypt` (MYN5 envelope over the populated roster, sealed under
    /// the v0.2 KEK + v0.2 AAD: the bytes the §10.4.1 migration writes) +
    /// `decode_fail_v0_1` (the v0.1 expectation refuses MYN5 at the magic
    /// check, the §10.5 anti-downgrade pin). Deterministic nonce via the
    /// shared raw envelope assembler (the same function production's
    /// versioned encode delegates to, only the nonce source differs).
    #[test]
    #[ignore]
    fn emit_agent_memory_catalog_v0_2_vectors_for_paste() {
        extern crate std;
        use crate::aead::aad_singleton_blob_v0_2;
        use crate::subkey::{derive_subkey_versioned, SubkeyRole};
        use crate::test_vector_fmt::hex_lower;
        use alloc::string::String;

        let root_key: [u8; 32] = [0x42; 32];
        let catalog_key_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            SubkeyRole::AgentMemoryCatalogKey,
        );
        let account_hash: [u8; AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN] = [0x33; 16];
        let nonce_v0_2: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];
        let pt: &[u8] = b"{\"0184a2b3c4d5e6f708192a3b4c5d6e7f\":{\"created_at\":1725417600000,\"updated_at\":1725417600000,\"version\":3}}";

        let blob_v0_2 = encode_blob_envelope_raw(
            &catalog_key_v0_2,
            &AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC,
            AGENT_MEMORY_CATALOG_FORMAT_VERSION,
            &aad_singleton_blob_v0_2(AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE, &account_hash),
            MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
            pt,
            &nonce_v0_2,
        )
        .expect("encode v0.2");
        assert_eq!(&blob_v0_2[0..4], b"MYN5");
        assert_eq!(blob_v0_2[4], AGENT_MEMORY_CATALOG_BLOB_PROTOCOL_VERSION);
        assert_eq!(&blob_v0_2[6..30], &nonce_v0_2);
        let dec_v0_2 = decode_agent_memory_catalog_blob_versioned(
            MetaVersion::V0_2,
            &catalog_key_v0_2,
            &account_hash,
            &blob_v0_2,
        )
        .expect("decode v0.2");
        assert_eq!(dec_v0_2.as_slice(), pt);

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"agent-memory-catalog\",\n");
        d.push_str("  \"protocol_version\": \"v0.2\",\n");
        d.push_str("  \"spec_section\": \"protocol.md \\u00a79.25 + \\u00a710.4.1\",\n");
        d.push_str("  \"description\": \"Pins the migrated agent-memory catalog envelope (MYN5): the v0.2 seal (v0.2 KEK + v0.2 AAD) over the roster bytes, and the v0.1 expectation refusing MYN5.\",\n");
        d.push_str("  \"cases\": [\n");
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"agent-memory-catalog/v0.2/encrypt\",\n");
        d.push_str("      \"description\": \"Populated roster sealed as MYN5 under the v0.2 AAD. The header version byte stays 0x01 (the envelope version, not the generation).\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"expected_magic_ascii\": \"MYN5\",\n      \"expected_blob_hex\": \"{}\",\n      \"expected_version_byte_hex\": \"01\"\n",
            hex_lower(&root_key),
            hex_lower(&account_hash),
            hex_lower(pt),
            hex_lower(&blob_v0_2),
        ));
        d.push_str("    },\n");
        d.push_str("    {\n");
        d.push_str(
            "      \"vector_id\": \"agent-memory-catalog/v0.2/rejects-v0-1-expectation\",\n",
        );
        d.push_str("      \"description\": \"The MYN5 blob refused under the v0.1 expectation (magic mismatch, before any decryption).\",\n");
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
