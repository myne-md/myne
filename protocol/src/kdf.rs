//! Argon2id wrap-key derivation — see `docs/spec/protocol.md` § 3.1, § 4.
//!
//! Two parallel paths derive 32-byte AEAD keys that wrap `root_key`:
//!
//! - [`derive_password_wrap_key`] — input is the master password
//!   (UTF-8 bytes); salt prefix is `"myne.v0.1 argon2id-password|"`.
//! - [`derive_recovery_wrap_key`] — input is the BIP-39 24-word phrase
//!   joined as `phrase_normalized` (`RecoveryPhrase::join_normalized`);
//!   salt prefix is `"myne.v0.1 argon2id-recovery|"`.
//!
//! Both paths share the same Argon2id parameter set
//! (`m, t, p, argon2_version`), drawn from `vault.meta` and bound into
//! the wrap AADs (spec § 4.3) so any tampering with the parameters
//! invalidates the AEAD tag downstream of these functions.
//!
//! ## Salt construction (spec § 3.1)
//!
//! ```text
//! salt = SHA-256( prefix || account_number_hash || salt_random )[:16]
//! ```
//!
//! Mixing `account_number_hash` into the salt prevents pre-computation
//! of Argon2id outputs across accounts (account-binding); using two
//! distinct prefixes domain-separates the password and recovery
//! Argon2id outputs even if the same secret were ever used for both
//! (which spec § 3.1 last paragraph mandates against).
//!
//! ## Argon2id parameters
//!
//! Parameters come from a [`KdfParams`] supplied by the caller. v0.1
//! mandates `argon2_version = 0x13`; values other than `0x13` (or the
//! also-published `0x10` retained as a defensive case) return
//! [`ProtocolError::KdfFailure`]. Range checks on `m`, `t`, `p` are
//! deferred to the `argon2` crate's `Params::new` constructor — Argon2
//! RFC 9106 minima (`m >= 8*p`, `t >= 1`, `p >= 1`) surface there.
//!
//! ## Twin-prefix gotcha (3rd variant)
//!
//! The salt prefixes are 28-byte ASCII strings that share the same
//! `"myne.v0.1 argon2id-"` head as the HKDF prefix `"myne.v0.1 "` and
//! the AAD prefix `"myne.v0.1|"`. **All three prefix families differ
//! in their trailing-character region**; tests pin the exact bytes
//! verbatim because any drift silently invalidates every existing
//! vault.

use crate::error::ProtocolError;
use crate::phrase::RecoveryPhrase;
use crate::types::KdfParams;
use argon2::{Algorithm, Argon2, Params, Version};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Salt prefix for the password-derived wrap key
/// (spec § 3.1; 28 ASCII bytes, trailing pipe).
const SALT_PREFIX_PASSWORD: &[u8] = b"myne.v0.1 argon2id-password|";

/// Salt prefix for the recovery-phrase-derived wrap key
/// (spec § 3.1; 28 ASCII bytes, trailing pipe).
const SALT_PREFIX_RECOVERY: &[u8] = b"myne.v0.1 argon2id-recovery|";

/// Argon2id salt length: 16 bytes (truncated SHA-256 output).
pub const ARGON2_SALT_LEN: usize = 16;

/// Argon2id wrap-key output length: 32 bytes (256-bit AEAD key).
pub const ARGON2_OUTPUT_LEN: usize = 32;

/// Derive the 32-byte AEAD wrap key for the password-protected copy of
/// `root_key` (spec § 3.1).
///
/// Salt = SHA-256(`"myne.v0.1 argon2id-password|"` || `account_number_hash`
/// || `salt_random`)[:16]. Argon2id is invoked with the parameters from
/// `params` and the `password` UTF-8 bytes as the password input. Output
/// is `Zeroizing<[u8; 32]>` so the wrap key is wiped on drop.
///
/// Returns [`ProtocolError::KdfFailure`] for any Argon2id error
/// (out-of-range parameters, allocation failure, etc.). Underlying
/// detail is intentionally dropped at the `map_err` boundary; spec
/// § 7.3 / PRD's no-`String`-in-errors rule applies. A future
/// hardening pass MAY add backend-side `tracing` logging of the
/// concrete `argon2::Error` before mapping; today it is discarded.
pub fn derive_password_wrap_key(
    password: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_PASSWORD, account_number_hash, salt_random);
    argon2id_derive(password.as_bytes(), &salt, params)
}

