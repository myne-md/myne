// SPDX-License-Identifier: AGPL-3.0

//! `memories/<memory-id-hex>` 34-byte-header encrypted agent-memory entry
//! codec (myne-md/myne#697; `docs/spec/protocol.md` § 9.26).
//!
//! Each persisted agent-memory entry gets one file under
//! `<vault-root>/memories/`, named by the lowercase-hex 16-byte entry UUIDv7,
//! holding the entry's distilled text. The blob is AEAD-encrypted under
//! `agent_memory_key = DeriveSubkey(root_key, SubkeyRole::AgentMemoryKey)`:
//! ONE KEK for the whole family; per-entry separation comes from the
//! `memory_entry_id` AAD binding (§ 9.26.3), the `MYE1` attachment-text
//! archetype. The catalog half of the pair is
//! `agent_memory_catalog_blob.rs` (`MYN1`, § 9.25).
//!
//! This codec is **payload-agnostic** like its singleton siblings: the inner
//! plaintext is the client layer's canonical-JSON entry object (§ 9.26.2);
//! the protocol crate owns only the crypto framing (magic, versions, AEAD,
//! AAD), which are the load-bearing parts.
//!
//! ## On-disk layout (spec § 9.26.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYX1"
//! 4       1     protocol_version     0x01 (v0.1) / 0x02 (v0.2 vaults)
//! 5       1     memory_blob_format_version 0x01 (inner entry schema)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes, strict-trailing (§ 10.3.1). The `memory_entry_id`
//! is NOT a header field: the file name carries it and the AAD binds it
//! cryptographically, so a blob can never be served for the wrong entry.
//!
//! ## Read semantic (spec § 9.26.4)
//!
//! Unlike the cosmetic singletons this family carries **load-bearing user
//! content**, so a read failure is an honest error, never a silent empty
//! (§ 9.25.3's report-don't-empty rule).

