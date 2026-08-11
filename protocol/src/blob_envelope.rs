// SPDX-License-Identifier: AGPL-3.0

//! Shared 34-byte-header AEAD envelope for the six vault-singleton
//! "opaque inner plaintext" blob codecs: `vault.search` (`MYS1`, §9.6),
//! `vault.workspace` (`MYW1`, §9.7), `vault.indices` (`MYI1`, §9.8),
//! `vault.dictionary` (`MYD1`, §9.13), `vault.embeddings` (`MYR1`, §9.17), and
//! `vault.themes` (`MYT1`, §9.21).
//!
//! All six share a BYTE-IDENTICAL framing:
//!
//! ```text
//! Offset  Size  Field              Notes
//! ------  ----  -----------------  -----------------------------------------
//! 0       4     magic              ASCII, per-codec (MYS1 / MYW1 / …)
//! 4       1     protocol_version   0x01
//! 5       1     format_version     0x01 (per-codec engine/serialization byte)
//! 6       24    nonce              XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len     big-endian u32, plaintext_len + 32
//! 34      M     ciphertext         AEAD ciphertext + 32-byte CTX tag
//! ```
//!
//! They differ ONLY in: the magic bytes, the `format_version` byte, the AAD
//! builder (each binds `account_number_hash` under a distinct role string), the
//! per-codec plaintext cap, and the public error enum. This module owns the
//! load-bearing framing + AEAD; each codec module keeps its OWN public error
//! type + constants + `_raw`/convenience/decode signatures unchanged, and maps
//! [`EnvelopeError`] into its own variant via a `From` impl — so the public
//! surface (and every byte-level test vector) stays identical. This is a pure
//! internal DRY consolidation of the previously copy-pasted framing.

use crate::aead::{
    aad_singleton_blob, aad_singleton_blob_v0_2, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
use alloc::vec::Vec;
use getrandom::getrandom;
use zeroize::{Zeroize, Zeroizing};

/// Shared header length (magic 4 + version 1 + format 1 + nonce 24 + len 4).
pub(crate) const BLOB_ENVELOPE_HEADER_LEN: usize = 34;

/// The `protocol_version` byte common to every envelope codec — `0x01` for v0.1.
pub(crate) const BLOB_ENVELOPE_PROTOCOL_VERSION: u8 = 0x01;

/// Structural failure modes of the shared envelope, BEFORE each codec's
/// per-variant mapping. Each blob module translates these into its own public
/// error enum (see the `From<EnvelopeError>` impls in the codec modules) so the
/// distinguishable-reject surface — and its vectors — stay unchanged.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnvelopeError {
    HeaderTooShort,
    MagicMismatch,
    ProtocolVersionMismatch,
    /// `format_version` byte is not the one this client understands → rebuild.
    FormatUnsupported,
    CiphertextLenOverflow,
    CiphertextTruncated,
    /// AEAD verification failed (wrong key, tampered ciphertext/tag/AAD).
    CannotDecrypt,
    /// Plaintext to encode exceeds the per-codec cap.
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    RandomnessUnavailable,
}

impl From<ProtocolError> for EnvelopeError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to a single non-distinguishing
        // decrypt error (boundary-policy §6.4 discipline).
        EnvelopeError::CannotDecrypt
    }
}

