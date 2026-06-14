//! XChaCha20-Poly1305 with CTX commitment + AAD construction —
//! see `docs/spec/protocol.md` § 5.
//!
//! This module hosts:
//!
//! - AAD builders for the password-wrap and recovery-wrap AEAD calls —
//!   see [`aad_password_wrap`], [`aad_recovery_wrap`].
//! - AEAD seal/open with CTX commitment — see [`aead_seal_ctx`],
//!   [`aead_open_ctx`].
//!
//! ## CTX commitment construction (spec § 5.1)
//!
//! Plain XChaCha20-Poly1305 is **not key-committing** — Len–Grubbs–
//! Ristenpart's "Partitioning Oracle Attacks" (USENIX 2021). Myne v0.1
//! wraps the AEAD in the **CTX commitment** of Chan & Rogaway (ESORICS
//! 2022): the standard 16-byte Poly1305 tag `T` is fed (along with K,
//! N, AAD) into SHA-256, and the resulting 32-byte hash `T'` replaces
//! `T` on disk. `T` itself is **not stored** — it is recomputed at
//! decrypt time via Poly1305 and rehashed for comparison.
//!
//! ```text
//! seal:    ciphertext, T = XChaCha20-Poly1305-encrypt-detached(K, N, P, AD)
//!          T' = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T[16])
//!          on-disk = ciphertext || T'        (T discarded)
//!
//! open:    split on-disk into ciphertext and T'
//!          T_recomputed = Poly1305(K, N, AD, ciphertext)
//!          T'_expected = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T_recomputed[16])
//!          constant-time compare T'_expected == T'   → AeadFailure if not
//!          plaintext = XChaCha20_decrypt_no_auth(K, N, ciphertext)
//! ```
//!
//! RustCrypto's high-level `chacha20poly1305` crate does not expose
//! the Poly1305 tag separately from the integrity-checked decrypt
//! path, so this module composes [`chacha20::XChaCha20`] (stream
//! cipher) and [`poly1305::Poly1305`] (MAC) by hand. The composition
//! is byte-exact equivalent to RFC 8439 + extended-nonce; this is
//! verified in the test suite by cross-checking ciphertext output
//! against `chacha20poly1305::XChaCha20Poly1305`.
//!
//! ## Twin-prefix gotcha
//!
//! Two 10-byte ASCII prefixes are bound into different parts of the
//! protocol and differ only in their final byte:
//!
//! | Prefix          | Used by                          | Spec      |
//! |-----------------|----------------------------------|-----------|
//! | `"myne.v0.1 "`  | HKDF context strings (§ 3.2.2)   | trailing space |
//! | `"myne.v0.1\|"` | AEAD AAD construction (§ 5.2)    | trailing pipe  |
//!
//! Confusing them silently invalidates every vault under v0.1. Both
//! are tested for byte-equality against literal byte slices in this
//! module's test suite.

use crate::error::ProtocolError;
use crate::types::{serialize_kdf_params, KdfParams};
use alloc::vec::Vec;
use chacha20::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use chacha20::XChaCha20;
use poly1305::universal_hash::{KeyInit, UniversalHash};
use poly1305::Poly1305;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// XChaCha20-Poly1305 AEAD key length: 256 bits.
pub const AEAD_KEY_LEN: usize = 32;

/// XChaCha20-Poly1305 nonce length: 192 bits (extended-nonce variant).
pub const AEAD_NONCE_LEN: usize = 24;

/// CTX commitment tag length: 32 bytes (SHA-256 output).
///
/// Replaces the 16-byte Poly1305 tag on disk per spec § 5.1.
pub const CTX_COMMITMENT_TAG_LEN: usize = 32;

/// ChaCha20 block size — 64 bytes per RFC 8439 §2.3. After consuming
/// the first 32 bytes of block 0 for the Poly1305 one-time key, the
/// stream cipher is advanced to block 1 (byte 64) before encrypting
/// the plaintext.
const CHACHA20_BLOCK_SIZE: u64 = 64;

/// Poly1305 tag length: 16 bytes.
const POLY1305_TAG_LEN: usize = 16;

/// AAD prefix bound into every Myne v0.1 AEAD tag
/// (`docs/spec/protocol.md` § 5.2). 10 ASCII bytes ending in pipe `|`.
/// `pub(crate)` so the attachment blob + catalog AAD builders bind the SAME
/// load-bearing prefix (a major-version constant) from one definition site
/// rather than re-declaring it.
pub(crate) const AAD_PREFIX_V0_1: &[u8] = b"myne.v0.1|";

/// `protocol_version` byte bound into every wrap AAD
/// (spec § 9.3 offset 4 = `0x01` for v0.1). `pub(crate)` for the same
/// single-source reason as [`AAD_PREFIX_V0_1`].
pub(crate) const PROTOCOL_VERSION_V0_1: u8 = 0x01;

/// Registered role string for the password-derived wrap AAD
/// (spec § 3.1).
const ROLE_STR_PASSWORD_WRAP: &[u8] = b"password-wrap";

/// Registered role string for the recovery-phrase-derived wrap AAD
/// (spec § 3.1).
const ROLE_STR_RECOVERY_WRAP: &[u8] = b"recovery-wrap";

/// Build the AAD bound into the AEAD wrap of `root_key` under the
/// password-derived wrap key (spec § 3.1).
///
/// The returned bytes are passed verbatim to the AEAD seal/open
/// helpers (Task 8) at vault-creation time and unlock-by-password
/// time. Byte-exact correctness is load-bearing: the AAD is hashed
/// into both the Poly1305 tag and the CTX commitment tag, so any
/// drift silently invalidates the wrap.
///
/// Layout (37 bytes for default `KdfParams`):
///
/// ```text
/// "myne.v0.1|"                10 bytes  (AAD prefix, § 5.2)
/// 0x01                         1 byte   (protocol_version, § 9.3)
/// u16_be(13) || "password-wrap"  15 bytes  (length-prefixed role, § 3.1)
/// kdf_params_canonical         11 bytes  (§ 4.3, bound for downgrade defense)
/// ```
///
/// **Note on `account_number_hash`.** Spec § 3.1 mixes
/// `account_number_hash` into the wrap-key *salt* (via SHA-256 of the
/// salt prefix concat), **not** into the AAD. Earlier drafts of the
/// PRD listed `account_number_hash` as a parameter to this builder
/// for symmetry; the actual spec AAD definition (§ 3.1 + § 5.2)
/// omits it. The function signature here matches the spec.
pub fn aad_password_wrap(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad(ROLE_STR_PASSWORD_WRAP, kdf_params)
}

/// Build the AAD bound into the AEAD wrap of the singleton v0.1
/// `itemsKey` (spec § 3.3 key hierarchy, § 9.3 offset 281).
///
/// Layout (27 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.3)
/// items_key_id     16 bytes  (UUIDv7 of the singleton v0.1 itemsKey)
/// ```
pub fn aad_vault_items_key_wrap(items_key_id: &[u8; 16]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + items_key_id.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad
}

/// Build the AAD bound into the AEAD wrap of `root_key` under the
/// recovery-phrase-derived wrap key (spec § 3.1).
///
/// Layout is identical to [`aad_password_wrap`] except the role
/// string is `"recovery-wrap"`. The two AADs differ only in their
/// role bytes, providing the role-separation guarantee that spec
/// § 3.1 mandates: "the two distinct ... salt prefixes ensure the two
/// Argon2id outputs are domain-separated even if the same secret were
/// ever used for both (which it MUST NOT be)."
pub fn aad_recovery_wrap(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad(ROLE_STR_RECOVERY_WRAP, kdf_params)
}