/// Derive the 32-byte AEAD wrap key for the recovery-phrase-protected
/// copy of `root_key` (spec § 3.1).
///
/// Internally calls `phrase.join_normalized()` to obtain the spec § 7.4
/// `phrase_normalized` form — single-space-joined ASCII-lowercase BIP-39
/// words. The bytes of that string are passed as the Argon2id password
/// input. Salt construction uses the recovery prefix
/// `"myne.v0.1 argon2id-recovery|"` (distinct from the password prefix).
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as [`derive_password_wrap_key`]).
pub fn derive_recovery_wrap_key(
    phrase: &RecoveryPhrase,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_RECOVERY, account_number_hash, salt_random);
    let phrase_normalized = phrase.join_normalized();
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// `salt = SHA-256(prefix || account_number_hash || salt_random)[:16]`
/// per spec § 3.1.
fn build_salt(
    prefix: &[u8],
    account_number_hash: &[u8; 16],
    salt_random: &[u8; 16],
) -> [u8; ARGON2_SALT_LEN] {
    let mut h = Sha256::new();
    h.update(prefix);
    h.update(account_number_hash);
    h.update(salt_random);
    let result = h.finalize();
    let mut out = [0u8; ARGON2_SALT_LEN];
    out.copy_from_slice(&result[..ARGON2_SALT_LEN]);
    out
}

