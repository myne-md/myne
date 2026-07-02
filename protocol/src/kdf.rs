// SPDX-License-Identifier: AGPL-3.0
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

/// Salt prefix for the PIN-derived quick-unlock wrap key
/// (spec § 9.14.2; 35 ASCII bytes, trailing pipe). DISTINCT from the password
/// and recovery prefixes so a PIN wrap key is domain-separated from the
/// credential wrap keys even if a user's PIN coincided with their password.
const SALT_PREFIX_QUICKUNLOCK_PIN: &[u8] = b"myne.v0.1 argon2id-quickunlock-pin|";

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
/// copy of `root_key` (spec § 3.1) from a structured [`RecoveryPhrase`].
///
/// Internally calls `phrase.join_normalized()` to obtain the spec § 7.4
/// `phrase_normalized` form — single-space-joined ASCII-lowercase BIP-39
/// words — then delegates to
/// [`derive_recovery_wrap_key_from_normalized`]. Used at vault-creation
/// time when the phrase has been freshly generated (and therefore
/// already conforms to the canonical normalized form by construction).
///
/// Salt construction uses the recovery prefix
/// `"myne.v0.1 argon2id-recovery|"` (distinct from the password
/// prefix).
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as [`derive_password_wrap_key`]).
pub fn derive_recovery_wrap_key(
    phrase: &RecoveryPhrase,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let phrase_normalized = phrase.join_normalized();
    derive_recovery_wrap_key_from_normalized(
        phrase_normalized.as_str(),
        salt_random,
        account_number_hash,
        params,
    )
}

/// Derive the 32-byte AEAD wrap key for the recovery-phrase-protected
/// copy of `root_key` (spec § 3.1) directly from the
/// `phrase_normalized` byte string.
///
/// Used by the **recovery-time** flow (`vault_recover_with_phrase` in
/// `src-tauri/src/plugins/vault_recover/`) where the phrase comes from
/// raw user input that has been normalized via
/// [`crate::phrase::normalize_user_phrase`] (NFKD + ASCII lowercase +
/// trim + whitespace coalesce per spec § 7.4). The function deliberately
/// **does not validate** against the BIP-39 wordlist — invalid phrases
/// produce a wrap key that fails AEAD-tag verification on
/// `enc_root_key_recovery`, surfacing the single non-distinguishing
/// error per `recovery-flow.md` § 3.4. Wordlist validation here would
/// leak BIP-39 membership through error timing or class.
///
/// Salt construction is identical to [`derive_recovery_wrap_key`]; the
/// two functions are byte-equivalent given byte-equivalent normalized
/// input.
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same
/// discipline as [`derive_password_wrap_key`]).
pub fn derive_recovery_wrap_key_from_normalized(
    phrase_normalized: &str,
    salt_random: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_RECOVERY, account_number_hash, salt_random);
    argon2id_derive(phrase_normalized.as_bytes(), &salt, params)
}