/// Build the AAD bound into the AEAD wrap of a per-note `item_key`
/// under the singleton v0.1 `itemsKey` (spec § 5.2 + § 6.2).
///
/// Layout (43 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.3)
/// items_key_id     16 bytes  (UUIDv7 of the singleton v0.1 itemsKey)
/// note_uuid        16 bytes  (UUIDv7 of the note; from the .myn filename, § 9.1)
/// ```
///
/// Distinct from [`aad_vault_items_key_wrap`] (no note_uuid). The
/// `vault_`/`note_` prefix retires the one-letter
/// `items_key`/`item_key` near-collision footgun — see
/// `protocol/CLAUDE.md` for the naming-discipline rationale.
pub fn aad_note_item_key_wrap(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + items_key_id.len() + note_uuid.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1
/// `vault.prefs` blob (spec § 5.2 + § 9.5.3).
///
/// Layout (39 bytes):
///
/// ```text
/// "myne.v0.1|"             10 bytes  (AAD prefix, § 5.2)
/// 0x01                      1 byte   (protocol_version, § 9.3)
/// u16_be(10) || "prefs-blob" 12 bytes  (length-prefixed role, § 5.2)
/// account_number_hash      16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity —
/// `vault.prefs` lives outside the `items_key` lineage by design,
/// preserving prefs portability across the v005 epoch-rotation
/// `items_key` evolution (`decisions.md` 2026-05-27 "Vault preferences
/// blob: root_key-derived prefs_key").
pub fn aad_prefs_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PREFS_BLOB: &[u8] = b"prefs-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_PREFS_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PREFS_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 search-index
/// blob (`vault.search`, MYND-29). Same shape as [`aad_prefs_blob`] with a
/// distinct role string `"search-index-blob"`, so the search index and the
/// prefs blob are cryptographically domain-separated — a blob of one kind can
/// never AEAD-verify under the other's key/AAD.
///
/// Layout (46 bytes):
///
/// ```text
/// "myne.v0.1|"                    10 bytes  (AAD prefix, § 5.2)
/// 0x01                             1 byte   (protocol_version, § 9.3)
/// u16_be(17) || "search-index-blob" 19 bytes  (length-prefixed role)
/// account_number_hash             16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity — the
/// search index lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`.
pub fn aad_search_index_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_SEARCH_INDEX_BLOB: &[u8] = b"search-index-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_SEARCH_INDEX_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_SEARCH_INDEX_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 personal-dictionary
/// blob (`vault.dictionary`, `MYD1`, MYND-266). Same shape as
/// [`aad_prefs_blob`] / [`aad_search_index_blob`] with a distinct role string
/// `"personal-dictionary-blob"`, so the dictionary blob is cryptographically
/// domain-separated from prefs / search / workspace — a blob of one kind can
/// never AEAD-verify under another's key/AAD.
///
/// Layout (53 bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.3)
/// u16_be(24) || "personal-dictionary-blob" 26 bytes  (length-prefixed role)
/// account_number_hash                   16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity — the
/// dictionary lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`. DISTINCT from the subkey role `"personal-dictionary-key"`.
pub fn aad_personal_dictionary_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSONAL_DICT_BLOB: &[u8] = b"personal-dictionary-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_PERSONAL_DICT_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSONAL_DICT_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 editor
/// workspace-state blob (`vault.workspace`, MYND-166). Same shape as
/// [`aad_prefs_blob`] / [`aad_search_index_blob`] with a distinct role
/// string `"workspace-blob"`, so the workspace blob is cryptographically
/// domain-separated from prefs and search — a blob of one kind can never
/// AEAD-verify under another's key/AAD.
///
/// Layout (43 bytes):
///
/// ```text
/// "myne.v0.1|"                  10 bytes  (AAD prefix, § 5.2)
/// 0x01                           1 byte   (protocol_version, § 9.3)
/// u16_be(14) || "workspace-blob" 16 bytes (length-prefixed role)
/// account_number_hash           16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity — the
/// workspace blob lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`.
pub fn aad_workspace_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_WORKSPACE_BLOB: &[u8] = b"workspace-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_WORKSPACE_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_WORKSPACE_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of a note's
/// plaintext under its per-note `item_key` (spec § 5.2 + § 6.2).
///
/// Layout (58 bytes for v0.1's hardcoded `content_type`):
///
/// ```text
/// "myne.v0.1|"             10 bytes  (AAD prefix, § 5.2)
/// 0x01                      1 byte   (protocol_version, § 9.3)
/// items_key_id             16 bytes
/// note_uuid                16 bytes
/// u16_be(13) || "text/markdown"  15 bytes  (length-prefixed UTF-8, § 5.2)
/// ```
///
/// `content_type` is **hardcoded** to `"text/markdown"` in v0.1 per
/// spec § 5.2 — encoder and decoder both bind the same constant, so
/// any future v005 attachment type would diverge at the AAD prefix
/// level rather than via a parameter on this v0.1 helper. v0.1 and
/// v005 are forward-incompatible by design (§ 10).
pub fn aad_note_content_encrypt(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    const CONTENT_TYPE: &[u8] = b"text/markdown";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + items_key_id.len() + note_uuid.len() + 2 + CONTENT_TYPE.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    push_length_prefixed_u16_be(&mut aad, CONTENT_TYPE);
    aad
}

/// Append `bytes` to `buf` prefixed by its length as a 2-byte
/// big-endian unsigned integer per `protocol.md` § 5.2's
/// length-prefix convention.
///
/// Writer-style on purpose: the length-and-bytes pair is emitted as a
/// single call so a buggy caller cannot write a length without the
/// payload (or vice versa). Single source of truth for every
/// length-prefixed AAD field in this crate.
///
/// Panics in debug builds if `bytes.len() > u16::MAX`. v0.1 inputs
/// (role strings of 13 bytes; `content_type` of 13 bytes) are bounded
/// well below this limit; the assert exists to catch a future caller
/// that would silently truncate via `as u16`.
pub(crate) fn push_length_prefixed_u16_be(buf: &mut Vec<u8>, bytes: &[u8]) {
    debug_assert!(
        bytes.len() <= u16::MAX as usize,
        "length-prefixed bytes longer than u16 length-prefix can encode",
    );
    buf.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(bytes);
}

/// Common AAD assembly. Length prefixes are encoded as **u16
/// big-endian** per `protocol.md` § 5.2.
fn build_wrap_aad(role: &[u8], kdf_params: &KdfParams) -> Vec<u8> {
    let kdf_canonical = serialize_kdf_params(kdf_params);

    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + 2 + role.len() + kdf_canonical.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, role);
    aad.extend_from_slice(&kdf_canonical);
    aad
}

