// SPDX-License-Identifier: AGPL-3.0-only

//! `chats/<conversation-id-hex>` 34-byte-header encrypted AI conversation
//! codec (myne-md/myne#675; `docs/spec/protocol.md` § 9.24).
//!
//! Each persisted AI conversation gets one file under `<vault-root>/chats/`,
//! named by the lowercase-hex 16-byte conversation UUIDv7, holding the
//! conversation's ordered immutable turn list. The blob is AEAD-encrypted
//! under `chats_key = DeriveSubkey(root_key, SubkeyRole::ChatsKey)`: ONE KEK
//! for the whole family; per-conversation separation comes from the
//! `conversation_id` AAD binding (§ 9.24.3), the `MYE1` attachment-text
//! archetype. The catalog half of the pair is `chats_catalog_blob.rs`
//! (`MYM1`, § 9.23).
//!
//! This codec is **payload-agnostic** like its singleton siblings: the inner
//! plaintext is the client layer's canonical-JSON turn list (§ 9.24.2); the
//! protocol crate owns only the crypto framing (magic, versions, AEAD, AAD),
//! which are the load-bearing parts.
//!
//! ## On-disk layout (spec § 9.24.1)
//!
//! ```text
//! Offset  Size  Field                Notes
//! ------  ----  -------------------  ------------------------------------
//! 0       4     magic                ASCII "MYJ1"
//! 4       1     protocol_version     0x01 (v0.1) / 0x02 (v0.2 vaults)
//! 5       1     chats_format_version 0x01 (inner turn-schema generation)
//! 6       24    nonce                XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len       big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext           AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes, strict-trailing (§ 10.3.1). The `conversation_id`
//! is NOT a header field: the file name carries it and the AAD binds it
//! cryptographically, so a blob can never be served for the wrong
//! conversation.
//!
//! ## Read semantic (spec § 9.24.4)
//!
//! Unlike the cosmetic singletons this family carries **load-bearing user
//! content**, so a read failure is an honest error, never a silent empty
//! (§ 9.23.3's report-don't-empty rule, argued in `decisions/ai/0575`).

use crate::aead::{
    aad_chats_blob, aad_chats_blob_v0_2, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
use alloc::vec::Vec;
use getrandom::getrandom;
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0: ASCII `"MYJ1"` (Myne Journal/chat v1; a
/// free-pool § 10.3 allocation, myne-md/myne#675).
pub const CHATS_BLOB_MAGIC: [u8; 4] = *b"MYJ1";

/// Magic bytes for the migrated v0.2 conversation family: ASCII `"MYJ5"`
/// (§10.3 registry). A v0.2 vault's conversation files are written under
/// this magic + the v0.2 AAD prefix + a `derive_subkey_v0_2` KEK. Named in
/// the same change as the base magic (rule 5: a file naming a family's BASE
/// magic must also name every LATER generation of it).
pub const CHATS_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYJ5";

/// AAD role string bound into both generations' conversation-file AAD.
pub const CHATS_BLOB_AAD_ROLE: &[u8] = b"chats-blob";

/// `protocol_version` byte at offset 4. Follows the family convention: `0x01`
/// on a v0.1 vault, `0x02` on a v0.2 vault. The magic does not change across
/// generations (§ 10.3.1). Both are accepted by this decoder; the caller
/// supplies the expected value so a v0.1 blob opened as v0.2 (or vice versa)
/// fails AEAD via the AAD's version byte.
pub const CHATS_BLOB_PROTOCOL_VERSION_V0_1: u8 = 0x01;
pub const CHATS_BLOB_PROTOCOL_VERSION_V0_2: u8 = 0x02;

/// `chats_format_version` byte at offset 5: the inner turn-schema generation
/// that produced the plaintext. `0x01` is the baseline (§ 9.24.2). A future
/// schema bumps this so an older client rejects cleanly
/// ([`ChatsBlobError::FormatUnsupported`]) rather than mis-parsing.
pub const CHATS_BLOB_FORMAT_VERSION: u8 = 0x01;

/// Length of the 16-byte `conversation_id` bound into the AAD (§ 9.24.3).
pub const CONVERSATION_ID_LEN: usize = 16;

/// Length of the 16-byte `account_number_hash` bound into the AAD.
pub const CHATS_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Fixed header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub const CHATS_BLOB_HEADER_LEN: usize = 34;

/// Upper bound on the inner plaintext (the canonical-JSON turn list). 16 MiB
/// (§ 9.24.4, the graph-layout § 9.19 precedent, generous for ~200k small
/// turns). It turns a hostile `ciphertext_len` into a clean error instead of an
/// absurd allocation (the § 9.5.4 / § 9.6.5 DoS-allocation discipline).
pub const MAX_CHATS_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

/// Failure modes of the conversation codec. Distinct variants for
/// observability; the caller REPORTS them (§ 9.24.4 report-don't-empty:
/// this family never collapses to "empty" the way the cosmetic caches do).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ChatsBlobError {
    /// Input shorter than [`CHATS_BLOB_HEADER_LEN`] bytes.
    #[error("conversation blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYJ1`.
    #[error("conversation blob magic mismatch (expected MYJ1)")]
    MagicMismatch,
    /// `protocol_version` byte is neither `0x01` nor `0x02`.
    #[error("conversation blob protocol_version mismatch (expected 0x01 or 0x02)")]
    ProtocolVersionMismatch,
    /// `chats_format_version` is not understood by this client.
    #[error("conversation blob chats_format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_CHATS_PLAINTEXT_LEN`] + 32.
    #[error("conversation ciphertext_len exceeds the plaintext cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `header + ciphertext_len`, or longer (§ 10.3.1
    /// strict-trailing: total length MUST be exactly `34 + ciphertext_len`).
    #[error("conversation blob length does not match its declared ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD,
    /// including a wrong `conversation_id`, `account_number_hash`, or
    /// tampered version bytes, all AAD-bound).
    #[error("conversation AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_CHATS_PLAINTEXT_LEN`]. Refused
    /// rather than truncated: a silently shortened conversation is a wrong
    /// conversation (§ 9.24.4).
    #[error("conversation plaintext exceeds the cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for conversation nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for ChatsBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy § 6.4 discipline, mirroring
        // attachment_text_blob.rs / themes_blob.rs).
        ChatsBlobError::CannotDecrypt
    }
}