/// Derive the 32-byte AEAD wrap key for the **PIN-protected quick-unlock copy**
/// of `root_key` (spec § 9.14.2).
///
/// Salt = SHA-256(`"myne.v0.1 argon2id-quickunlock-pin|"` || `account_number_hash`
/// || `pin_salt`)[:16]. Argon2id runs with `params` — the **same** memory-hard
/// parameter set the vault uses for the master password (drawn from `vault.meta`
/// § 4.2): the memory-hardness is what makes a low-entropy PIN costly to
/// brute-force offline. `pin` is the user's PIN as UTF-8 bytes (the host layer
/// enforces a minimum length before calling this); the distinct salt prefix
/// domain-separates it from [`derive_password_wrap_key`].
///
/// Returns [`ProtocolError::KdfFailure`] on Argon2id error (same discipline as
/// [`derive_password_wrap_key`]).
pub fn derive_quick_unlock_pin_wrap_key(
    pin: &str,
    pin_salt: &[u8; 16],
    account_number_hash: &[u8; 16],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; 32]>, ProtocolError> {
    let salt = build_salt(SALT_PREFIX_QUICKUNLOCK_PIN, account_number_hash, pin_salt);
    argon2id_derive(pin.as_bytes(), &salt, params)
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
/// Maps `KdfParams::argon2_version` (`0x13` only) onto
/// [`argon2::Version`]. Any other value — including the rejected Argon2
/// v1.0 (`0x10`) per spec §9.3 — plus any error from the underlying
/// `argon2` crate, becomes [`ProtocolError::KdfFailure`].
fn argon2id_derive(
    password: &[u8],
    salt: &[u8; ARGON2_SALT_LEN],
    params: &KdfParams,
) -> Result<Zeroizing<[u8; ARGON2_OUTPUT_LEN]>, ProtocolError> {
    let version = match params.argon2_version {
        0x13 => Version::V0x13,
        // v1.0 (0x10) and everything else is rejected — the on-disk parser
        // (`parse_kdf_params`) already gates argon2_version to 0x13, so a
        // 0x10 arm here was unreachable dead code (spec §9.3 rejects v1.0).
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
#[cfg_attr(coverage_nightly, coverage(off))]
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
    fn quick_unlock_pin_wrap_key_is_deterministic() {
        let a = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derive a");
        let b = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("derive b");
        assert_eq!(a.as_slice(), b.as_slice());
    }

    #[test]
    fn quick_unlock_pin_wrap_key_is_domain_separated_from_password() {
        // The same secret + salt + account hash produce DIFFERENT keys for the
        // PIN quick-unlock domain vs the password domain — the distinct salt
        // prefix (`argon2id-quickunlock-pin|` vs `argon2id-password|`) is what
        // guarantees this even if a user's PIN equalled their password.
        let pin_key = derive_quick_unlock_pin_wrap_key(
            "secret",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("pin key");
        let password_key = derive_password_wrap_key(
            "secret",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("password key");
        assert_ne!(pin_key.as_slice(), password_key.as_slice());
    }

    #[test]
    fn quick_unlock_pin_wrap_key_varies_with_salt() {
        let a = derive_quick_unlock_pin_wrap_key(
            "123456",
            &FIXED_SALT_RANDOM,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("a");
        let mut other_salt = FIXED_SALT_RANDOM;
        other_salt[0] ^= 0x01;
        let b = derive_quick_unlock_pin_wrap_key(
            "123456",
            &other_salt,
            &FIXED_ACCOUNT_HASH,
            &FAST_TEST_KDF_PARAMS,
        )
        .expect("b");
        assert_ne!(a.as_slice(), b.as_slice());
    }

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

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/argon2id/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_argon2id_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act —
    /// AND because regenerating at canonical params takes ~21 seconds
    /// (7 cases × ~3s per Argon2id derivation at m=256 MiB, t=3, p=2).
    /// The shipped vectors run as part of default `cargo test` (NOT
    /// `#[ignore]`-gated on the runner side) because they are
    /// protocol-contract assertions; only the regenerator is gated.
    ///
    /// 7 cases pin (per MYND-69 / D4; + the MYND-329 quickunlock-pin path):
    /// - 3 password-path × {short ASCII, long ASCII, raw unicode}
    /// - 3 recovery-path × {short ASCII, long ASCII, NFKD unicode}
    /// - 1 quickunlock-pin path (§9.14.2 PIN → wrap key)
    ///
    /// All cases use the canonical Phase 1 Argon2id parameters
    /// (`m_kib=262144, t=3, p=2, argon2_version=0x13`) — the v0.1
    /// baseline. Future v0.1.x mobile-profile vectors would land in
    /// a separate sub-directory with their own KdfParams; not this
    /// category's scope.
    #[test]
    #[ignore]
    fn emit_argon2id_wrap_vectors_for_paste() {
        extern crate std;
        use crate::types::DEFAULT_V0_1_KDF_PARAMS;
        use unicode_normalization::UnicodeNormalization;

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

        // Canonical Phase 1 params. DEFAULT_V0_1_KDF_PARAMS exposed via
        // crate::types — same constant the production code uses.
        let canonical_params = DEFAULT_V0_1_KDF_PARAMS;

        // Distinct fixed inputs across cases — same salt + account hash
        // every case so byte-level differences trace to (path × input).
        let salt_random: [u8; 16] = [0xEF; 16];
        let account_number_hash: [u8; 16] = [0x42; 16];

        // Password-path inputs (raw — no normalization by Myne).
        let pw_short = b"new-pw".to_vec();
        let pw_long = b"a-deliberately-long-passphrase-with-many-characters".to_vec();
        // Raw unicode password: "şifre-ñ" in NFC form. Bytes:
        // 0xC5 0x9F (ş) 0x69 (i) 0x66 (f) 0x72 (r) 0x65 (e) 0x2D (-) 0xC3 0xB1 (ñ)
        let pw_unicode = "şifre-ñ".as_bytes().to_vec();

        // Recovery-path inputs (caller MUST pre-normalize per spec §3.4
        // — we pass strings that ARE in NFKD form).
        let rec_short = b"abandon abandon abandon".to_vec();
        let rec_long =
            b"abandon abandon abandon abandon abandon abandon abandon abandon abandon".to_vec();
        // NFKD decomposition of "şifre-ñ":
        //   "ş" → "s" (0x73) + COMBINING CEDILLA (U+0327 = 0xCC 0xA7)
        //   "ifre-" → ASCII bytes
        //   "ñ" → "n" (0x6E) + COMBINING TILDE (U+0303 = 0xCC 0x83)
        // Total 11 UTF-8 bytes (vs 9 in NFC).
        let rec_unicode = "şifre-ñ"
            .nfkd()
            .collect::<alloc::string::String>()
            .into_bytes();

        // Derive all 6 wrap keys. ~3s each at canonical params; total ~18s.
        let pw_short_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_short).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password short");
        let pw_long_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_long).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password long");
        let pw_unicode_key = derive_password_wrap_key(
            core::str::from_utf8(&pw_unicode).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive password unicode");
        let rec_short_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_short).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery short");
        let rec_long_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_long).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery long");
        let rec_unicode_key = derive_recovery_wrap_key_from_normalized(
            core::str::from_utf8(&rec_unicode).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive recovery unicode");

        // quickunlock-pin path (§9.14.2): the PIN run through Argon2id with the
        // distinct salt-domain prefix "myne.v0.1 argon2id-quickunlock-pin|". The
        // 16-byte pin_salt plays the salt_random role in build_salt, so it is
        // carried in the shared `input_salt_random_hex` field. ~3s at canonical
        // params (the memory-hardness is what makes a low-entropy PIN costly to
        // brute-force offline). 6-digit PIN — the host enforces MIN_PIN_LEN.
        let pin = b"246813".to_vec();
        let pin_key = derive_quick_unlock_pin_wrap_key(
            core::str::from_utf8(&pin).unwrap(),
            &salt_random,
            &account_number_hash,
            &canonical_params,
        )
        .expect("derive quickunlock pin");

        let salt_hex = hex_lower(&salt_random);
        let acct_hex = hex_lower(&account_number_hash);

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"argon2id\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3 + §4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_password_wrap_key + protocol::derive_recovery_wrap_key_from_normalized + protocol::derive_quick_unlock_pin_wrap_key byte mapping under canonical Phase 1 Argon2id parameters (m=256 MiB, t=3, p=2, v=0x13). 7 cases: password × {short, long, unicode} + recovery × {short, long, NFKD-unicode} + quickunlock-pin (§9.14.2). The three paths share an Argon2id core but use distinct salt-domain prefixes (argon2id-password| / argon2id-recovery| / argon2id-quickunlock-pin|), so identical input bytes derive different keys per path. EXPECTED RUNTIME: ~21s total (~3s per case at canonical params). Default-on in `cargo test`; only the regenerator is `#[ignore]`-gated. Cases generated by `cargo test -p protocol --lib emit_argon2id_wrap_vectors_for_paste -- --ignored` (in protocol/src/kdf.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // Helper emit closure.
        let emit_case = |dump: &mut alloc::string::String,
                         slug: &str,
                         description: &str,
                         path: &str,
                         password_or_phrase: &[u8],
                         wrap_key: &[u8],
                         trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"argon2id/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!("      \"input_path\": \"{}\",\n", path));
            dump.push_str(&alloc::format!(
                "      \"input_password_or_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(password_or_phrase)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_salt_random_hex\": \"{}\",\n",
                salt_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                acct_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
                canonical_params.m_kib,
                canonical_params.t,
                canonical_params.p,
                canonical_params.argon2_version
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_wrap_key_hex\": \"{}\"\n",
                hex_lower(wrap_key)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        emit_case(
            &mut dump,
            "password-short",
            "Password-path derivation with 6-byte ASCII password ('new-pw'). Smallest representative password — exercises the Argon2id derive at canonical params with minimal input length.",
            "password",
            &pw_short,
            &*pw_short_key,
            true,
        );
        emit_case(
            &mut dump,
            "password-long",
            "Password-path derivation with 51-byte ASCII passphrase. Mid-length representative case; password length does not affect Argon2id memory cost (input is absorbed into the BLAKE2b state regardless), so timing is identical to other cases.",
            "password",
            &pw_long,
            &*pw_long_key,
            true,
        );
        emit_case(
            &mut dump,
            "password-unicode",
            "Password-path derivation with raw NFC unicode bytes ('şifre-ñ' = 9 UTF-8 bytes). Myne does NOT normalize passwords on the client side — the bytes the user types are the bytes fed to Argon2id. This case pins the cross-impl byte mapping for non-ASCII passwords.",
            "password",
            &pw_unicode,
            &*pw_unicode_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-short",
            "Recovery-path derivation with 3-word abandon phrase (NFKD-normalized — caller MUST normalize before invoking derive_recovery_wrap_key_from_normalized per spec §3.4). Smallest valid input.",
            "recovery",
            &rec_short,
            &*rec_short_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-long",
            "Recovery-path derivation with 9-word abandon phrase. Longer NFKD input — same Argon2id memory cost; cross-impl byte mapping pinned at a representative full-length recovery phrase footprint.",
            "recovery",
            &rec_long,
            &*rec_long_key,
            true,
        );
        emit_case(
            &mut dump,
            "recovery-nfkd-unicode",
            "Recovery-path derivation with NFKD-decomposed unicode bytes (11 UTF-8 bytes representing 'şifre-ñ' decomposed via NFKD: 's' + COMBINING CEDILLA U+0327 + 'ifre-' + 'n' + COMBINING TILDE U+0303). Demonstrates the NFKD-output bytes are what reach Argon2id — implementations that skip the NFKD normalization step would feed different bytes (e.g., NFC form 0xC5 0x9F instead of 0x73 0xCC 0xA7 for 'ş') and produce a different wrap key.",
            "recovery",
            &rec_unicode,
            &*rec_unicode_key,
            true,
        );
        emit_case(
            &mut dump,
            "quickunlock-pin",
            "Quick-unlock PIN-path derivation (§9.14.2). The PIN ('246813' = 6 ASCII digits) is fed to Argon2id with salt = SHA-256('myne.v0.1 argon2id-quickunlock-pin|' || account_number_hash || pin_salt)[:16] — a DISTINCT salt-domain prefix from the password path ('myne.v0.1 argon2id-password|'), so the same input bytes + salt_random + account_hash under a different path produce a different wrap key (domain separation). The wrap key returned here is what the MYQ1 vault.quickunlock codec consumes DIRECTLY (see the vault-quickunlock category — the codec never runs Argon2id itself). NOTE: for this path the shared input_salt_random_hex field carries the 16-byte pin_salt.",
            "quickunlock-pin",
            &pin,
            &*pin_key,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_argon2id_vectors.json", dump.as_bytes())
            .expect("write argon2id vectors dump");
    }

    /// Vector generator for the `bip39-recovery` companion category.
    /// `#[ignore]`-gated — emits ready-to-copy JSON to
    /// `/tmp/myne_bip39_recovery_vectors.json`. Composes
    /// [`crate::phrase::normalize_user_phrase`] (§7.4) →
    /// [`derive_recovery_wrap_key_from_normalized`] (§3.1) end-to-end: a
    /// raw user-typed 24-word phrase is normalized, then fed **directly**
    /// to Argon2id (NOT through BIP-39's PBKDF2 step). The three cases
    /// type the SAME 24 words three ways (canonical / mixed-case+messy
    /// whitespace / NFKD-foldable full-width + exotic whitespace) and the
    /// generator asserts all three normalize identically and derive the
    /// SAME wrap key — pinning the NFKD-before-Argon2id ordering. ~3s per
    /// case at canonical params.
    #[test]
    #[ignore = "vector generator — run explicitly to refresh bip39-recovery cases.json"]
    fn emit_bip39_recovery_vectors_for_paste() {
        extern crate std;
        use crate::phrase::normalize_user_phrase;
        use crate::types::DEFAULT_V0_1_KDF_PARAMS;
        use alloc::string::String;
        use alloc::vec::Vec;

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
        // Distinct from the argon2id category's fixtures so a key collision
        // across categories can never mask a bug.
        let salt_random: [u8; 16] = [0x5A; 16];
        let account_number_hash: [u8; 16] = [0xA5; 16];

        // The canonical BIP-39 all-zero-entropy 24-word phrase: 23×abandon
        // + the checksum word `art`. Already in normalized form (lowercase,
        // single ASCII spaces, trimmed).
        let mut words: Vec<&str> = alloc::vec!["abandon"; 23];
        words.push("art");
        let canonical: String = words.join(" ");

        // Variant 2: same 24 words, UPPERCASED, with leading/trailing pad
        // and irregular interior whitespace (double space + tab). Exercises
        // ASCII-lowercase + whitespace-coalesce + trim.
        let messy: String = alloc::format!(
            "   {}   ",
            words
                .iter()
                .map(|w| w.to_uppercase())
                .collect::<Vec<_>>()
                .join("  \t ")
        );

        // Variant 3: same 24 words, but the last word `art` typed in
        // full-width Latin (U+FF41 U+FF52 U+FF54) and two separators using
        // a no-break space (U+00A0) and an ideographic space (U+3000).
        // NFKD folds full-width letters → ASCII and both exotic spaces →
        // regular space. Pins NFKD-before-Argon2id: a port that skips NFKD
        // feeds different bytes and derives a different key.
        let nfkd_raw: String = alloc::format!(
            "{}\u{00A0}{}\u{3000}{}",
            words[..22].join(" "),
            words[22],
            "\u{FF41}\u{FF52}\u{FF54}"
        );

        // Normalize each, assert all three collapse to the canonical form.
        let norm_canonical = normalize_user_phrase(&canonical);
        let norm_messy = normalize_user_phrase(&messy);
        let norm_nfkd = normalize_user_phrase(&nfkd_raw);
        assert_eq!(
            norm_canonical.as_str(),
            canonical.as_str(),
            "canonical input must be a fixed point of normalize_user_phrase"
        );
        assert_eq!(
            norm_messy.as_str(),
            canonical.as_str(),
            "messy variant must normalize to the canonical phrase"
        );
        assert_eq!(
            norm_nfkd.as_str(),
            canonical.as_str(),
            "NFKD variant must normalize to the canonical phrase"
        );

        // Derive a wrap key per case (the full §3.1 recovery composition).
        let derive = |normalized: &str| {
            derive_recovery_wrap_key_from_normalized(
                normalized,
                &salt_random,
                &account_number_hash,
                &params,
            )
            .expect("derive recovery wrap key")
        };
        let key_canonical = derive(norm_canonical.as_str());
        let key_messy = derive(norm_messy.as_str());
        let key_nfkd = derive(norm_nfkd.as_str());
        // The whole point: three different raw inputs, one wrap key.
        assert_eq!(&*key_messy, &*key_canonical, "messy must derive same key");
        assert_eq!(&*key_nfkd, &*key_canonical, "NFKD must derive same key");

        let salt_hex = hex_lower(&salt_random);
        let acct_hex = hex_lower(&account_number_hash);

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"bip39-recovery\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.1 + §7.4\",\n");
        dump.push_str("  \"description\": \"Pins the end-to-end recovery composition protocol::phrase::normalize_user_phrase (§7.4) -> protocol::derive_recovery_wrap_key_from_normalized (§3.1): a raw user-typed 24-word phrase is NFKD-normalized then fed DIRECTLY to Argon2id (NOT BIP-39's PBKDF2 step). 3 cases type the SAME 24 words three ways (canonical / mixed-case+messy-whitespace / NFKD-foldable full-width+exotic-whitespace); all three MUST derive the identical wrap key, pinning the NFKD-before-Argon2id ordering. EXPECTED RUNTIME: ~9s total (~3s per case at canonical params m=256 MiB, t=3, p=2). Default-on in `cargo test`; only the regenerator is `#[ignore]`-gated. Cases generated by `cargo test -p protocol --lib emit_bip39_recovery_vectors_for_paste -- --ignored` (in protocol/src/kdf.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_case = |dump: &mut String,
                         slug: &str,
                         description: &str,
                         raw_phrase: &str,
                         normalized: &str,
                         wrap_key: &[u8],
                         trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"bip39-recovery/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_raw_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(raw_phrase.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_salt_random_hex\": \"{}\",\n",
                salt_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                acct_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
                params.m_kib, params.t, params.p, params.argon2_version
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_normalized_phrase_utf8_hex\": \"{}\",\n",
                hex_lower(normalized.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_recovery_wrap_key_hex\": \"{}\"\n",
                hex_lower(wrap_key)
            ));
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "canonical-24w",
            "The canonical BIP-39 all-zero-entropy 24-word phrase (23x abandon + checksum word 'art'), typed already in normalized form (lowercase, single ASCII spaces, no padding). Baseline: normalize_user_phrase is a fixed point here, so this pins the recovery_wrap_key for the canonical normalized string fed straight to Argon2id.",
            &canonical,
            norm_canonical.as_str(),
            &*key_canonical,
            true,
        );
        emit_case(
            &mut dump,
            "messy-case-whitespace-24w",
            "The SAME 24 words, fully UPPERCASED, with leading/trailing whitespace padding and irregular interior whitespace (double space + tab between every word). normalize_user_phrase ASCII-lowercases, coalesces whitespace runs to a single U+0020, and trims — yielding the identical normalized string as the canonical case, hence the IDENTICAL wrap key. Pins that case-folding + whitespace normalization happen BEFORE Argon2id.",
            &messy,
            norm_messy.as_str(),
            &*key_messy,
            true,
        );
        emit_case(
            &mut dump,
            "nfkd-fullwidth-24w",
            "The SAME 24 words, but the checksum word 'art' typed in full-width Latin (U+FF41 U+FF52 U+FF54) and two word separators replaced by a no-break space (U+00A0) and an ideographic space (U+3000). NFKD compatibility-decomposition folds the full-width letters to ASCII and both exotic spaces to regular spaces; the result normalizes to the canonical phrase and derives the IDENTICAL wrap key. Pins NFKD-before-Argon2id: a port that skips the NFKD pass would feed the raw full-width/NBSP bytes to Argon2id and derive a DIFFERENT (wrong) key.",
            &nfkd_raw,
            norm_nfkd.as_str(),
            &*key_nfkd,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_bip39_recovery_vectors.json", dump.as_bytes())
            .expect("write bip39-recovery vectors dump");
    }
}