/// Encrypt `plaintext` under XChaCha20-Poly1305 with the CTX
/// commitment wrapper (spec § 5.1).
///
/// Returns `ciphertext || T'`, a single byte vector laid out exactly
/// as it lands on disk in `vault.meta` (e.g. § 9.3 offset 89's
/// `enc_root_key_password` field). The Poly1305 tag `T` is **not**
/// stored — only the 32-byte `T'` follows the ciphertext.
///
/// For a 32-byte plaintext (`root_key`) the output is exactly 64 bytes
/// (32 ciphertext + 32 commitment), matching spec § 9.3.
///
/// Failure mode: AAD longer than `u32::MAX` bytes — the `len(AD)[4 BE]`
/// field in the canonical CTX encoding cannot represent it. v0.1 AADs
/// are bounded at 37 bytes by [`aad_password_wrap`] / [`aad_recovery_wrap`],
/// so this is theoretically unreachable in practice.
pub fn aead_seal_ctx(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if aad.len() > u32::MAX as usize {
        return Err(ProtocolError::AeadFailure);
    }

    let mut chacha = XChaCha20::new(key.into(), nonce.into());

    // Block 0 (first 32 bytes): Poly1305 one-time key (RFC 8439 §2.6).
    // The remaining 32 bytes of block 0 are unused; we seek past them
    // before encrypting the plaintext (RFC 8439 §2.8 step 1 — the
    // counter is set to 1 for encryption).
    let mut poly_key = Zeroizing::new([0u8; 32]);
    chacha.apply_keystream(poly_key.as_mut_slice());
    chacha.seek(CHACHA20_BLOCK_SIZE);

    // Encrypt plaintext = ciphertext (XChaCha20 is a stream cipher;
    // encrypt and decrypt are the same XOR with the keystream).
    let mut ciphertext = plaintext.to_vec();
    chacha.apply_keystream(&mut ciphertext);

    // Compute Poly1305 MAC over (AAD || pad16 || ciphertext || pad16 ||
    // u64_le(len(AAD)) || u64_le(len(ciphertext))) per RFC 8439 §2.8.
    let poly_tag = poly1305_aead_mac(&poly_key, aad, &ciphertext);

    // CTX commitment T' = SHA-256(K || N || len(AD)[4 BE] || AD || T).
    let t_prime = ctx_canonical_hash(key, nonce, aad, &poly_tag);

    // Output: ciphertext || T'.
    let mut out = ciphertext;
    out.extend_from_slice(&t_prime);
    Ok(out)
}

/// Decrypt a CTX-wrapped XChaCha20-Poly1305 ciphertext.
///
/// `sealed` is the byte sequence produced by [`aead_seal_ctx`]:
/// `ciphertext || T'` where `T'` is the trailing 32-byte CTX
/// commitment. The function recomputes the Poly1305 tag over `(K, N,
/// AAD, ciphertext)`, derives `T'_expected`, and constant-time
/// compares against the supplied `T'`. On match, the ciphertext is
/// XOR-decrypted and returned in a [`Zeroizing`] wrapper.
///
/// Returns [`ProtocolError::AeadFailure`] for any of: short input
/// (less than 32 bytes), tag mismatch (wrong key, nonce, AAD, or
/// tampered ciphertext / `T'`), or AAD overflow. Per spec § 7.3 the
/// caller MUST NOT distinguish these cases to the user beyond
/// "phrase or vault is invalid".
pub fn aead_open_ctx(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    sealed: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    if aad.len() > u32::MAX as usize {
        return Err(ProtocolError::AeadFailure);
    }
    if sealed.len() < CTX_COMMITMENT_TAG_LEN {
        return Err(ProtocolError::AeadFailure);
    }

    let split = sealed.len() - CTX_COMMITMENT_TAG_LEN;
    let ciphertext = &sealed[..split];
    let t_prime: &[u8; CTX_COMMITMENT_TAG_LEN] = sealed[split..]
        .try_into()
        .expect("trailing slice is exactly CTX_COMMITMENT_TAG_LEN by construction");

    let mut chacha = XChaCha20::new(key.into(), nonce.into());

    // Re-derive the Poly1305 one-time key.
    let mut poly_key = Zeroizing::new([0u8; 32]);
    chacha.apply_keystream(poly_key.as_mut_slice());
    chacha.seek(CHACHA20_BLOCK_SIZE);

    // Recompute T from (K, N, AAD, ciphertext).
    let poly_tag = poly1305_aead_mac(&poly_key, aad, ciphertext);

    // Recompute T'_expected and constant-time compare.
    let t_prime_expected = ctx_canonical_hash(key, nonce, aad, &poly_tag);
    if !bool::from(t_prime_expected.ct_eq(t_prime)) {
        return Err(ProtocolError::AeadFailure);
    }

    // Commitment verified ⇒ decrypt without re-checking Poly1305.
    let mut plaintext = Zeroizing::new(ciphertext.to_vec());
    chacha.apply_keystream(plaintext.as_mut_slice());
    Ok(plaintext)
}

/// Compute the Poly1305 AEAD MAC per RFC 8439 §2.8:
///
/// ```text
/// MAC = Poly1305(
///         key  = poly_key (32 bytes from XChaCha20 keystream block 0),
///         data = AAD || pad16(AAD)
///             || ciphertext || pad16(ciphertext)
///             || u64_le(len(AAD)) || u64_le(len(ciphertext))
///       )
/// ```
fn poly1305_aead_mac(poly_key: &[u8; 32], aad: &[u8], ciphertext: &[u8]) -> [u8; POLY1305_TAG_LEN] {
    let key = poly1305::Key::from_slice(poly_key);
    let mut mac = Poly1305::new(key);

    mac.update_padded(aad);
    mac.update_padded(ciphertext);

    let mut len_block = [0u8; 16];
    len_block[..8].copy_from_slice(&(aad.len() as u64).to_le_bytes());
    len_block[8..].copy_from_slice(&(ciphertext.len() as u64).to_le_bytes());
    let block = poly1305::Block::from_slice(&len_block);
    mac.update(core::slice::from_ref(block));

    let tag = mac.finalize();
    let mut out = [0u8; POLY1305_TAG_LEN];
    out.copy_from_slice(tag.as_slice());
    out
}