/// Seal `plaintext` into the shared envelope under `key` with a caller-supplied
/// `nonce`. `magic` + `format_version` are written verbatim; `aad` is the
/// per-codec AAD (already bound to `account_number_hash` under the codec's
/// role). `max_plaintext_len` is the per-codec cap.
///
/// Byte-identical to each codec's former hand-rolled encoder — the assembly
/// order (magic ∥ version ∥ format ∥ nonce ∥ len_be32 ∥ sealed) is the
/// cross-implementation contract pinned by the companion vectors.
pub(crate) fn encode_blob_envelope_raw(
    key: &[u8; AEAD_KEY_LEN],
    magic: &[u8; 4],
    format_version: u8,
    aad: &[u8],
    max_plaintext_len: usize,
    plaintext: &[u8],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, EnvelopeError> {
    if plaintext.len() > max_plaintext_len {
        return Err(EnvelopeError::PlaintextTooLarge);
    }

    let sealed = aead_seal_ctx(key, nonce, plaintext, aad)?;

    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(BLOB_ENVELOPE_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(magic);
    out.push(BLOB_ENVELOPE_PROTOCOL_VERSION);
    out.push(format_version);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// [`encode_blob_envelope_raw`] pulling the 24-byte nonce from the OS CSPRNG.
/// The per-codec convenience wrappers delegate here.
pub(crate) fn encode_blob_envelope(
    key: &[u8; AEAD_KEY_LEN],
    magic: &[u8; 4],
    format_version: u8,
    aad: &[u8],
    max_plaintext_len: usize,
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut nonce).map_err(|_| EnvelopeError::RandomnessUnavailable)?;
    let result = encode_blob_envelope_raw(
        key,
        magic,
        format_version,
        aad,
        max_plaintext_len,
        plaintext,
        &nonce,
    );
    nonce.zeroize();
    result
}

/// Parse + AEAD-open the shared envelope. ALL structural checks run BEFORE any
/// decryption (magic-before-decrypt discipline); `expected_magic` +
/// `expected_format_version` gate at their offsets, and `max_plaintext_len`
/// bounds `ciphertext_len` (cap + 32) so a hostile length cannot panic a slice.
pub(crate) fn decode_blob_envelope(
    key: &[u8; AEAD_KEY_LEN],
    expected_magic: &[u8; 4],
    expected_format_version: u8,
    aad: &[u8],
    max_plaintext_len: usize,
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, EnvelopeError> {
    // ---- parse the 34-byte header (all checks BEFORE decryption) -------
    if blob.len() < BLOB_ENVELOPE_HEADER_LEN {
        return Err(EnvelopeError::HeaderTooShort);
    }
    if blob[0..4] != *expected_magic {
        return Err(EnvelopeError::MagicMismatch);
    }
    if blob[4] != BLOB_ENVELOPE_PROTOCOL_VERSION {
        return Err(EnvelopeError::ProtocolVersionMismatch);
    }
    if blob[5] != expected_format_version {
        return Err(EnvelopeError::FormatUnsupported);
    }

    let mut nonce = [0u8; AEAD_NONCE_LEN];
    nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing so a hostile ciphertext_len cannot
    // panic on the slice.
    if ciphertext_len > max_plaintext_len + CTX_COMMITMENT_TAG_LEN {
        return Err(EnvelopeError::CiphertextLenOverflow);
    }
    let ciphertext_end = BLOB_ENVELOPE_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(EnvelopeError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let plaintext = aead_open_ctx(
        key,
        &nonce,
        &blob[BLOB_ENVELOPE_HEADER_LEN..ciphertext_end],
        aad,
    )?;
    Ok(plaintext)
}

/// Pick a KEK-envelope family's (magic, AAD) pair for `version`. The v0.1 magic
/// (`MY?1`) binds `aad_singleton_blob(role, hash)`; the migrated v0.2 magic
/// (`MY?5`) binds `aad_singleton_blob_v0_2(role, hash)`. The `protocol_version`
/// header byte is `0x01` in BOTH (the re-seal keeps it — the generations
/// domain-separate on magic + AAD prefix + KEK, not on that byte), so `version`
/// selects only the magic + AAD here.
pub(crate) fn singleton_family_for<'a>(
    version: MetaVersion,
    v0_1_magic: &'a [u8; 4],
    v0_2_magic: &'a [u8; 4],
    aad_role: &[u8],
    account_number_hash: &[u8; 16],
) -> (&'a [u8; 4], Vec<u8>) {
    match version {
        MetaVersion::V0_1 => (
            v0_1_magic,
            aad_singleton_blob(aad_role, account_number_hash),
        ),
        MetaVersion::V0_2 => (
            v0_2_magic,
            aad_singleton_blob_v0_2(aad_role, account_number_hash),
        ),
    }
}

/// Version-aware seal of a KEK-envelope singleton. `version` picks the magic
/// (`MY?1`/`MY?5`) and the AAD prefix; every other byte matches the v0.1 encoder.
/// The caller MUST have derived `key` under the SAME generation
/// (`derive_subkey_versioned(version, root, role)`), or the resulting blob is
/// unreadable by its own family.
#[allow(clippy::too_many_arguments)]
pub(crate) fn encode_singleton_versioned(
    version: MetaVersion,
    key: &[u8; AEAD_KEY_LEN],
    v0_1_magic: &[u8; 4],
    v0_2_magic: &[u8; 4],
    format_version: u8,
    aad_role: &[u8],
    account_number_hash: &[u8; 16],
    max_plaintext_len: usize,
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let (magic, aad) = singleton_family_for(
        version,
        v0_1_magic,
        v0_2_magic,
        aad_role,
        account_number_hash,
    );
    encode_blob_envelope(
        key,
        magic,
        format_version,
        &aad,
        max_plaintext_len,
        plaintext,
    )
}

/// Version-aware open of a KEK-envelope singleton — the mirror of
/// [`encode_singleton_versioned`]. `version` (from the unlocked slot) selects the
/// expected magic + AAD; `key` must be the matching-generation KEK.
#[allow(clippy::too_many_arguments)]
pub(crate) fn decode_singleton_versioned(
    version: MetaVersion,
    key: &[u8; AEAD_KEY_LEN],
    v0_1_magic: &[u8; 4],
    v0_2_magic: &[u8; 4],
    format_version: u8,
    aad_role: &[u8],
    account_number_hash: &[u8; 16],
    max_plaintext_len: usize,
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, EnvelopeError> {
    let (magic, aad) = singleton_family_for(
        version,
        v0_1_magic,
        v0_2_magic,
        aad_role,
        account_number_hash,
    );
    decode_blob_envelope(key, magic, format_version, &aad, max_plaintext_len, blob)
}