/// Drive Argon2id with `params` and produce a 32-byte output.
///
/// Maps `KdfParams::argon2_version` (`0x13` or `0x10`) onto
/// [`argon2::Version`]. Any other value, plus any error from the
/// underlying `argon2` crate, becomes [`ProtocolError::KdfFailure`].
fn argon2id_derive(
    password: &[u8],
    salt: &[u8; ARGON2_SALT_LEN],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; ARGON2_OUTPUT_LEN]>, ProtocolError> {
    let version = match params.argon2_version {
        0x13 => Version::V0x13,
        0x10 => Version::V0x10,
        _ => return Err(ProtocolError::KdfFailure),
    };
    let argon_params = Params::new(
        params.m_kib,
        params.t,
        params.p as u32,
        Some(ARGON2_OUTPUT_LEN),
    )
    .map_err(|_| ProtocolError::KdfFailure)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, version, argon_params);

    let mut output = Zeroizing::new([0u8; ARGON2_OUTPUT_LEN]);
    argon2
        .hash_password_into(password, salt, output.as_mut_slice())
        .map_err(|_| ProtocolError::KdfFailure)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phrase::recovery_phrase_from_fixed_entropy_for_test;

    /// Fast Argon2id parameters for unit tests. Default v0.1 baseline
    /// (256 MiB / t=3) takes 1–2 seconds per call; running every test
    /// at default would balloon the suite. m=8 KiB / t=1 / p=1 are
    /// the RFC 9106 minimum (`m >= 8*p`); compute time is microseconds.
    /// **Production NEVER uses these** — only `DEFAULT_V0_1_KDF_PARAMS`
    /// or stored vault.meta values reach `derive_*_wrap_key` at runtime.
    const FAST_TEST_KDF_PARAMS: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// Fixed test fixtures used across multiple tests so any drift in
    /// salt prefix, account binding, or random salt mixing surfaces
    /// as one of the golden tests failing.
    const FIXED_ACCOUNT_HASH: [u8; 16] = [
        0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99,
    ];
    const FIXED_SALT_RANDOM: [u8; 16] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10,
    ];
    const FIXED_PHRASE_ENTROPY: [u8; 32] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF, 0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED,
        0xFE, 0x0F,
    ];

    #[test]
    fn salt_prefixes_match_spec_verbatim() {
        // Spec § 3.1 — load-bearing identifiers (CLAUDE.md "Cryptographically
        // load-bearing identifiers"). Any drift silently invalidates every
        // vault on disk.
        assert_eq!(SALT_PREFIX_PASSWORD, b"myne.v0.1 argon2id-password|");
        assert_eq!(SALT_PREFIX_RECOVERY, b"myne.v0.1 argon2id-recovery|");
        assert_eq!(SALT_PREFIX_PASSWORD.len(), 28);
        assert_eq!(SALT_PREFIX_RECOVERY.len(), 28);
        // Both end in `|` — distinct from the HKDF prefix's trailing space
        // and the AAD prefix's tail.
        assert_eq!(SALT_PREFIX_PASSWORD[27], b'|');
        assert_eq!(SALT_PREFIX_RECOVERY[27], b'|');
    }

    #[test]
    fn password_and_recovery_salt_prefixes_share_head_and_tail() {
        // The two prefixes share the head `"myne.v0.1 argon2id-"` (19
        // bytes) and tail `|` (byte 27). The role bytes 19..27 are
        // `"password"` vs `"recovery"` — those differ as a whole, but
        // not every byte differs (e.g. byte 25 is `'r'` in both
        // `"password"` and `"recovery"`).
        for i in 0..19 {
            assert_eq!(
                SALT_PREFIX_PASSWORD[i], SALT_PREFIX_RECOVERY[i],
                "byte {i} should match"
            );
        }
        assert_eq!(SALT_PREFIX_PASSWORD[27], SALT_PREFIX_RECOVERY[27]);
        // The role region as a whole differs.
        assert_ne!(&SALT_PREFIX_PASSWORD[19..27], &SALT_PREFIX_RECOVERY[19..27]);
    }

    #[test]
    fn build_salt_password_path_pinned_hex() {
        // Hand-derived: SHA-256("myne.v0.1 argon2id-password|"
        //                || FIXED_ACCOUNT_HASH || FIXED_SALT_RANDOM)[:16].
        // First-run pinned value (regenerate by running this test).
        let salt = build_salt(
            SALT_PREFIX_PASSWORD,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let expected: [u8; ARGON2_SALT_LEN] = [
            0xDB, 0x7B, 0x00, 0x49, 0xE1, 0x88, 0xE5, 0xE6, 0x30, 0x0E, 0x30, 0xB9, 0x46, 0x03,
            0xD6, 0x4F,
        ];
        assert_eq!(salt, expected);
    }

    #[test]
    fn build_salt_recovery_path_pinned_hex() {
        let salt = build_salt(
            SALT_PREFIX_RECOVERY,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let expected: [u8; ARGON2_SALT_LEN] = [
            0x4A, 0x34, 0x59, 0x3D, 0x66, 0x6B, 0x70, 0xE9, 0x6E, 0x36, 0x8E, 0x3B, 0xD0, 0x86,
            0x5E, 0x21,
        ];
        assert_eq!(salt, expected);
    }

    #[test]
    fn password_and_recovery_salts_differ_for_same_inputs() {
        let pw_salt = build_salt(
            SALT_PREFIX_PASSWORD,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        let rec_salt = build_salt(
            SALT_PREFIX_RECOVERY,
            &FIXED_ACCOUNT_HASH,
            &FIXED_SALT_RANDOM,
        );
        assert_ne!(pw_salt, rec_salt);
    }

    #[test]
    fn derive_password_wrap_key_is_deterministic() {
        let a = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derives");
        let b = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derives");
        assert_eq!(*a, *b);
    }

    #[test]
    fn derive_password_wrap_key_pinned_hex() {
        // Pinned against fixed inputs + FAST_TEST_KDF_PARAMS. Not a
        // production-realistic value (uses test-fast m_kib=8); the goal
        // is to catch silent algorithm/encoding drift, not to assert
        // any cryptographic property of the derived key itself.
        let derived = derive_password_wrap_key(
            "correct horse battery staple",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let expected: [u8; 32] = [
            0x32, 0xCE, 0xD3, 0xC1, 0xED, 0xC4, 0x13, 0xEC, 0xFF, 0x6F, 0xF1, 0x1F, 0xD9, 0x2F,
            0xC2, 0x06, 0xC0, 0x2D, 0x29, 0x01, 0x7F, 0x94, 0x65, 0x82, 0x1E, 0x93, 0xC1, 0xFB,
            0xDB, 0x93, 0xFC, 0xE0,
        ];
        assert_eq!(*derived, expected);
    }

    #[test]
    fn derive_recovery_wrap_key_pinned_hex() {
        let phrase = recovery_phrase_from_fixed_entropy_for_test(&FIXED_PHRASE_ENTROPY);
        let derived = derive_recovery_wrap_key(
            &phrase,
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let expected: [u8; 32] = [
            0x7A, 0x65, 0xCE, 0x57, 0x3E, 0xD9, 0x44, 0xC7, 0x49, 0x8F, 0xD4, 0x58, 0x8F, 0x78,
            0xFC, 0x98, 0xD7, 0x9B, 0xEC, 0x5C, 0x1A, 0x1A, 0xC4, 0xA0, 0xB6, 0xD5, 0x21, 0x06,
            0xD8, 0x78, 0x6E, 0x76,
        ];
        assert_eq!(*derived, expected);
    }

    #[test]
    fn different_passwords_produce_different_wrap_keys() {
        let a = derive_password_wrap_key(
            "alpha",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b = derive_password_wrap_key(
            "bravo",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_account_hashes_produce_different_wrap_keys() {
        // Spec § 3.1: account_number_hash is mixed into the salt
        // precisely to prevent precomputation across accounts.
        let mut other_account = FIXED_ACCOUNT_HASH;
        other_account[0] ^= 0x01;
        let a = derive_password_wrap_key(
            "same password",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b = derive_password_wrap_key(
            "same password",
            &FIXED_SALT_RANDOM,
            &other_account,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_salt_random_produces_different_wrap_keys() {
        let mut other_salt = FIXED_SALT_RANDOM;
        other_salt[0] ^= 0x01;
        let a = derive_password_wrap_key(
            "p",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b =
            derive_password_wrap_key("p", &other_salt, &FIXED_ACCOUNT_HASH, &FAST_TEST_KDF_PARAMS)
                .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn different_kdf_params_produce_different_wrap_keys() {
        // Parameter binding: spec § 4.3 ensures that any change to the
        // stored Argon2id parameters yields a different output (which
        // then fails the AEAD tag check under the AAD-bound parameters).
        let mut other_params = FAST_TEST_KDF_PARAMS;
        other_params.t = 2;
        let a = derive_password_wrap_key(
            "p",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let b =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &other_params)
                .unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn password_and_recovery_paths_produce_different_keys_for_same_secret() {
        // Spec § 3.1 last paragraph: "the two distinct argon2id-password
        // / argon2id-recovery salt prefixes ensure the two Argon2id
        // outputs are domain-separated even if the same secret were
        // ever used for both (which it MUST NOT be)."
        let phrase = recovery_phrase_from_fixed_entropy_for_test(&FIXED_PHRASE_ENTROPY);
        let phrase_str = phrase.join_normalized();
        // Use the phrase string as a hypothetical password too — confirms
        // domain separation comes from the prefix, not the input bytes.
        let pw_key = derive_password_wrap_key(
            phrase_str.as_str(),
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        let rec_key = derive_recovery_wrap_key(
            &phrase,
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .unwrap();
        assert_ne!(*pw_key, *rec_key);
    }

    #[test]
    fn rejects_unsupported_argon2_version() {
        let mut bad_params = FAST_TEST_KDF_PARAMS;
        bad_params.argon2_version = 0xFF;
        let err =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &bad_params)
                .unwrap_err();
        assert_eq!(err, ProtocolError::KdfFailure);
    }

    #[test]
    fn rejects_invalid_argon2_params() {
        // Argon2 RFC 9106 requires m >= 8*p; m=4, p=1 violates this and
        // `Params::new` rejects. We map any error to KdfFailure.
        let bad_params = KdfParams {
            m_kib: 4, // below RFC 9106 minimum 8
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };
        let err =
            derive_password_wrap_key("p", &FIXED_SALT_RANDOM, &FIXED_ACCOUNT_HASH, &bad_params)
                .unwrap_err();
        assert_eq!(err, ProtocolError::KdfFailure);
    }
}