/// Canonical-encode `(K, N, AD, T)` per spec § 5.1.1 and hash with
/// SHA-256 to produce the CTX commitment tag `T'`:
///
/// ```text
/// T' = SHA-256( K[32] || N[24] || len(AD)[4 BE] || AD || T[16] )
/// ```
///
/// Length-prefixing AAD eliminates concatenation ambiguity per
/// Chan-Rogaway 2022 §3 (without it, an attacker could shift bytes
/// between the variable AAD region and an adjacent fixed region to
/// produce two distinct inputs with the same hash).
fn ctx_canonical_hash(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    aad: &[u8],
    poly_tag: &[u8; POLY1305_TAG_LEN],
) -> [u8; CTX_COMMITMENT_TAG_LEN] {
    let mut h = Sha256::new();
    h.update(key);
    h.update(nonce);
    h.update((aad.len() as u32).to_be_bytes());
    h.update(aad);
    h.update(poly_tag);
    let result = h.finalize();
    let mut out = [0u8; CTX_COMMITMENT_TAG_LEN];
    out.copy_from_slice(&result);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DEFAULT_V0_1_KDF_PARAMS;

    /// Hand-derived golden bytes for `aad_password_wrap(default)`.
    ///
    /// 37 bytes total, broken down by spec § 3.1 + § 5.2 + § 4.3:
    /// - 10 bytes: `b"myne.v0.1|"`
    /// - 1 byte:   `0x01` (protocol_version)
    /// - 2 bytes:  `0x00 0x0D` (u16 BE length = 13)
    /// - 13 bytes: `b"password-wrap"`
    /// - 11 bytes: KDF canonical = `01 00 04 00 00 00 00 00 03 02 13`
    const AAD_PASSWORD_WRAP_DEFAULT_GOLDEN: [u8; 37] = [
        // "myne.v0.1|"
        0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
        0x01, // u16 BE 13
        0x00, 0x0D, // "password-wrap"
        0x70, 0x61, 0x73, 0x73, 0x77, 0x6F, 0x72, 0x64, 0x2D, 0x77, 0x72, 0x61, 0x70,
        // KDF canonical (default v0.1)
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x13,
    ];

    /// Same shape as `AAD_PASSWORD_WRAP_DEFAULT_GOLDEN` with the role
    /// string replaced by `b"recovery-wrap"`.
    const AAD_RECOVERY_WRAP_DEFAULT_GOLDEN: [u8; 37] = [
        // "myne.v0.1|"
        0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
        0x01, // u16 BE 13
        0x00, 0x0D, // "recovery-wrap"
        0x72, 0x65, 0x63, 0x6F, 0x76, 0x65, 0x72, 0x79, 0x2D, 0x77, 0x72, 0x61, 0x70,
        // KDF canonical (default v0.1)
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x13,
    ];

    #[test]
    fn aad_prefix_is_exactly_myne_v0_1_with_pipe() {
        assert_eq!(AAD_PREFIX_V0_1, b"myne.v0.1|");
        assert_eq!(AAD_PREFIX_V0_1.len(), 10);
        assert_eq!(AAD_PREFIX_V0_1[9], b'|');
    }

    #[test]
    fn aad_prefix_differs_from_hkdf_prefix_only_in_final_byte() {
        // Twin-prefix gotcha: spec § 1.2 + § 5.2 lock both prefixes at
        // 10 bytes with bytes [0..9] identical and byte 9 different.
        // If anyone unifies the constants by mistake, every vault on
        // disk becomes unreadable.
        let aad_prefix = AAD_PREFIX_V0_1;
        let hkdf_prefix = b"myne.v0.1 ";
        assert_eq!(aad_prefix.len(), hkdf_prefix.len());
        for i in 0..9 {
            assert_eq!(aad_prefix[i], hkdf_prefix[i], "byte {i} differs");
        }
        assert_ne!(aad_prefix[9], hkdf_prefix[9]);
        assert_eq!(aad_prefix[9], b'|');
        assert_eq!(hkdf_prefix[9], b' ');
    }

    #[test]
    fn role_string_constants_match_spec_registry() {
        // Spec § 3.1 names "password-wrap" and "recovery-wrap"; both
        // happen to be 13 bytes. Length coincidence is incidental.
        assert_eq!(ROLE_STR_PASSWORD_WRAP, b"password-wrap");
        assert_eq!(ROLE_STR_RECOVERY_WRAP, b"recovery-wrap");
        assert_eq!(ROLE_STR_PASSWORD_WRAP.len(), 13);
        assert_eq!(ROLE_STR_RECOVERY_WRAP.len(), 13);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_zero_length_for_empty() {
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, b"");
        assert_eq!(buf, [0x00, 0x00]);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_short_string() {
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, b"text/markdown");
        assert_eq!(buf.len(), 2 + 13);
        assert_eq!(buf[0..2], [0x00, 0x0D]);
        assert_eq!(&buf[2..], b"text/markdown");
    }

    #[test]
    fn push_length_prefixed_u16_be_appends_does_not_replace() {
        // Prove the writer-style helper appends to an existing buffer
        // rather than overwriting — load-bearing for callers that
        // assemble AADs in-place.
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0xAA, 0xBB]);
        push_length_prefixed_u16_be(&mut buf, b"hi");
        assert_eq!(buf.as_slice(), &[0xAA, 0xBB, 0x00, 0x02, b'h', b'i']);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_two_byte_length_at_or_above_256() {
        // 256 bytes triggers the high byte of the u16 length: 0x01 0x00.
        let payload = [0x42u8; 256];
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, &payload);
        assert_eq!(buf.len(), 2 + 256);
        assert_eq!(buf[0..2], [0x01, 0x00]);
        assert!(buf[2..].iter().all(|b| *b == 0x42));
    }

    #[test]
    fn aad_password_wrap_default_is_thirty_seven_bytes() {
        // 10 (prefix) + 1 (version) + 2 (length prefix) + 13 (role) +
        // 11 (KDF canonical) = 37.
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.len(), 37);
    }

    #[test]
    fn aad_password_wrap_default_matches_pinned_hex() {
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.as_slice(), &AAD_PASSWORD_WRAP_DEFAULT_GOLDEN[..]);
    }

    #[test]
    fn aad_recovery_wrap_default_matches_pinned_hex() {
        let aad = aad_recovery_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.as_slice(), &AAD_RECOVERY_WRAP_DEFAULT_GOLDEN[..]);
    }

    #[test]
    fn password_and_recovery_aads_differ_only_in_role_bytes() {
        // Spec § 3.1 role separation: the two AADs MUST differ. By
        // construction the only differing region is bytes 13..26 (the
        // 13-byte role string after the u16 length prefix).
        let pw = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let rec = aad_recovery_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(pw.len(), rec.len());
        for i in 0..pw.len() {
            if (13..26).contains(&i) {
                continue; // role-string region — expected to differ
            }
            assert_eq!(pw[i], rec[i], "byte {i} should match between the two AADs");
        }
        // And the two AADs as a whole are not equal.
        assert_ne!(pw, rec);
    }

    #[test]
    fn aad_changes_when_kdf_params_change() {
        // Parameter-downgrade defense (spec § 4.3 last paragraph):
        // tampering with any KDF byte changes the AAD, which fails
        // the AEAD tag check at unlock time.
        let baseline = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut tampered = DEFAULT_V0_1_KDF_PARAMS;
        tampered.t = 4; // attacker tries different iterations
        let attacked = aad_password_wrap(&tampered);
        assert_ne!(baseline, attacked);
        // Specifically, the last 11 bytes (KDF canonical region)
        // should be the only difference.
        for i in 0..(baseline.len() - 11) {
            assert_eq!(baseline[i], attacked[i], "byte {i} unexpectedly differs");
        }
    }

    #[test]
    fn length_prefix_is_u16_big_endian() {
        // Bytes 11..13 (after 10-byte prefix + 1-byte version) carry
        // the u16-BE length of the role string. Both AADs use a
        // 13-byte role, so bytes 11..13 are 0x00 0x0D.
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad[11], 0x00);
        assert_eq!(aad[12], 0x0D);
    }

    #[test]
    fn aad_prefs_blob_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.5.3: 39 bytes = prefix (10) + version (1) +
        // u16_be(10) + "prefs-blob" (10) + account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_prefs_blob(&account_number_hash);
        let expected: [u8; 39] = [
            // "myne.v0.1|" — 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role string: u16_be(10) || "prefs-blob"
            0x00, 0x0A, // u16_be(10)
            0x70, 0x72, 0x65, 0x66, 0x73, 0x2D, 0x62, 0x6C, 0x6F, 0x62, // "prefs-blob"
            // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 39, "spec § 9.5.3 mandates 39-byte AAD");
    }

    #[test]
    fn aad_prefs_blob_changes_with_account_number_hash() {
        // Cross-vault binding: different account_number_hash ⇒
        // different AAD ⇒ AEAD verification fails when a vault.prefs
        // from vault A is placed in vault B's directory.
        let hash_a = [0x00; 16];
        let mut hash_b = [0x00; 16];
        hash_b[0] = 1;
        let aad_a = aad_prefs_blob(&hash_a);
        let aad_b = aad_prefs_blob(&hash_b);
        assert_ne!(aad_a, aad_b);
        // First 23 bytes (prefix + version + length-prefixed role) match —
        // only the account_number_hash region (bytes 23..39) differs.
        assert_eq!(&aad_a[..23], &aad_b[..23]);
    }

    #[test]
    fn aad_prefs_blob_distinct_from_vault_items_key_wrap_aad() {
        // Cross-AAD distinctness: even if a future collision aligned the
        // account_number_hash bytes with an items_key_id byte sequence,
        // the role string ("prefs-blob" length-prefixed vs no role
        // string at all) makes the two AADs structurally different.
        let id: [u8; 16] = [0x00; 16];
        let prefs_aad = aad_prefs_blob(&id);
        let items_aad = aad_vault_items_key_wrap(&id);
        assert_ne!(prefs_aad, items_aad);
        assert_ne!(prefs_aad.len(), items_aad.len());
    }

    #[test]
    fn aad_vault_items_key_wrap_default_matches_pinned_hex() {
        // Hand-derived: prefix (10) + version (1) + items_key_id (16) = 27 bytes.
        let items_key_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_vault_items_key_wrap(&items_key_id);
        let expected: [u8; 27] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_vault_items_key_wrap_changes_with_id() {
        // Different items_key_id ⇒ different AAD (the only variable
        // in the v0.1 layout).
        let id1 = [0x00; 16];
        let id2 = [0xFF; 16];
        assert_ne!(
            aad_vault_items_key_wrap(&id1),
            aad_vault_items_key_wrap(&id2)
        );
    }

    /// Shared per-note AAD test fixtures. `items_key_id` matches the
    /// pattern used by `aad_vault_items_key_wrap_default_matches_pinned_hex`;
    /// `note_uuid` is the byte-reverse of that pattern so a copy-paste
    /// confusion between the two parameters is visible at a glance in
    /// the golden bytes.
    const NOTE_AAD_FIXTURE_ITEMS_KEY_ID: [u8; 16] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF,
    ];
    const NOTE_AAD_FIXTURE_NOTE_UUID: [u8; 16] = [
        0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        0x00,
    ];

    #[test]
    fn aad_note_item_key_wrap_default_matches_pinned_hex() {
        // Hand-derived per spec § 5.2:
        // prefix (10) + version (1) + items_key_id (16) + note_uuid (16) = 43 bytes.
        let aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let expected: [u8; 43] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF, // note_uuid
            0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
            0x11, 0x00,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_note_item_key_wrap_changes_with_note_uuid() {
        // §6.5 cross-note rename protection: changing note_uuid alone
        // must change the AAD (else a renamed .myn would decrypt under
        // the old AAD).
        let uuid_a = [0x00; 16];
        let uuid_b = [0xFF; 16];
        assert_ne!(
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &uuid_a),
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &uuid_b),
        );
    }

    #[test]
    fn aad_note_item_key_wrap_extends_vault_items_key_wrap_with_note_uuid() {
        // Structural property: the per-note AAD is the singleton AAD
        // followed by note_uuid. A drift here would break parity with
        // §5.2's prose definition.
        let vault_aad = aad_vault_items_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID);
        let note_aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        assert_eq!(&note_aad[..vault_aad.len()], vault_aad.as_slice());
        assert_eq!(
            &note_aad[vault_aad.len()..],
            &NOTE_AAD_FIXTURE_NOTE_UUID[..]
        );
    }

    #[test]
    fn aad_note_content_encrypt_default_matches_pinned_hex() {
        // Hand-derived per spec § 5.2:
        // prefix (10) + version (1) + items_key_id (16) + note_uuid (16)
        // + u16-BE-len (2) + "text/markdown" (13) = 58 bytes.
        let aad =
            aad_note_content_encrypt(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let expected: [u8; 58] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF, // note_uuid
            0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
            0x11, 0x00, // u16-BE length = 13
            0x00, 0x0D, // "text/markdown"
            0x74, 0x65, 0x78, 0x74, 0x2F, 0x6D, 0x61, 0x72, 0x6B, 0x64, 0x6F, 0x77, 0x6E,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_note_content_encrypt_extends_note_item_key_wrap_with_length_prefixed_content_type() {
        // Structural property: the content-encrypt AAD is the per-note
        // wrap AAD followed by length-prefixed "text/markdown". v0.1
        // hardcodes the content_type literal; a buggy decoder using a
        // different literal would diverge here, not in some downstream
        // parser.
        let wrap_aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let content_aad =
            aad_note_content_encrypt(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        assert_eq!(&content_aad[..wrap_aad.len()], wrap_aad.as_slice());
        // After the wrap-AAD prefix: u16-BE 13 || "text/markdown"
        assert_eq!(
            &content_aad[wrap_aad.len()..wrap_aad.len() + 2],
            &[0x00, 0x0D]
        );
        assert_eq!(&content_aad[wrap_aad.len() + 2..], b"text/markdown");
    }

    #[test]
    fn aad_layout_protocol_version_byte_is_one() {
        // Byte 10 (after the 10-byte prefix) is the protocol_version
        // byte. v0.1 mandates `0x01` (spec § 9.3).
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad[10], 0x01);
    }

    // ---- CTX seal/open tests ----

    /// Fixed test vector for deterministic seal/open round-trips.
    const TEST_KEY: [u8; AEAD_KEY_LEN] = [
        0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99,
    ];
    const TEST_NONCE: [u8; AEAD_NONCE_LEN] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    ];

    #[test]
    fn seal_then_open_round_trips_root_key_sized_plaintext() {
        // Realistic case: 32-byte plaintext (a wrapped `root_key`).
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed =
            aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).expect("seal succeeds");
        // Output length: 32 (ciphertext) + 32 (CTX tag) = 64. Matches
        // spec § 9.3 offset 89's `enc_root_key_password` field width.
        assert_eq!(sealed.len(), 32 + CTX_COMMITMENT_TAG_LEN);

        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).expect("open succeeds");
        assert_eq!(&plaintext[..], &opened[..]);
    }

    #[test]
    fn seal_then_open_round_trips_empty_plaintext() {
        // Edge case: zero-length plaintext. Output is just the 32-byte CTX tag.
        let aad = b"non-empty aad";
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &[], aad).unwrap();
        assert_eq!(sealed.len(), CTX_COMMITMENT_TAG_LEN);

        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, aad).unwrap();
        assert!(opened.is_empty());
    }

    #[test]
    fn seal_then_open_round_trips_empty_aad() {
        // Edge case: zero-length AAD.
        let plaintext = [0x77u8; 32];
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &[]).unwrap();
        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &[]).unwrap();
        assert_eq!(&plaintext[..], &opened[..]);
    }

    #[test]
    fn open_rejects_tampered_ciphertext_byte() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        // Flip a bit in the ciphertext region.
        sealed[5] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_tampered_ctx_tag_byte() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        // Flip a bit in the CTX tag region (last 32 bytes).
        let tag_start = sealed.len() - CTX_COMMITMENT_TAG_LEN;
        sealed[tag_start + 7] ^= 0x80;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_tampered_aad() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut tampered_aad = aad.clone();
        tampered_aad[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &tampered_aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_wrong_key() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut wrong_key = TEST_KEY;
        wrong_key[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&wrong_key, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_wrong_nonce() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut wrong_nonce = TEST_NONCE;
        wrong_nonce[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &wrong_nonce, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_short_input_below_tag_length() {
        let aad = b"any";
        let too_short = [0u8; CTX_COMMITMENT_TAG_LEN - 1];
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &too_short, aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn ciphertext_matches_rustcrypto_xchacha20poly1305() {
        // Cross-check the hand-rolled stream-cipher path against
        // RustCrypto's high-level AEAD. The ciphertext bytes must be
        // byte-exact equivalent. This validates that:
        // - we derive the Poly1305 one-time key correctly (block 0),
        // - we seek to the right keystream offset for plaintext,
        // - XChaCha20 nonce / key bindings are wired correctly.
        use chacha20poly1305::aead::AeadInPlace;
        use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

        let plaintext = b"Some plaintext to encrypt; must match RustCrypto.";
        let aad = b"some aad bytes";

        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, plaintext, aad).unwrap();
        let our_ct = &sealed[..plaintext.len()];

        let cipher = XChaCha20Poly1305::new((&TEST_KEY).into());
        let mut rc_buf = plaintext.to_vec();
        let _rc_tag = cipher
            .encrypt_in_place_detached((&TEST_NONCE).into(), aad, &mut rc_buf)
            .expect("RustCrypto encrypt");

        assert_eq!(our_ct, rc_buf.as_slice());
    }

    #[test]
    fn ctx_commitment_can_be_independently_verified() {
        // Strong cross-check: independently compute T using
        // RustCrypto's high-level AEAD, then independently compute
        // T' = SHA-256(K || N || len(AD)[4 BE] || AD || T) and
        // compare with our seal output.
        use chacha20poly1305::aead::AeadInPlace;
        use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);

        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let our_t_prime = &sealed[plaintext.len()..];

        // Independently get T from RustCrypto.
        let cipher = XChaCha20Poly1305::new((&TEST_KEY).into());
        let mut rc_buf = plaintext.to_vec();
        let rc_tag = cipher
            .encrypt_in_place_detached((&TEST_NONCE).into(), &aad, &mut rc_buf)
            .unwrap();

        // Independently compute T'.
        let mut h = Sha256::new();
        h.update(TEST_KEY);
        h.update(TEST_NONCE);
        h.update((aad.len() as u32).to_be_bytes());
        h.update(&aad);
        h.update(rc_tag);
        let independent_t_prime = h.finalize();

        assert_eq!(our_t_prime, independent_t_prime.as_slice());
    }

    #[test]
    fn seal_output_length_equals_plaintext_plus_tag() {
        // Layout invariant: sealed.len() == plaintext.len() + 32.
        for pt_len in [0, 1, 16, 32, 100, 1000] {
            let plaintext = alloc::vec![0x55u8; pt_len];
            let aad = b"x";
            let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, aad).unwrap();
            assert_eq!(
                sealed.len(),
                pt_len + CTX_COMMITMENT_TAG_LEN,
                "length mismatch for plaintext len {pt_len}"
            );
        }
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/ctx-aead/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_ctx_aead_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act.
    /// Run with:
    /// `cargo test -p protocol --lib emit_ctx_aead_vectors_for_paste -- --ignored`
    ///
    /// 13 cases pin (per MYND-68 / D3; +`aad_search_index_blob` MYND-29;
    /// +`aad_workspace_blob` MYND-254):
    /// - 8 `aad_canonical_bytes`: one per pub `aad_*` builder
    ///   (`aad_password_wrap`, `aad_recovery_wrap`,
    ///   `aad_vault_items_key_wrap`, `aad_note_item_key_wrap`,
    ///   `aad_note_content_encrypt`, `aad_prefs_blob`,
    ///   `aad_search_index_blob`, `aad_workspace_blob`). Pins each
    ///   builder's canonical AAD byte assembly independently of any AEAD
    ///   invocation — drift in §5.2 AAD construction surfaces here without
    ///   requiring a downstream AEAD test to fire.
    /// - 2 `encrypt`: short empty-AAD + medium content-AAD plaintext
    ///   cases — exercise `aead_seal_ctx` at the primitive level.
    /// - 1 `decrypt_ok`: round-trip the medium encrypt case.
    /// - 2 `decrypt_aead_fail`: (a) ciphertext-tamper flips one byte
    ///   in the sealed region, (b) AAD-tamper passes a different AAD
    ///   to the verifier. Both collapse to `ProtocolError::AeadFailure`
    ///   per spec §6.4 non-distinguishing rule.
    #[test]
    #[ignore]
    fn emit_ctx_aead_vectors_for_paste() {
        extern crate std;

        fn hex_lower(bytes: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> alloc::string::String {
            let mut out = alloc::string::String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&alloc::format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        // FAST_TEST KDF params — match the cross-category fixtures so
        // a reviewer cross-checks aad_password_wrap output against
        // the embedded KDF block in vault-meta vectors.
        let fast_test_kdf = KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };

        // Deterministic fixture inputs across builder calls.
        let items_key_id: [u8; 16] = [0xAB; 16];
        let note_uuid: [u8; 16] = [0xCD; 16];
        let account_number_hash: [u8; 16] = [0x12; 16];

        // AEAD primitive inputs.
        let key: [u8; AEAD_KEY_LEN] = [0x5A; AEAD_KEY_LEN];
        let nonce_a: [u8; AEAD_NONCE_LEN] = [0x6B; AEAD_NONCE_LEN];
        let nonce_b: [u8; AEAD_NONCE_LEN] = [0x7C; AEAD_NONCE_LEN];

        // Short plaintext, no AAD (primitive-level coverage).
        let pt_short: alloc::vec::Vec<u8> = b"abc".to_vec();
        let aad_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let sealed_short =
            aead_seal_ctx(&key, &nonce_a, &pt_short, &aad_empty).expect("aead_seal_ctx short");

        // Medium plaintext, AAD from aad_note_content_encrypt
        // (a non-trivial 58-byte AAD).
        let pt_medium: alloc::vec::Vec<u8> = (0..256u32).map(|i| (i % 256) as u8).collect();
        let aad_content = aad_note_content_encrypt(&items_key_id, &note_uuid);
        let sealed_medium =
            aead_seal_ctx(&key, &nonce_b, &pt_medium, &aad_content).expect("aead_seal_ctx medium");

        // Round-trip sanity in the generator.
        let recovered = aead_open_ctx(&key, &nonce_b, &sealed_medium, &aad_content)
            .expect("aead_open round-trip");
        assert_eq!(recovered.as_slice(), pt_medium.as_slice());

        // Tamper variant 1: flip last byte of CTX tag region of sealed_medium.
        let mut sealed_tag_tamper = sealed_medium.clone();
        let last_idx = sealed_tag_tamper.len() - 1;
        sealed_tag_tamper[last_idx] ^= 0xFF;
        assert!(
            aead_open_ctx(&key, &nonce_b, &sealed_tag_tamper, &aad_content).is_err(),
            "tag-tamper must reject"
        );

        // Tamper variant 2: same sealed_medium but caller passes different AAD.
        let aad_wrong = aad_prefs_blob(&account_number_hash); // intentionally different
        assert!(
            aead_open_ctx(&key, &nonce_b, &sealed_medium, &aad_wrong).is_err(),
            "AAD-tamper must reject"
        );

        // Compute canonical AAD bytes for all 8 pub builders.
        let aad_pw = aad_password_wrap(&fast_test_kdf);
        let aad_rec = aad_recovery_wrap(&fast_test_kdf);
        let aad_vik = aad_vault_items_key_wrap(&items_key_id);
        let aad_nik = aad_note_item_key_wrap(&items_key_id, &note_uuid);
        // aad_content already computed
        let aad_pb = aad_prefs_blob(&account_number_hash);
        let aad_sib = aad_search_index_blob(&account_number_hash);
        let aad_wsb = aad_workspace_blob(&account_number_hash);

        let key_hex = hex_lower(&key);
        let nonce_a_hex = hex_lower(&nonce_a);
        let nonce_b_hex = hex_lower(&nonce_b);

        // ---- Emit JSON ----------------------------------------------

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"ctx-aead\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §5.1 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::aead_seal_ctx + protocol::aead_open_ctx byte mapping (XChaCha20-Poly1305 + CTX commitment outer per Chan & Rogaway 2022) AND each of the 8 pub aad_* builder functions' canonical byte assembly. 13 cases: 8 aad_canonical_bytes (one per builder) + 2 encrypt (short empty-AAD + medium content-AAD plaintext) + 1 decrypt_ok (round-trip) + 2 decrypt_aead_fail (tag-tamper + AAD-tamper). Cases generated by `cargo test -p protocol --lib emit_ctx_aead_vectors_for_paste -- --ignored` (in protocol/src/aead.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // Helper: emit aad_canonical_bytes case.
        let emit_aad = |dump: &mut alloc::string::String,
                        slug: &str,
                        description: &str,
                        builder_name: &str,
                        params_lines: &str,
                        aad_bytes: &[u8],
                        trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"ctx-aead/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"aad_canonical_bytes\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_builder_name\": \"{}\",\n",
                builder_name
            ));
            dump.push_str(params_lines);
            dump.push_str(&alloc::format!(
                "      \"expected_aad_bytes_hex\": \"{}\"\n",
                hex_lower(aad_bytes)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        // KDF params block lines for the AAD-canonical-bytes cases.
        let kdf_params_lines = alloc::format!(
            "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
            fast_test_kdf.m_kib,
            fast_test_kdf.t,
            fast_test_kdf.p,
            fast_test_kdf.argon2_version
        );
        let items_key_id_lines = alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        );
        let note_uuid_lines = alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        );
        let account_hash_lines = alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_number_hash)
        );

        // 1: aad_password_wrap
        emit_aad(
            &mut dump,
            "aad-password-wrap",
            "Canonical bytes from aad_password_wrap with FAST_TEST KdfParams (m_kib=8, t=1, p=1, v=0x13). Pins the §5.2 password-wrap AAD assembly: 'myne.v0.1|' prefix + version byte + role 'pw' + serialized 11-byte KDF params block.",
            "aad_password_wrap",
            &kdf_params_lines,
            &aad_pw,
            true,
        );

        // 2: aad_recovery_wrap
        emit_aad(
            &mut dump,
            "aad-recovery-wrap",
            "Canonical bytes from aad_recovery_wrap. Same FAST_TEST KdfParams; differs from aad_password_wrap only in the role byte ('rk' instead of 'pw' — drift detection across the password/recovery split).",
            "aad_recovery_wrap",
            &kdf_params_lines,
            &aad_rec,
            true,
        );

        // 3: aad_vault_items_key_wrap
        emit_aad(
            &mut dump,
            "aad-vault-items-key-wrap",
            "Canonical bytes from aad_vault_items_key_wrap with items_key_id = 0xAB×16. Pins the singleton-itemsKey wrap AAD ('itemsKey' role with NO per-note UUID — distinguishes this builder from aad_note_item_key_wrap whose name differs by one trailing 's').",
            "aad_vault_items_key_wrap",
            &items_key_id_lines,
            &aad_vik,
            true,
        );

        // 4: aad_note_item_key_wrap
        emit_aad(
            &mut dump,
            "aad-note-item-key-wrap",
            "Canonical bytes from aad_note_item_key_wrap with items_key_id = 0xAB×16 + note_uuid = 0xCD×16. Pins the per-note item_key wrap AAD ('item-key' role WITH note_uuid). Visually adjacent to aad_vault_items_key_wrap; one-character difference in name pins a real type-confusion-class hazard (§5.2 spec note).",
            "aad_note_item_key_wrap",
            &alloc::format!("{}{}", items_key_id_lines, note_uuid_lines),
            &aad_nik,
            true,
        );

        // 5: aad_note_content_encrypt
        emit_aad(
            &mut dump,
            "aad-note-content-encrypt",
            "Canonical bytes from aad_note_content_encrypt. Same items_key_id + note_uuid pair; differs from aad_note_item_key_wrap in the role byte AND adds the hardcoded content_type 'text/markdown' (13 ASCII bytes with 2-byte BE length prefix). 58-byte total AAD per spec §5.2.",
            "aad_note_content_encrypt",
            &alloc::format!("{}{}", items_key_id_lines, note_uuid_lines),
            &aad_content,
            true,
        );

        // 6: aad_prefs_blob
        emit_aad(
            &mut dump,
            "aad-prefs-blob",
            "Canonical bytes from aad_prefs_blob with account_number_hash = 0x12×16. Pins the §9.5.3 39-byte vault.prefs AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'prefs-blob' (2+10) + account_number_hash (16).",
            "aad_prefs_blob",
            &account_hash_lines,
            &aad_pb,
            true,
        );

        // 7: aad_search_index_blob
        emit_aad(
            &mut dump,
            "aad-search-index-blob",
            "Canonical bytes from aad_search_index_blob with account_number_hash = 0x12×16 (MYND-29, §9.6). Pins the 46-byte vault.search AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'search-index-blob' (2+17) + account_number_hash (16). Same shape as aad_prefs_blob but a distinct 17-byte role string — domain-separates the search index from the prefs blob. NOTE: the AAD role 'search-index-blob' is DISTINCT from the HKDF KEK role 'search-index-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_search_index_blob",
            &account_hash_lines,
            &aad_sib,
            true,
        );

        // 8: aad_workspace_blob
        emit_aad(
            &mut dump,
            "aad-workspace-blob",
            "Canonical bytes from aad_workspace_blob with account_number_hash = 0x12×16 (MYND-254, §9.7). Pins the 43-byte vault.workspace AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'workspace-blob' (2+14) + account_number_hash (16). Same shape as aad_prefs_blob / aad_search_index_blob but a distinct 14-byte role string — domain-separates the workspace blob from the other vault singletons. NOTE: the AAD role 'workspace-blob' is DISTINCT from the HKDF KEK role 'session-state-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_workspace_blob",
            &account_hash_lines,
            &aad_wsb,
            true,
        );

        // 9: encrypt-short-empty-aad
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/encrypt-short-empty-aad\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Encrypt 3-byte plaintext 'abc' with empty AAD. Primitive-level coverage of aead_seal_ctx without binding to any AAD builder — proves the CTX commitment outer construction works at the bare-bytes layer. Expected sealed = 3-byte ciphertext + 32-byte CTX tag = 35 bytes.")
        ));
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_a_hex
        ));
        dump.push_str("      \"input_aad_hex\": \"\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_hex\": \"{}\",\n",
            hex_lower(&pt_short)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_sealed_hex\": \"{}\"\n",
            hex_lower(&sealed_short)
        ));
        dump.push_str("    },\n");

        // 10: encrypt-medium-content-aad
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/encrypt-medium-content-aad\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Encrypt 256-byte plaintext (byte i = i mod 256) with AAD = aad_note_content_encrypt(items_key_id=0xAB×16, note_uuid=0xCD×16) (58-byte content-encrypt AAD). Realistic AEAD invocation matching the .myn-blob inner-content layer. Expected sealed = 256-byte ciphertext + 32-byte CTX tag = 288 bytes.")
        ));
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_hex\": \"{}\",\n",
            hex_lower(&pt_medium)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_sealed_hex\": \"{}\"\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str("    },\n");

        // 11: decrypt-ok-medium
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-ok-medium\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the sealed blob from encrypt-medium-content-aad back to the 256-byte plaintext under the same key + nonce + AAD. Proves aead_open_ctx recovers exactly the plaintext bytes that aead_seal_ctx consumed.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(&pt_medium)
        ));
        dump.push_str("    },\n");

        // 12: decrypt-tag-tamper
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-tag-tamper\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Last byte of the 32-byte CTX commitment tag flipped via XOR 0xFF. aead_open_ctx MUST surface Err(ProtocolError::AeadFailure) — the CTX commitment construction (SHA-256 over key||nonce||AAD-len||AAD||Poly1305-tag) catches the modification at the constant-time comparison step.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_tag_tamper)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape("last byte of 32-byte CTX commitment tag region flipped via XOR 0xFF")
        ));
        dump.push_str("    },\n");

        // 13: decrypt-aad-tamper
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-aad-tamper\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Sealed blob from encrypt-medium-content-aad with caller passing a DIFFERENT AAD (aad_prefs_blob bytes instead of aad_note_content_encrypt) to the verifier. aead_open_ctx MUST surface Err(ProtocolError::AeadFailure) — the CTX commitment includes the AAD bytes, so swapping AAD invalidates the tag. Same non-distinguishing variant as the tag-tamper case per spec §6.4.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_wrong)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape("AAD swap: caller passes aad_prefs_blob bytes instead of the aad_note_content_encrypt bytes the encoder used")
        ));
        dump.push_str("    }\n");

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_ctx_aead_vectors.json", dump.as_bytes())
            .expect("write ctx-aead vectors dump");
    }

    /// Vector generator for the `aad-construction` companion category.
    /// `#[ignore]`-gated — emits ready-to-copy JSON to
    /// `/tmp/myne_aad_construction_vectors.json`. For each of the 8 pub
    /// `aad_*` builders it pins the full AAD bytes (as `ctx-aead` does)
    /// **plus** the per-call-site framing decomposition: a segment list
    /// breaking the AAD into `aad_prefix` / `protocol_version` /
    /// `role_length_be16` / `role_label` / bound-parameter fields with
    /// offsets and lengths. A port that produces the right total bytes
    /// but assembles them from the wrong structural pieces (e.g. forgets
    /// the u16 length-prefix, or orders fields wrong) is caught by the
    /// segment check even when the byte total happens to match.
    #[test]
    #[ignore = "vector generator — run explicitly to refresh aad-construction cases.json"]
    fn emit_aad_construction_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        fn hex_lower(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> String {
            let mut out = String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&alloc::format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out
        }

        let params = DEFAULT_V0_1_KDF_PARAMS;
        // Distinct byte patterns per field — easy visual cross-check.
        let items_key_id: [u8; 16] = [0xB1; 16];
        let note_uuid: [u8; 16] = [0xC2; 16];
        let account_number_hash: [u8; 16] = [0xA3; 16];

        let aad_pw = aad_password_wrap(&params);
        let aad_rec = aad_recovery_wrap(&params);
        let aad_vik = aad_vault_items_key_wrap(&items_key_id);
        let aad_nik = aad_note_item_key_wrap(&items_key_id, &note_uuid);
        let aad_prefs = aad_prefs_blob(&account_number_hash);
        let aad_search = aad_search_index_blob(&account_number_hash);
        let aad_workspace = aad_workspace_blob(&account_number_hash);
        let aad_content = aad_note_content_encrypt(&items_key_id, &note_uuid);

        let kdf_params_json = alloc::format!(
            "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
            params.m_kib, params.t, params.p, params.argon2_version
        );
        let items_key_id_json = alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        );
        let note_uuid_json = alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        );
        let account_hash_json = alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_number_hash)
        );

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"aad-construction\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §5.2\",\n");
        dump.push_str("  \"description\": \"Per-call-site AAD framing decomposition for every pub aad_* builder (protocol/src/aead.rs). Pins the full AAD bytes (as ctx-aead does) PLUS the structural segment breakdown — aad_prefix (myne.v0.1|) / protocol_version / u16-be length prefix / role_label / bound parameters — with byte offsets. Complements ctx-aead's aad_canonical_bytes cases (which pin only the total bytes) by making the assembly structure verifiable. 8 cases, one per builder. Cases generated by `cargo test -p protocol --lib emit_aad_construction_vectors_for_paste -- --ignored` (in protocol/src/aead.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_case = |dump: &mut String,
                         builder_name: &str,
                         description: &str,
                         full_aad: &[u8],
                         segments: &[(&str, usize)],
                         inputs_json: &str,
                         trailing_comma: bool| {
            let total: usize = segments.iter().map(|(_, len)| *len).sum();
            assert_eq!(
                total,
                full_aad.len(),
                "segment lengths must sum to AAD length for {}",
                builder_name
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"aad-construction/v0.1/{}\",\n",
                builder_name
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_builder_name\": \"{}\",\n",
                builder_name
            ));
            dump.push_str(inputs_json);
            dump.push_str(&alloc::format!(
                "      \"expected_aad_hex\": \"{}\",\n",
                hex_lower(full_aad)
            ));
            dump.push_str("      \"informational_aad_segments\": [\n");
            let mut offset = 0usize;
            for (i, (label, len)) in segments.iter().enumerate() {
                let seg = &full_aad[offset..offset + len];
                dump.push_str(&alloc::format!(
                    "        {{ \"offset\": {}, \"length\": {}, \"label\": \"{}\", \"bytes_hex\": \"{}\" }}{}\n",
                    offset,
                    len,
                    label,
                    hex_lower(seg),
                    if i + 1 == segments.len() { "" } else { "," }
                ));
                offset += len;
            }
            dump.push_str("      ]\n");
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "aad_password_wrap",
            "AAD bound into the AEAD wrap of root_key under the password-derived wrap key (§3.1). Length-prefixed role 'password-wrap' + canonical 11-byte kdf_params block (bound for downgrade defense). account_number_hash is NOT in this AAD — it mixes into the wrap-key salt instead (§3.1).",
            &aad_pw,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_recovery_wrap",
            "AAD bound into the AEAD wrap of root_key under the recovery-phrase-derived wrap key (§3.1). Identical shape to aad_password_wrap but role 'recovery-wrap' — the role bytes are the sole domain separator between the two wraps.",
            &aad_rec,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_vault_items_key_wrap",
            "AAD bound into the AEAD wrap of the singleton v0.1 itemsKey (§3.3 + §9.3 offset 281). No length-prefixed role — just prefix + version + items_key_id. Distinct from aad_note_item_key_wrap (which adds note_uuid).",
            &aad_vik,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
            ],
            &items_key_id_json,
            true,
        );
        let nik_inputs = alloc::format!("{}{}", items_key_id_json, note_uuid_json);
        emit_case(
            &mut dump,
            "aad_note_item_key_wrap",
            "AAD bound into the AEAD wrap of a per-note item_key under the singleton itemsKey (§5.2 + §6.2). Binds both items_key_id and note_uuid — the per-note scope. The vault_/note_ prefix discipline retires the items_key/item_key one-letter footgun.",
            &aad_nik,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
                ("note_uuid", 16),
            ],
            &nik_inputs,
            true,
        );
        emit_case(
            &mut dump,
            "aad_prefs_blob",
            "AAD bound into the AEAD encryption of the vault.prefs blob (§5.2 + §9.5.3). Length-prefixed role 'prefs-blob' + account_number_hash (NOT items_key_id — prefs live outside the items_key lineage for v005 portability).",
            &aad_prefs,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 10),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_search_index_blob",
            "AAD bound into the AEAD encryption of the vault.search index blob (§9.6, MYND-29). Same shape as aad_prefs_blob with the distinct role 'search-index-blob' — domain-separates the search index from prefs so neither AEAD-verifies under the other's key/AAD.",
            &aad_search,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_workspace_blob",
            "AAD bound into the AEAD encryption of the vault.workspace blob (§9.7, MYND-254). Same shape as aad_prefs_blob / aad_search_index_blob with the distinct role 'workspace-blob' (14 bytes) — domain-separates the workspace state from the other vault singletons so none AEAD-verifies under another's key/AAD.",
            &aad_workspace,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 14),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        let content_inputs = alloc::format!("{}{}", items_key_id_json, note_uuid_json);
        emit_case(
            &mut dump,
            "aad_note_content_encrypt",
            "AAD bound into the AEAD encryption of a note's plaintext under its per-note item_key (§5.2 + §6.2). Binds items_key_id + note_uuid + a length-prefixed content_type, hardcoded 'text/markdown' in v0.1 (no per-call parameter).",
            &aad_content,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
                ("note_uuid", 16),
                ("content_type_length_be16", 2),
                ("content_type", 13),
            ],
            &content_inputs,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_aad_construction_vectors.json", dump.as_bytes())
            .expect("write aad-construction vectors dump");
    }
}
