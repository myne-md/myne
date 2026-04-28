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
const AAD_PREFIX_V0_1: &[u8] = b"myne.v0.1|";

/// `protocol_version` byte bound into every wrap AAD
/// (spec § 9.3 offset 4 = `0x01` for v0.1).
const PROTOCOL_VERSION_V0_1: u8 = 0x01;

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
/// **Spec gap noted.** Spec § 5.2 defines `AAD_wrap_item_key` for the
/// per-note `item_key` (which carries `note_uuid`); the singleton
/// `itemsKey` wrap has no per-note UUID. This builder uses the
/// natural reduction: AAD prefix || protocol_version || items_key_id.
/// A spec follow-on landing in `protocol.md` § 5.2 should pin this
/// shape explicitly before v1.0 ship; until then this function is the
/// de-facto definition.
///
/// Layout (27 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.3)
/// items_key_id     16 bytes  (UUIDv7 of the singleton v0.1 itemsKey)
/// ```
pub fn aad_items_key_wrap(items_key_id: &[u8; 16]) -> Vec<u8> {
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

/// Common AAD assembly. Length prefixes are encoded as **u16
/// big-endian**.
///
/// **Spec gap flagged.** Spec § 5.2 prose says
/// "length-prefixed UTF-8" without pinning the prefix width. This
/// implementation chooses u16 big-endian to match the binary-format
/// convention elsewhere in the spec (§ 9.2 reads `enc_item_key_len`
/// as a 2-byte big-endian field). A spec follow-on landing in
/// `protocol.md` § 5.2 should pin the width explicitly before v1.0
/// ship; until then this module is the de-facto definition.
fn build_wrap_aad(role: &[u8], kdf_params: &KdfParams) -> Vec<u8> {
    debug_assert!(
        role.len() <= u16::MAX as usize,
        "role string longer than u16 length-prefix can encode",
    );
    let role_len_be = (role.len() as u16).to_be_bytes();
    let kdf_canonical = serialize_kdf_params(kdf_params);

    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + role_len_be.len() + role.len() + kdf_canonical.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(&role_len_be);
    aad.extend_from_slice(role);
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
    fn aad_items_key_wrap_default_matches_pinned_hex() {
        // Hand-derived: prefix (10) + version (1) + items_key_id (16) = 27 bytes.
        let items_key_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_items_key_wrap(&items_key_id);
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
    fn aad_items_key_wrap_changes_with_id() {
        // Different items_key_id ⇒ different AAD (the only variable
        // in the v0.1 layout).
        let id1 = [0x00; 16];
        let id2 = [0xFF; 16];
        assert_ne!(aad_items_key_wrap(&id1), aad_items_key_wrap(&id2));
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
}