/// Encode a conversation blob from an opaque `plaintext` (the client layer's
/// canonical-JSON turn list), sealing under `chats_key` with `nonce`. Bound
/// to `conversation_id` and `account_number_hash` via the AAD (§ 9.24.3).
/// Stamps `MYJ1` + the v0.1 AAD prefix; the v0.2 mirror is
/// [`encode_chats_blob_v0_2_raw`] (the attachments-family split: one function
/// per generation, so no hybrid stamp is expressible).
///
/// `_raw` callers source `nonce` from a CSPRNG-grade source. Nonce reuse
/// under the same `chats_key` is catastrophic per the XChaCha20-Poly1305
/// contract. Production callers SHOULD use [`encode_chats_blob`], which
/// pulls randomness from `getrandom`.
pub fn encode_chats_blob_raw(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ChatsBlobError> {
    if plaintext.len() > MAX_CHATS_PLAINTEXT_LEN {
        return Err(ChatsBlobError::PlaintextTooLarge);
    }

    let aad = aad_chats_blob(account_number_hash, conversation_id);
    let sealed = aead_seal_ctx(chats_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(CHATS_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&CHATS_BLOB_MAGIC);
    out.push(CHATS_BLOB_PROTOCOL_VERSION_V0_1);
    out.push(CHATS_BLOB_FORMAT_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a conversation blob, pulling the 24-byte nonce from the OS CSPRNG.
pub fn encode_chats_blob(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ChatsBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| ChatsBlobError::RandomnessUnavailable)?;
    let result = encode_chats_blob_raw(
        chats_key,
        account_number_hash,
        conversation_id,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Encode a `MYJ5` conversation blob from caller-supplied randomness
/// (`_raw`). The v0.2 mirror of [`encode_chats_blob_raw`]: same § 9.24 byte
/// layout, `MYJ5` magic + `0x02` version, v0.2 AAD.
pub fn encode_chats_blob_v0_2_raw(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ChatsBlobError> {
    if plaintext.len() > MAX_CHATS_PLAINTEXT_LEN {
        return Err(ChatsBlobError::PlaintextTooLarge);
    }

    let aad = aad_chats_blob_v0_2(account_number_hash, conversation_id);
    let sealed = aead_seal_ctx(chats_key, nonce, plaintext, &aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(CHATS_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&CHATS_BLOB_V0_2_MAGIC);
    out.push(CHATS_BLOB_PROTOCOL_VERSION_V0_2);
    out.push(CHATS_BLOB_FORMAT_VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `MYJ5` conversation blob, pulling the 24-byte nonce from the OS
/// CSPRNG.
pub fn encode_chats_blob_v0_2(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ChatsBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| ChatsBlobError::RandomnessUnavailable)?;
    let result = encode_chats_blob_v0_2_raw(
        chats_key,
        account_number_hash,
        conversation_id,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Version-aware seal of a conversation file: `MYJ1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYJ5` + v0.2 AAD for [`MetaVersion::V0_2`]. The
/// `chats_key` MUST be derived under the same generation
/// (`derive_subkey_versioned(version, root_key, ChatsKey)`).
pub fn encode_chats_blob_versioned(
    version: MetaVersion,
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, ChatsBlobError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| ChatsBlobError::RandomnessUnavailable)?;
    let result = match version {
        MetaVersion::V0_1 => encode_chats_blob_raw(
            chats_key,
            account_number_hash,
            conversation_id,
            plaintext,
            &nonce,
        ),
        MetaVersion::V0_2 => encode_chats_blob_v0_2_raw(
            chats_key,
            account_number_hash,
            conversation_id,
            plaintext,
            &nonce,
        ),
    };
    nonce.zeroize();
    result
}

/// Re-seal one conversation file across the v0.1 → v0.2 cut (`MYJ1` → `MYJ5`,
/// v0.1 AAD → v0.2 AAD, v0.1 KEK → v0.2 KEK) for the whole-vault migration
/// (§10.4.1). Decode under the old generation, re-encode under the new one;
/// the inner turn list passes through opaquely. Any failure (AEAD, schema,
/// cap) is an error the caller scopes: a single dead conversation must not
/// strand a half-rewritten vault (the attachments `continue`-on-failure
/// discipline).
pub fn reseal_chats_blob_v0_2(
    old_blob: &[u8],
    old_key: &[u8; AEAD_KEY_LEN],
    new_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
) -> Result<Vec<u8>, ChatsBlobError> {
    let plaintext = decode_chats_blob(old_key, account_number_hash, conversation_id, old_blob)?;
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| ChatsBlobError::RandomnessUnavailable)?;
    let result = encode_chats_blob_v0_2_raw(
        new_key,
        account_number_hash,
        conversation_id,
        &plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Decode a conversation blob into its opaque inner plaintext (the
/// canonical-JSON turn list, for the client layer to deserialize). Magic /
/// protocol_version / chats_format_version / caps are all checked BEFORE any
/// decryption; strict-trailing (§ 10.3.1) is enforced here rather than
/// inherited leniently. AEAD failure (incl. a wrong `conversation_id` or
/// `account_number_hash`, both AAD-bound) collapses to
/// [`ChatsBlobError::CannotDecrypt`]. The caller supplies the same
/// `conversation_id` the blob was sealed for (the file name it was read
/// from) and its vault's `protocol_version`.
pub fn decode_chats_blob(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ChatsBlobError> {
    decode_chats_blob_versioned(
        MetaVersion::V0_1,
        chats_key,
        account_number_hash,
        conversation_id,
        blob,
    )
}

/// Open a `MYJ5` conversation blob (v0.2 generation only).
pub fn decode_chats_blob_v0_2(
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ChatsBlobError> {
    decode_chats_blob_versioned(
        MetaVersion::V0_2,
        chats_key,
        account_number_hash,
        conversation_id,
        blob,
    )
}

/// Version-aware open of a conversation file: `MYJ1` + v0.1 AAD for
/// [`MetaVersion::V0_1`], `MYJ5` + v0.2 AAD for [`MetaVersion::V0_2`].
/// One magic + one version byte per generation (the attachments-family
/// convention): v0.1 is `MYJ1`/`0x01`, v0.2 is `MYJ5`/`0x02`.
pub fn decode_chats_blob_versioned(
    version: MetaVersion,
    chats_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; CHATS_BLOB_ACCOUNT_HASH_LEN],
    conversation_id: &[u8; CONVERSATION_ID_LEN],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ChatsBlobError> {
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < CHATS_BLOB_HEADER_LEN {
        return Err(ChatsBlobError::HeaderTooShort);
    }
    let (expected_magic, expected_version, aad) = match version {
        MetaVersion::V0_1 => (
            &CHATS_BLOB_MAGIC,
            CHATS_BLOB_PROTOCOL_VERSION_V0_1,
            aad_chats_blob(account_number_hash, conversation_id),
        ),
        MetaVersion::V0_2 => (
            &CHATS_BLOB_V0_2_MAGIC,
            CHATS_BLOB_PROTOCOL_VERSION_V0_2,
            aad_chats_blob_v0_2(account_number_hash, conversation_id),
        ),
    };
    if blob[0..4] != expected_magic[..] {
        return Err(ChatsBlobError::MagicMismatch);
    }
    if blob[4] != expected_version {
        return Err(ChatsBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != CHATS_BLOB_FORMAT_VERSION {
        return Err(ChatsBlobError::FormatUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > MAX_CHATS_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(ChatsBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = CHATS_BLOB_HEADER_LEN + ciphertext_len;
    // § 10.3.1 strict-trailing: the file MUST end exactly where the declared
    // layout ends. A tolerated tail is unauthenticated bytes a syncing client
    // would persist and re-upload verbatim.
    if blob.len() != ciphertext_end {
        return Err(ChatsBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    // `aad` was selected with the magic above: one generation, one AAD, no
    // hybrid.
    let plaintext = aead_open_ctx(
        chats_key,
        &nonce,
        &blob[CHATS_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    Ok(plaintext)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::vec;

    const KEY: [u8; AEAD_KEY_LEN] = [0x42; AEAD_KEY_LEN];
    const ACCOUNT_HASH: [u8; CHATS_BLOB_ACCOUNT_HASH_LEN] = [0x7c; CHATS_BLOB_ACCOUNT_HASH_LEN];
    const CONV_ID: [u8; CONVERSATION_ID_LEN] = [0x5a; CONVERSATION_ID_LEN];
    const NONCE: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];

    fn encode(plaintext: &[u8]) -> Vec<u8> {
        encode_chats_blob_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, plaintext, &NONCE).expect("encode")
    }

    #[test]
    fn round_trips_opaque_plaintext() {
        let payload =
            b"{\"turns\":[{\"id\":\"c1-1\",\"kind\":\"text\",\"role\":\"user\",\"text\":\"hi\"}]}";
        let blob = encode(payload);
        let decoded = decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
    }

    #[test]
    fn empty_plaintext_round_trips() {
        // A not-yet-turn-carrying conversation file must round-trip (the
        // client may create the file at conversation create, before any
        // turn settles).
        let blob = encode(b"");
        let decoded = decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob).expect("decode");
        assert!(decoded.is_empty());
    }

    #[test]
    fn header_layout_is_magic_versions_nonce_len() {
        let blob = encode(b"abc");
        assert_eq!(&blob[0..4], b"MYJ1");
        assert_eq!(blob[4], CHATS_BLOB_PROTOCOL_VERSION_V0_1);
        assert_eq!(blob[5], CHATS_BLOB_FORMAT_VERSION);
        assert_eq!(&blob[6..30], &NONCE);
        // ciphertext_len = plaintext (3) + CTX tag (32) = 35.
        assert_eq!(
            u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]),
            35
        );
        assert_eq!(blob.len(), CHATS_BLOB_HEADER_LEN + 35);
    }

    #[test]
    fn v0_2_protocol_version_round_trips_under_its_own_stamp() {
        // The family convention: a v0.2 vault seals MYJ5 + 0x02 + the v0.2
        // AAD prefix. Sealing and opening both under the v0.2 entry points
        // must round-trip, and the magic is what separates the generations
        // at the header.
        let payload = b"v0.2 vault conversation";
        let blob = encode_chats_blob_v0_2_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, payload, &NONCE)
            .expect("encode");
        assert_eq!(&blob[0..4], b"MYJ5");
        assert_eq!(blob[4], CHATS_BLOB_PROTOCOL_VERSION_V0_2);
        let decoded = decode_chats_blob_v0_2(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob).expect("decode");
        assert_eq!(decoded.as_slice(), payload);
        // And a v0.1-stamped reader must reject the MYJ5 blob before any
        // decryption. The magic check runs first (like every family), so a
        // cross-generation serve fails as MagicMismatch, not as a version
        // mismatch. Both are pre-decryption structural rejects.
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::MagicMismatch)
        );
    }

    #[test]
    fn magic_checked_before_decrypt() {
        let mut blob = encode(b"abc");
        blob[0] = b'X';
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::MagicMismatch)
        );
    }

    #[test]
    fn unsupported_format_version_rejects() {
        let mut blob = encode(b"abc");
        blob[5] = 0x02; // a future turn-schema generation
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::FormatUnsupported)
        );
    }

    #[test]
    fn tampered_ciphertext_fails_aead() {
        let mut blob = encode(b"hello conversation");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn wrong_conversation_id_fails_aead() {
        // A blob sealed for conversation A fails AEAD when served as
        // conversation B (the AAD binds conversation_id): the per-blob-safety
        // property that lets one KEK serve every conversation file.
        let blob = encode(b"conversation A turns");
        let other_id = [0x11; CONVERSATION_ID_LEN];
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &other_id, &blob),
            Err(ChatsBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn cross_vault_account_hash_fails_aead() {
        // account_number_hash is AAD-bound: a blob from vault A cannot be
        // opened against vault B. Collapses to the same CannotDecrypt as the
        // tamper case (§ 6.4); ports MUST NOT distinguish the two.
        let blob = encode(b"cross vault");
        let other_hash = [0x44; CHATS_BLOB_ACCOUNT_HASH_LEN];
        assert_eq!(
            decode_chats_blob(&KEY, &other_hash, &CONV_ID, &blob),
            Err(ChatsBlobError::CannotDecrypt)
        );
    }

    #[test]
    fn strict_trailing_bytes_reject() {
        // § 10.3.1: no bytes past the declared layout. A tolerated tail is
        // unauthenticated bytes a syncing client would re-upload verbatim.
        let mut blob = encode(b"abc");
        blob.push(0x00);
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn truncated_relative_to_ciphertext_len_rejects() {
        let mut blob = encode(b"some turns");
        blob.truncate(blob.len() - 1);
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::CiphertextTruncated)
        );
    }

    #[test]
    fn hostile_oversize_ciphertext_len_rejects_before_allocation() {
        // A hostile ciphertext_len must turn into a clean error, never an
        // absurd allocation or a panicking slice index.
        let mut blob = encode(b"abc");
        let over_cap = (MAX_CHATS_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN + 1) as u32;
        blob[30..34].copy_from_slice(&over_cap.to_be_bytes());
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &blob),
            Err(ChatsBlobError::CiphertextLenOverflow)
        );
    }

    #[test]
    fn over_cap_plaintext_refused_at_encode() {
        // § 9.24.4: refused, not truncated. A silently shortened
        // conversation is a wrong conversation.
        let too_big = vec![0x61u8; MAX_CHATS_PLAINTEXT_LEN + 1];
        assert_eq!(
            encode_chats_blob_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, &too_big, &NONCE),
            Err(ChatsBlobError::PlaintextTooLarge)
        );
    }

    #[test]
    fn at_cap_plaintext_encodes() {
        // The boundary is inclusive, not off by one.
        let at_cap = vec![0x61u8; MAX_CHATS_PLAINTEXT_LEN];
        let blob = encode_chats_blob_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, &at_cap, &NONCE)
            .expect("at-cap encode");
        assert_eq!(
            blob.len(),
            CHATS_BLOB_HEADER_LEN + at_cap.len() + CTX_COMMITMENT_TAG_LEN
        );
    }

    #[test]
    fn generations_are_domain_separated() {
        // Same key, same plaintext, same nonce: the v0.1 and v0.2 seals must
        // still differ (magic + AAD prefix), and neither opens under the
        // other's decode path. An invalid stamp is unrepresentable (the
        // version travels in the function name, not a byte parameter).
        let v1 = encode_chats_blob_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, b"abc", &NONCE)
            .expect("encode v0.1");
        let v2 = encode_chats_blob_v0_2_raw(&KEY, &ACCOUNT_HASH, &CONV_ID, b"abc", &NONCE)
            .expect("encode v0.2");
        assert_ne!(v1, v2);
        assert_eq!(
            decode_chats_blob(&KEY, &ACCOUNT_HASH, &CONV_ID, &v2),
            Err(ChatsBlobError::MagicMismatch)
        );
        assert_eq!(
            decode_chats_blob_v0_2(&KEY, &ACCOUNT_HASH, &CONV_ID, &v1),
            Err(ChatsBlobError::MagicMismatch)
        );
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits `myne-test-vectors/vectors/chats-blob/v0.1/cases.json` to
    /// `/tmp/myne_chats_blob_vectors.json` and the v0.2 side to
    /// `/tmp/myne_chats_blob_v0_2_vectors.json`. `#[ignore]`; run with:
    /// `cargo test -p protocol --lib emit_chats_blob_vectors_for_paste -- --ignored`
    ///
    /// Cases (v0.1 case_kind): `encrypt` (MYJ1 byte output over the turn-list
    /// plaintext, incl. the create-state payload and a frozen-proposal
    /// payload), `decrypt_ok` (round-trip), `decrypt_aead_fail` (tamper +
    /// cross-vault + cross-conversation-id, non-distinguishing),
    /// `parse_fail` (one per `ChatsBlobError` decode reject). v0.2: `encrypt`
    /// (MYJ5) + `decode_fail_v0_1`.
    ///
    /// The turn-list plaintexts are the shipped writer's shape
    /// (`{"turns":[..],"title_derived_from":..}`: key order not significant,
    /// writers emit `turns` first (see `docs/spec/protocol.md` §9.24.2); the
    /// codec treats them as opaque bytes and the runner pins the bytes.
    #[test]
    #[ignore]
    fn emit_chats_blob_vectors_for_paste() {
        extern crate std;
        use crate::subkey::{derive_subkey, SubkeyRole};
        use crate::test_vector_fmt::hex_lower;
        use alloc::string::String;

        let root_key: [u8; 32] = [0x42; 32];
        let chats_key = derive_subkey(&root_key, SubkeyRole::ChatsKey);
        let account_hash: [u8; CHATS_BLOB_ACCOUNT_HASH_LEN] = [0x33; 16];
        let other_account_hash: [u8; CHATS_BLOB_ACCOUNT_HASH_LEN] = [0x34; 16];
        let conv_id: [u8; CONVERSATION_ID_LEN] = [0x5a; 16];
        let other_conv_id: [u8; CONVERSATION_ID_LEN] = [0x5b; 16];
        let nonce: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];

        let pt_empty: &[u8] = br#"{"turns":[],"title_derived_from":""}"#;
        let pt_populated: &[u8] = br#"{"turns":[{"id":"a1b2c3d4-0000000001","kind":"text","role":"user","text":"Help me with taxes please"},{"id":"a1b2c3d4-0000000002","kind":"text","role":"assistant","text":"Start with last year."}],"title_derived_from":"Help me with taxes"}"#;
        // A settled agent turn's frozen proposal rides the payload (Task 9):
        // anchors + replacements verbatim, plus a multibyte title.
        let pt_proposal: &[u8] = "{\"turns\":[{\"id\":\"e5f6a7b8-0000000001\",\"kind\":\"agent\",\"role\":\"user\",\"text\":\"tidy the headings\"},{\"id\":\"e5f6a7b8-0000000002\",\"kind\":\"agent\",\"role\":\"assistant\",\"agentSummary\":{\"runId\":\"r1\",\"summary\":\"done\",\"edits\":1,\"newNotes\":0,\"notesRead\":2,\"iterations\":3,\"charsOffDevice\":null,\"end\":\"finished\",\"proposal\":{\"edits\":[{\"noteId\":\"n1\",\"anchor\":\"old words\",\"replacement\":\"new words\"}],\"newNotes\":[]}}}],\"title_derived_from\":\"Görev listesi\"}".as_bytes();

        let enc = |pt: &[u8]| {
            encode_chats_blob_raw(&chats_key, &account_hash, &conv_id, pt, &nonce).expect("encode")
        };
        let blob_empty = enc(pt_empty);
        let blob_populated = enc(pt_populated);
        let blob_proposal = enc(pt_proposal);

        for (blob, pt) in [
            (&blob_empty, pt_empty),
            (&blob_populated, pt_populated),
            (&blob_proposal, pt_proposal),
        ] {
            let dec = decode_chats_blob(&chats_key, &account_hash, &conv_id, blob)
                .expect("decode round-trip");
            assert_eq!(dec.as_slice(), pt);
        }

        let mut blob_tamper = blob_populated.clone();
        let last = blob_tamper.len() - 1;
        blob_tamper[last] ^= 0xFF;
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &blob_tamper),
            Err(ChatsBlobError::CannotDecrypt)
        );
        assert_eq!(
            decode_chats_blob(&chats_key, &other_account_hash, &conv_id, &blob_populated),
            Err(ChatsBlobError::CannotDecrypt)
        );
        // Cross-conversation: the same blob under another conversation id.
        // The per-entry binding (the MYE1 archetype) is what lets one KEK
        // serve every conversation file.
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &other_conv_id, &blob_populated),
            Err(ChatsBlobError::CannotDecrypt)
        );

        let short: &[u8] = &[0u8; 10];
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, short),
            Err(ChatsBlobError::HeaderTooShort)
        );
        let mut bad_magic = blob_populated.clone();
        bad_magic[0] = b'X';
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &bad_magic),
            Err(ChatsBlobError::MagicMismatch)
        );
        let mut bad_version = blob_populated.clone();
        bad_version[4] = 0x09;
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &bad_version),
            Err(ChatsBlobError::ProtocolVersionMismatch)
        );
        let mut bad_format = blob_populated.clone();
        bad_format[5] = 0x09;
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &bad_format),
            Err(ChatsBlobError::FormatUnsupported)
        );
        let mut bad_len = blob_populated.clone();
        bad_len[30..34].copy_from_slice(&0x0110_0000u32.to_be_bytes());
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &bad_len),
            Err(ChatsBlobError::CiphertextLenOverflow)
        );
        let mut truncated = blob_populated.clone();
        truncated.pop();
        assert_eq!(
            decode_chats_blob(&chats_key, &account_hash, &conv_id, &truncated),
            Err(ChatsBlobError::CiphertextTruncated)
        );

        let mut d = String::new();
        d.push_str("{\n");
        d.push_str("  \"schema\": \"chats-blob\",\n");
        d.push_str("  \"protocol_version\": \"v0.1\",\n");
        d.push_str("  \"spec_section\": \"protocol.md §9.24 + §5.2 + §3.4\",\n");
        d.push_str("  \"description\": \"Pins protocol::encode_chats_blob_raw + decode_chats_blob (MYJ1) + aad_chats_blob. Inner plaintext is the shipped writer's turn-list payload JSON ({turns, title_derived_from}); the codec treats it as opaque bytes. AAD binds conversation_id (16 B) + account_number_hash (16 B) under role 'chats-blob' (55 B total), so one KEK serves every conversation file. KEK = DeriveSubkey(root,'chats-key'). Reference impl: protocol/src/chats_blob.rs.\",\n");
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
        let enc_body = |pt: &[u8], blob: &[u8]| {
            alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"input_blob_nonce_hex\": \"{}\",\n      \"informational_chats_key_hex\": \"{}\",\n      \"expected_blob_hex\": \"{}\"\n",
                hex(&root_key),
                hex(&account_hash),
                hex(&conv_id),
                hex(pt),
                hex(&nonce),
                hex(chats_key.as_slice()),
                hex(blob),
            )
        };
        case(
            "chats-blob/v0.1/encrypt-empty",
            "Create-state payload (no turns yet) sealed as MYJ1.",
            "encrypt",
            &enc_body(pt_empty, &blob_empty),
        );
        case(
            "chats-blob/v0.1/encrypt-populated",
            "Two text turns sealed as MYJ1.",
            "encrypt",
            &enc_body(pt_populated, &blob_populated),
        );
        case(
            "chats-blob/v0.1/encrypt-proposal",
            "A settled agent turn with a frozen proposal (anchors + replacements verbatim) and a multibyte title sealed as MYJ1.",
            "encrypt",
            &enc_body(pt_proposal, &blob_proposal),
        );
        case(
            "chats-blob/v0.1/decrypt-ok",
            "Decode the populated MYJ1 blob back to payload bytes.",
            "decrypt_ok",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_plaintext_hex\": \"{}\"\n",
                hex(&blob_populated),
                hex(&root_key),
                hex(&account_hash),
                hex(&conv_id),
                hex(pt_populated),
            ),
        );
        case(
            "chats-blob/v0.1/decrypt-fail-tamper",
            "Last ciphertext byte flipped: non-distinguishing AEAD failure.",
            "decrypt_aead_fail",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_kind\": \"aead_fail\",\n      \"informational_tamper_description\": \"last ciphertext byte flipped\"\n",
                hex(&blob_tamper),
                hex(&root_key),
                hex(&account_hash),
                hex(&conv_id),
            ),
        );
        case(
            "chats-blob/v0.1/decrypt-fail-cross-vault",
            "Same blob under another account hash: non-distinguishing AEAD failure.",
            "decrypt_aead_fail",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_kind\": \"aead_fail\",\n      \"informational_tamper_description\": \"account_number_hash swapped for 0x34 fill\"\n",
                hex(&blob_populated),
                hex(&root_key),
                hex(&other_account_hash),
                hex(&conv_id),
            ),
        );
        case(
            "chats-blob/v0.1/decrypt-fail-cross-conversation",
            "Same blob under another conversation id: non-distinguishing AEAD failure. The per-entry binding is what lets one KEK serve every file.",
            "decrypt_aead_fail",
            &alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_kind\": \"aead_fail\",\n      \"informational_tamper_description\": \"conversation_id swapped for 0x5b fill\"\n",
                hex(&blob_populated),
                hex(&root_key),
                hex(&account_hash),
                hex(&other_conv_id),
            ),
        );
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
                "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_error\": \"{err}\"\n",
                hex_lower(blob),
                hex_lower(&root_key),
                hex_lower(&account_hash),
                hex_lower(&conv_id),
            ));
            d.push_str("    }");
        };
        parse(
            "chats-blob/v0.1/parse-fail-header-too-short",
            "Ten bytes cannot hold a 34-byte header.",
            short,
            "header_too_short",
            &mut d,
            &mut first,
        );
        parse(
            "chats-blob/v0.1/parse-fail-magic-mismatch",
            "First byte changed: not a conversation blob.",
            &bad_magic,
            "magic_mismatch",
            &mut d,
            &mut first,
        );
        parse(
            "chats-blob/v0.1/parse-fail-protocol-version-mismatch",
            "Version byte 0x09 is neither 0x01 nor 0x02.",
            &bad_version,
            "protocol_version_mismatch",
            &mut d,
            &mut first,
        );
        parse(
            "chats-blob/v0.1/parse-fail-format-unsupported",
            "Format byte 0x09 is not the 0x01 envelope this client reads.",
            &bad_format,
            "format_unsupported",
            &mut d,
            &mut first,
        );
        parse(
            "chats-blob/v0.1/parse-fail-ciphertext-len-overflow",
            "Declared length exceeds the 16 MiB plaintext cap plus tag.",
            &bad_len,
            "ciphertext_len_overflow",
            &mut d,
            &mut first,
        );
        parse(
            "chats-blob/v0.1/parse-fail-ciphertext-truncated",
            "One byte shaved off the end: strict-trailing total-length check.",
            &truncated,
            "ciphertext_truncated",
            &mut d,
            &mut first,
        );
        d.push_str("\n  ]\n}\n");
        std::fs::write("/tmp/myne_chats_blob_vectors.json", d.as_bytes())
            .expect("write chats-blob vectors dump");

        // v0.2 side: MYJ5 envelope over the populated payload, plus the
        // cross-generation refusal the v0.1 expectation owes. Sealed under
        // the v0.2 KEK (derive_subkey_versioned, the migration's own
        // derivation), not the v0.1 one.
        use crate::subkey::derive_subkey_versioned;
        let chats_key_v0_2 =
            derive_subkey_versioned(MetaVersion::V0_2, &root_key, SubkeyRole::ChatsKey);
        let blob_v0_2 = encode_chats_blob_v0_2_raw(
            &chats_key_v0_2,
            &account_hash,
            &conv_id,
            pt_populated,
            &nonce,
        )
        .expect("encode v0.2");
        assert_eq!(&blob_v0_2[0..4], b"MYJ5");
        let dec_v0_2 = decode_chats_blob_v0_2(&chats_key_v0_2, &account_hash, &conv_id, &blob_v0_2)
            .expect("decode v0.2");
        assert_eq!(dec_v0_2.as_slice(), pt_populated);
        assert!(
            decode_chats_blob_versioned(
                MetaVersion::V0_1,
                &chats_key,
                &account_hash,
                &conv_id,
                &blob_v0_2
            )
            .is_err(),
            "a MYJ5 blob must not open under the v0.1 expectation"
        );
        let mut d2 = String::new();
        d2.push_str("{\n");
        d2.push_str("  \"schema\": \"chats-blob\",\n");
        d2.push_str("  \"protocol_version\": \"v0.2\",\n");
        d2.push_str("  \"spec_section\": \"protocol.md §9.24 + §10.4.1\",\n");
        d2.push_str("  \"description\": \"Pins the migrated conversation-file envelope (MYJ5): the v0.2 seal (v0.2 KEK + v0.2 AAD) over the same payload bytes, and the bidirectional generation refusal (v0.1 expectation refuses MYJ5).\",\n");
        d2.push_str("  \"cases\": [\n");
        d2.push_str("    {\n");
        d2.push_str("      \"vector_id\": \"chats-blob/v0.2/encrypt\",\n");
        d2.push_str("      \"description\": \"Populated payload sealed as MYJ5 under the v0.2 AAD. Unlike the catalog/themes singletons, the conversation-file header version byte IS the generation (0x02).\",\n");
        d2.push_str("      \"case_kind\": \"encrypt\",\n");
        d2.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"input_plaintext_hex\": \"{}\",\n      \"expected_magic_ascii\": \"MYJ5\",\n      \"expected_blob_hex\": \"{}\",\n      \"expected_version_byte_hex\": \"02\"\n",
            hex(&root_key),
            hex(&account_hash),
            hex(&conv_id),
            hex(pt_populated),
            hex(&blob_v0_2),
        ));
        d2.push_str("    },\n");
        d2.push_str("    {\n");
        d2.push_str("      \"vector_id\": \"chats-blob/v0.2/rejects-v0-1-expectation\",\n");
        d2.push_str("      \"description\": \"The MYJ5 blob refused under the v0.1 expectation (magic mismatch, before any decryption).\",\n");
        d2.push_str("      \"case_kind\": \"decode_fail_v0_1\",\n");
        d2.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n      \"input_root_key_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_conversation_id_hex\": \"{}\",\n      \"expected_error\": \"magic_mismatch\"\n",
            hex(&blob_v0_2),
            hex(&root_key),
            hex(&account_hash),
            hex(&conv_id),
        ));
        d2.push_str("    }\n  ]\n}\n");
        std::fs::write("/tmp/myne_chats_blob_v0_2_vectors.json", d2.as_bytes())
            .expect("write chats-blob v0.2 vectors dump");

        std::println!(
            "AAD chats-blob: {}",
            hex_lower(&aad_chats_blob(&account_hash, &conv_id))
        );
    }
}