use crate::aead::{
    aad_agent_memory_blob, aad_agent_memory_blob_v0_2, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0: ASCII `"MYX1"` (Myne-memory entry v1; a
/// free-pool § 10.3 allocation, myne-md/myne#697).
pub const AGENT_MEMORY_BLOB_MAGIC: [u8; 4] = *b"MYX1";

/// Magic bytes for the migrated v0.2 memory-entry family: ASCII `"MYX5"`
/// (§10.3 registry). A v0.2 vault's entry files are written under this magic
/// with the v0.2 AAD prefix and a `derive_subkey_v0_2` KEK. Named in the
/// same change as the base magic (rule 5).
pub const AGENT_MEMORY_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYX5";

/// AAD role string bound into both generations' memory-entry AAD.
pub const AGENT_MEMORY_BLOB_AAD_ROLE: &[u8] = b"agent-memory-blob";

/// `protocol_version` byte at offset 4. Follows the family convention: `0x01`
/// on a v0.1 vault, `0x02` on a v0.2 vault. The magic does not change across
/// generations? It does: one magic + one version byte per generation (the
/// attachments-family convention), so both travel together and a reader
/// rejects the mismatched pair at the header.
pub const AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_1: u8 = 0x01;
pub const AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_2: u8 = 0x02;

/// `memory_blob_format_version` byte at offset 5: the entry-schema generation
/// that produced the plaintext. `0x01` is the baseline (§ 9.26).
pub const AGENT_MEMORY_BLOB_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the 16-byte `memory_entry_id` bound into the AAD (and carried
/// by the file name).
pub const MEMORY_ENTRY_ID_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const AGENT_MEMORY_BLOB_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (the canonical-JSON entry). 256 KiB
/// (§ 9.26.4; generous ~100x over the 2000-character text cap and still
/// refuses allocation at the § 9.5.4 DoS discipline).
pub const MAX_AGENT_MEMORY_PLAINTEXT_LEN: usize = 256 * 1024;

/// Failure modes of the per-entry agent-memory codec. Distinct variants for
/// observability; the caller REPORTS them (§ 9.26.4 report-don't-empty).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum AgentMemoryBlobError {
    /// Input shorter than [`AGENT_MEMORY_BLOB_HEADER_LEN`] bytes.
    #[error("agent-memory entry blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are neither `MYX1` (v0.1) nor `MYX5` (v0.2).
    #[error("agent-memory entry blob magic mismatch (expected MYX1 or MYX5)")]
    MagicMismatch,
    /// `protocol_version` byte does not match the expected generation.
    #[error("agent-memory entry blob protocol_version mismatch")]
    ProtocolVersionMismatch,
    /// `memory_blob_format_version` is not understood by this client.
    #[error("agent-memory entry blob format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_AGENT_MEMORY_PLAINTEXT_LEN`] + 32.
    #[error("agent-memory entry blob ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob length does not equal `header + ciphertext_len` (§ 10.3.1
    /// strict-trailing).
    #[error("agent-memory entry blob length does not match its declared ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD,
    /// including a wrong `memory_entry_id` or `account_number_hash`, both
    /// AAD-bound). Non-distinguishing per § 6.4.
    #[error("agent-memory entry blob AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_AGENT_MEMORY_PLAINTEXT_LEN`].
    /// Refused rather than truncated (§ 9.26.4).
    #[error("agent-memory entry blob plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for agent-memory entry blob nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for AgentMemoryBlobError {
    fn from(_: ProtocolError) -> Self {
        AgentMemoryBlobError::CannotDecrypt
    }
}

/// Encode a `MYX1` memory-entry blob from caller-supplied randomness
/// (`_raw`). The inner plaintext is opaque: the client layer's canonical-JSON
/// entry object (§ 9.26.2). Production callers SHOULD use
/// [`encode_agent_memory_blob`], which pulls randomness from `getrandom`.
pub fn encode_agent_memory_blob_raw(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    if plaintext.len() > MAX_AGENT_MEMORY_PLAINTEXT_LEN {
        return Err(AgentMemoryBlobError::PlaintextTooLarge);
    }

    let aad = aad_agent_memory_blob(account_number_hash, memory_entry_id);
    let sealed = aead_seal_ctx(memory_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(AGENT_MEMORY_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&AGENT_MEMORY_BLOB_MAGIC);
    out.push(AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_1);
    out.push(AGENT_MEMORY_BLOB_FORMAT_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a memory-entry blob, pulling the 24-byte nonce from the OS CSPRNG.
pub fn encode_agent_memory_blob(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| AgentMemoryBlobError::RandomnessUnavailable)?;
    let result = encode_agent_memory_blob_raw(
        memory_key,
        account_number_hash,
        memory_entry_id,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Encode a `MYX5` memory-entry blob from caller-supplied randomness
/// (`_raw`). The v0.2 mirror of [`encode_agent_memory_blob_raw`]: same § 9.26
/// byte layout, `MYX5` magic + `0x02` version, v0.2 AAD.
pub fn encode_agent_memory_blob_v0_2_raw(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    if plaintext.len() > MAX_AGENT_MEMORY_PLAINTEXT_LEN {
        return Err(AgentMemoryBlobError::PlaintextTooLarge);
    }

    let aad = aad_agent_memory_blob_v0_2(account_number_hash, memory_entry_id);
    let sealed = aead_seal_ctx(memory_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(AGENT_MEMORY_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&AGENT_MEMORY_BLOB_V0_2_MAGIC);
    out.push(AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_2);
    out.push(AGENT_MEMORY_BLOB_FORMAT_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `MYX5` memory-entry blob, pulling the 24-byte nonce from the OS
/// CSPRNG.
pub fn encode_agent_memory_blob_v0_2(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| AgentMemoryBlobError::RandomnessUnavailable)?;
    let result = encode_agent_memory_blob_v0_2_raw(
        memory_key,
        account_number_hash,
        memory_entry_id,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Version-aware seal of a memory-entry file: `MYX1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYX5` + v0.2 AAD for [`MetaVersion::V0_2`]. The
/// `memory_key` MUST be derived under the same generation
/// (`derive_subkey_versioned(version, root_key, AgentMemoryKey)`).
pub fn encode_agent_memory_blob_versioned(
    version: MetaVersion,
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| AgentMemoryBlobError::RandomnessUnavailable)?;
    let result = match version {
        MetaVersion::V0_1 => encode_agent_memory_blob_raw(
            memory_key,
            account_number_hash,
            memory_entry_id,
            plaintext,
            &nonce,
        ),
        MetaVersion::V0_2 => encode_agent_memory_blob_v0_2_raw(
            memory_key,
            account_number_hash,
            memory_entry_id,
            plaintext,
            &nonce,
        ),
    };
    nonce.zeroize();
    result
}

/// Re-seal one memory-entry file across the v0.1 → v0.2 cut (`MYX1` →
/// `MYX5`, v0.1 AAD → v0.2 AAD, v0.1 KEK → v0.2 KEK) for the whole-vault
/// migration (§10.4.1). Decode under the old generation, re-encode under the
/// new one; the inner entry passes through opaquely. Any failure (AEAD,
/// schema, cap) is an error the caller scopes: a single dead entry must not
/// strand a half-rewritten vault (the attachments `continue`-on-failure
/// discipline).
pub fn reseal_agent_memory_blob_v0_2(
    old_blob: &[u8],
    old_key: &[u8; AEAD_KEY_LEN],
    new_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
) -> Result<Vec<u8>, AgentMemoryBlobError> {
    let plaintext =
        decode_agent_memory_blob(old_key, account_number_hash, memory_entry_id, old_blob)?;
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| AgentMemoryBlobError::RandomnessUnavailable)?;
    let result = encode_agent_memory_blob_v0_2_raw(
        new_key,
        account_number_hash,
        memory_entry_id,
        &plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Decode a memory-entry blob into its opaque inner plaintext (the
/// canonical-JSON entry object, for the client layer to deserialize). Magic /
/// protocol_version / format_version / caps are all checked BEFORE any
/// decryption; strict-trailing (§ 10.3.1) is enforced here rather than
/// inherited leniently. AEAD failure (incl. a wrong `memory_entry_id` or
/// `account_number_hash`, both AAD-bound) collapses to
/// [`AgentMemoryBlobError::CannotDecrypt`]. The caller supplies the same
/// `memory_entry_id` the blob was sealed for (the file name it was read
/// from) and its vault's `protocol_version`.
pub fn decode_agent_memory_blob(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentMemoryBlobError> {
    decode_agent_memory_blob_versioned(
        MetaVersion::V0_1,
        memory_key,
        account_number_hash,
        memory_entry_id,
        blob,
    )
}

/// Open a `MYX5` memory-entry blob (v0.2 generation only).
pub fn decode_agent_memory_blob_v0_2(
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentMemoryBlobError> {
    decode_agent_memory_blob_versioned(
        MetaVersion::V0_2,
        memory_key,
        account_number_hash,
        memory_entry_id,
        blob,
    )
}

/// Version-aware open of a memory-entry file: `MYX1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYX5` + v0.2 AAD for [`MetaVersion::V0_2`].
/// One magic + one version byte per generation (the attachments-family
/// convention): v0.1 is `MYX1`/`0x01`, v0.2 is `MYX5`/`0x02`.
pub fn decode_agent_memory_blob_versioned(
    version: MetaVersion,
    memory_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN],
    memory_entry_id: &[u8; MEMORY_ENTRY_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, AgentMemoryBlobError> {
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < AGENT_MEMORY_BLOB_HEADER_LEN {
        return Err(AgentMemoryBlobError::HeaderTooShort);
    }
    let (expected_magic, expected_version, aad) = match version {
        MetaVersion::V0_1 => (
            AGENT_MEMORY_BLOB_MAGIC,
            AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_1,
            aad_agent_memory_blob(account_number_hash, memory_entry_id),
        ),
        MetaVersion::V0_2 => (
            AGENT_MEMORY_BLOB_V0_2_MAGIC,
            AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_2,
            aad_agent_memory_blob_v0_2(account_number_hash, memory_entry_id),
        ),
    };
    if blob[0..4] != expected_magic {
        return Err(AgentMemoryBlobError::MagicMismatch);
    }
    if blob[4] != expected_version {
        return Err(AgentMemoryBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != AGENT_MEMORY_BLOB_FORMAT_VERSION {
        return Err(AgentMemoryBlobError::FormatUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > MAX_AGENT_MEMORY_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(AgentMemoryBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = AGENT_MEMORY_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(AgentMemoryBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let plaintext = aead_open_ctx(
        memory_key,
        &nonce,
        &blob[AGENT_MEMORY_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;

    // § 10.3.1 strict-trailing: reject a tail the layout does not declare.
    if blob.len() != ciphertext_end {
        return Err(AgentMemoryBlobError::CiphertextTruncated);
    }

    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x44; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN] =
        [0x7d; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN];
    const ENTRY: [u8; MEMORY_ENTRY_ID_LEN] = [0x5a; MEMORY_ENTRY_ID_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_agent_memory_blob_raw(&KEY, &ACCOUNT_HASH, &ENTRY, plaintext, &NONCE)
            .expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload = br#"{"source_conversation":"0184a2b3c4d5e6f708192a3b4c5d6e7f","text":"The user prefers concise answers with the conclusion first."}"#;
        let blob = encode(payload);
        let decoded = decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn header_layout_is_magic_versions_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYX1");
        assert_eq!(blob[4], 0x01);
        assert_eq!(blob[5], AGENT_MEMORY_BLOB_FORMAT_VERSION);
        assert_eq!(&blob[6..30], &NONCE);
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), AGENT_MEMORY_BLOB_HEADER_LEN + 35);
    }

    #[test]
    fn v0_2_stamp_round_trips_and_magic_detects_nothing() {
        // The per-entry family has no magic-detecting base decode (the caller
        // supplies the generation), so a MYX5 blob under the v0.1 decode is a
        // magic mismatch, not a silent cross-generation read.
        let payload = b"v0.2 entry";
        let blob = encode_agent_memory_blob_v0_2_raw(&KEY, &ACCOUNT_HASH, &ENTRY, payload, &NONCE)
            .expect("encode");
        assert_eq!(&blob[0..4], b"MYX5");
        assert_eq!(blob[4], 0x02);
        let decoded =
            decode_agent_memory_blob_v0_2(&KEY, &ACCOUNT_HASH, &ENTRY, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::MagicMismatch)
        );
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::MagicMismatch)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"entry");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        let blob = encode(b"entry");
        let other_hash = [0x45; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_agent_memory_blob(&KEY, &other_hash, &ENTRY, &blob),
            Err(AgentMemoryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_entry_id_fails_aead() {
        // The per-entry binding (the MYE1 archetype) is what lets one KEK
        // serve every entry file: a different entry id fails the AEAD tag.
        let blob = encode(b"entry");
        let other_entry = [0x5b; MEMORY_ENTRY_ID_LEN];
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &other_entry, &blob),
            Err(AgentMemoryBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn strict_trailing_bytes_reject() {
        let mut blob = encode(b"abc");
        blob.push(0x00);
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn truncated_relative_to_ciphertext_len_rejects() {
        let mut blob = encode(b"entry");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn hostile_oversize_ciphertext_len_rejects_before_allocation() {
        let mut blob = encode(b"abc");
        let over_cap = (MAX_AGENT_MEMORY_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
        blob[30..34].copy_from_slice(&over_cap.to_be_bytes());
        assert_eq!(
            decode_agent_memory_blob(&KEY, &ACCOUNT_HASH, &ENTRY, &blob),
            Err(AgentMemoryBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn over_cap_plaintext_refused_at_encode() {
        let too_big = vec![0x61u8; MAX_AGENT_MEMORY_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_agent_memory_blob_raw(&KEY, &ACCOUNT_HASH, &ENTRY, &too_big, &NONCE),
            Err(AgentMemoryBlobError::PlaintextTooLarge)
        );
    }

    #[test]
    fn at_cap_plaintext_encodes() {
        let at_cap = vec![0x61u8; MAX_AGENT_MEMORY_PLAINTEXT_LEN];
        let blob = encode_agent_memory_blob_raw(&KEY, &ACCOUNT_HASH, &ENTRY, &at_cap, &NONCE)
            .expect("at-cap encode");
        assert_eq!(
            blob.len(),
            AGENT_MEMORY_BLOB_HEADER_LEN + at_cap.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    /// Emits `myne-test-vectors/vectors/agent-memory-blob/v0.2/cases.json`
    /// to stdout. `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_agent_memory_blob_v0_2_vectors_for_paste -- --ignored --nocapture`
    ///
    /// v0.2: `encrypt` (MYX5 envelope over the entry plaintext, sealed under
    /// the v0.2 KEK + v0.2 per-entry AAD: the bytes the §10.4.1 migration's
    /// 5b2 leg writes) + `decode_fail_v0_1` (the v0.1 expectation refuses
    /// MYX5 at the magic check, the §10.5 anti-downgrade pin). Deterministic
    /// nonce via the `_v0_2_raw` entry point (the same function production's
    /// versioned encode delegates to, only the nonce source differs).
    #[test]
    #[ignore]
    fn emit_agent_memory_blob_v0_2_vectors_for_paste() {
        extern crate std;
        use crate::subkey::{derive_subkey_versioned, SubkeyRole};
        use crate::test_vector_fmt::hex_lower;
        use crate::types::MetaVersion;
        use alloc::string::String;

        let root_key: [u8; 32] = [0x42; 32];
        let memory_key_v0_2 =
            derive_subkey_versioned(MetaVersion::V0_2, &root_key, SubkeyRole::AgentMemoryKey);
        let account_hash: [u8; AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN] = [0x33; 16];
        let entry_id: [u8; MEMORY_ENTRY_ID_LEN] = [
            0x01, 0x84, 0xa2, 0xb3, 0xc4, 0xd5, 0xe6, 0xf7, 0x08, 0x19, 0x2a, 0x3b, 0x4c, 0x5d,
            0x6e, 0x7f,
        ];
        let nonce_v0_2: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];
        let pt: &[u8] = b"{\"text\":\"The user prefers concise answers.\"}";

        let blob_v0_2 = encode_agent_memory_blob_v0_2_raw(
            &memory_key_v0_2,
            &account_hash,
            &entry_id,
            pt,
            &nonce_v0_2,
        )
        .expect("encode v0.2");
        assert_eq!(&blob_v0_2[0..4], b"MYX5");
        assert_eq!(blob_v0_2[4], AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_2);
        assert_eq!(&blob_v0_2[6..30], &nonce_v0_2);
        let dec_v0_2 = decode_agent_memory_blob_versioned(
            MetaVersion::V0_2,
            &memory_key_v0_2,
            &account_hash,
            &entry_id,
            &blob_v0_2,
        )
        .expect("decode v0.2");
        assert_eq!(dec_v0_2.as_slice(), pt);

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"agent-memory-blob\",\n");
        d.push_str("  \"protocol_version\": \"v0.2\",\n");
        d.push_str("  \"spec_section\": \"protocol.md \\u00a79.26 + \\u00a710.4.1\",\n");
        d.push_str("  \"description\": \"Pins the migrated memory-entry envelope (MYX5): the v0.2 seal (v0.2 KEK + v0.2 per-entry AAD) over the entry bytes, and the v0.1 expectation refusing MYX5.\",\n");
        d.push_str("  \"cases\": [\n");
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"agent-memory-blob/v0.2/encrypt\",\n");
        d.push_str("      \"description\": \"Entry plaintext sealed as MYX5 under the v0.2 per-entry AAD. The header version byte is 0x02 (the per-entry families carry the generation in the version byte, unlike the singletons).\",\n");
        d.push_str("      \"case_kind\": \"encrypt\",\n");
        d.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_memory_entry_id_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"expected_magic_ascii\": \"MYX5\",\n      \"expected_blob_hex\": \"{}\",\n      \"expected_version_byte_hex\": \"02\"\n",
            hex_lower(&root_key),
            hex_lower(&account_hash),
            hex_lower(&entry_id),
            hex_lower(pt),
            hex_lower(&blob_v0_2),
        ));
        d.push_str("    },\n");
        d.push_str("    {\n");
        d.push_str("      \"vector_id\": \"agent-memory-blob/v0.2/rejects-v0-1-expectation\",\n");
        d.push_str("      \"description\": \"The MYX5 blob refused under the v0.1 expectation (magic mismatch, before any decryption).\",\n");
        d.push_str("      \"case_kind\": \"decode_fail_v0_1\",\n");
        d.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_memory_entry_id_hex\": \"{}\",\n      \"expected_error\": \"magic_mismatch\"\n",
            hex_lower(&blob_v0_2),
            hex_lower(&root_key),
            hex_lower(&account_hash),
            hex_lower(&entry_id),
        ));
        d.push_str("    }\n  ]\n}\n");
        std::println!("{d}");
    }
}
