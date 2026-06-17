//! PIN wrap-key provider for quick-unlock (MYND-329, task 4).
//!
//! Derives the 32-byte `wrap_key` from a user PIN via the vault's existing
//! Argon2id parameters (`protocol::kdf::derive_quick_unlock_pin_wrap_key`,
//! salt prefix `"myne.v0.1 argon2id-quickunlock-pin|"`, § 9.14.2). The
//! memory-hard parameter set (m = 256 MiB baseline, drawn from `vault.meta`)
//! is what bounds offline brute-force of a low-entropy PIN. A minimum 6-digit
//! PIN is enforced host-side by [`validate_pin`] before any KDF work.
//!
//! Secret-handling discipline (see `../../CLAUDE.md`): the PIN is carried in
//! `Zeroizing<String>` and never logged; the derived `wrap_key` is
//! `Zeroizing<[u8; 32]>`.

use super::provider::{ProviderError, ProviderSecret, QuickUnlockProvider, WRAP_KEY_LEN};
use getrandom::getrandom;
use protocol::kdf::derive_quick_unlock_pin_wrap_key;
use protocol::quick_unlock_blob::{PROVIDER_KIND_PIN, QUICK_UNLOCK_PIN_SALT_LEN};
use protocol::types::KdfParams;
use zeroize::Zeroizing;

/// Minimum PIN length (decimal digits). 4 is too weak even behind a memory-hard
/// KDF; 6 is the floor (the research / design decision, MYND-329).
pub const MIN_PIN_LEN: usize = 6;

/// Why a candidate PIN was rejected at setup time. Distinct from
/// [`ProviderError`] — this is input validation, surfaced to the user as
/// guidance, not an opaque backend failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinValidationError {
    /// Fewer than [`MIN_PIN_LEN`] characters.
    TooShort,
    /// Contains a non-digit character (PINs are decimal digits only).
    NonDigit,
}

/// Validate a candidate PIN: at least [`MIN_PIN_LEN`] characters, all ASCII
/// decimal digits. Called by the setup command before constructing a
/// [`PinProvider`]; the unlock path does not re-validate (a wrong-length PIN
/// simply fails to reproduce the stored `wrap_key`).
pub fn validate_pin(pin: &str) -> Result<(), PinValidationError> {
    if pin.chars().count() < MIN_PIN_LEN {
        return Err(PinValidationError::TooShort);
    }
    if !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PinValidationError::NonDigit);
    }
    Ok(())
}

/// The PIN-backed [`QuickUnlockProvider`]. Holds the user's PIN + the vault's
/// account hash and Argon2id parameters for the lifetime of one setup/unlock
/// operation.
pub struct PinProvider {
    pin: Zeroizing<String>,
    account_number_hash: [u8; 16],
    params: KdfParams,
}

impl PinProvider {
    /// Construct a provider for one operation. `pin` should already have passed
    /// [`validate_pin`] at setup; `params` come from `vault.meta` (§ 4.2).
    pub fn new(pin: Zeroizing<String>, account_number_hash: [u8; 16], params: KdfParams) -> Self {
        Self {
            pin,
            account_number_hash,
            params,
        }
    }

    fn derive(
        &self,
        pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        protocol::validate_kdf_params(&self.params).map_err(|_| ProviderError::Backend)?;
        derive_quick_unlock_pin_wrap_key(
            self.pin.as_str(),
            pin_salt,
            &self.account_number_hash,
            &self.params,
        )
        .map_err(|_| ProviderError::Backend)
    }
}

impl QuickUnlockProvider for PinProvider {
    fn kind(&self) -> u8 {
        PROVIDER_KIND_PIN
    }

    fn create(&self) -> Result<ProviderSecret, ProviderError> {
        let mut pin_salt = [0u8; QUICK_UNLOCK_PIN_SALT_LEN];
        getrandom(&mut pin_salt).map_err(|_| ProviderError::Backend)?;
        let wrap_key = self.derive(&pin_salt)?;
        Ok(ProviderSecret { wrap_key, pin_salt })
    }

    fn retrieve(
        &self,
        pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        self.derive(pin_salt)
    }

    fn delete(&self) -> Result<(), ProviderError> {
        // The PIN provider stores no OS-side credential — the PIN itself is the
        // secret and lives only in the user's head. Wiping the blob (the
        // command layer's job) is the whole of invalidation.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::quick_unlock_blob::{decode_quick_unlock_blob, encode_quick_unlock_blob};

    const ACCOUNT_HASH: [u8; 16] = [0x5a; 16];
    const ROOT_KEY: [u8; 32] = [0x77; 32];

    // Fast Argon2id params for tests, pinned to the validate_kdf_params
    // memory floor so the PIN derive path's range gate accepts them (the
    // production 256 MiB set is too slow for a unit test).
    const FAST_PARAMS: KdfParams = KdfParams {
        m_kib: protocol::MIN_KDF_M_KIB,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    fn provider(pin: &str) -> PinProvider {
        PinProvider::new(Zeroizing::new(pin.to_string()), ACCOUNT_HASH, FAST_PARAMS)
    }

    #[test]
    fn validate_pin_enforces_min_six_digits() {
        assert_eq!(validate_pin("12345"), Err(PinValidationError::TooShort));
        assert_eq!(validate_pin("123456"), Ok(()));
        assert_eq!(validate_pin("1234567890"), Ok(()));
    }

    #[test]
    fn validate_pin_rejects_non_digits() {
        assert_eq!(validate_pin("12345a"), Err(PinValidationError::NonDigit));
        assert_eq!(validate_pin("abcdef"), Err(PinValidationError::NonDigit));
    }

    #[test]
    fn create_then_retrieve_round_trips_root_key_through_the_codec() {
        let p = provider("135790");
        let secret = p.create().expect("create");
        let blob = encode_quick_unlock_blob(
            &secret.wrap_key,
            &ACCOUNT_HASH,
            p.kind(),
            &secret.pin_salt,
            &ROOT_KEY,
        )
        .expect("encode");

        // A fresh provider (same PIN) re-derives the wrap_key from the stored salt.
        let unlock = provider("135790");
        let wrap_key = unlock.retrieve(&secret.pin_salt).expect("retrieve");
        let root_key = decode_quick_unlock_blob(&wrap_key, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(root_key.as_slice(), &ROOT_KEY);
    }

    #[test]
    fn wrong_pin_fails_to_unwrap() {
        let p = provider("135790");
        let secret = p.create().expect("create");
        let blob = encode_quick_unlock_blob(
            &secret.wrap_key,
            &ACCOUNT_HASH,
            p.kind(),
            &secret.pin_salt,
            &ROOT_KEY,
        )
        .expect("encode");

        // A different PIN derives a different wrap_key → AEAD fails.
        let wrong = provider("999999");
        let wrap_key = wrong.retrieve(&secret.pin_salt).expect("retrieve");
        assert!(decode_quick_unlock_blob(&wrap_key, &ACCOUNT_HASH, &blob).is_err());
    }

    #[test]
    fn kind_is_pin() {
        assert_eq!(provider("123456").kind(), PROVIDER_KIND_PIN);
    }

    #[test]
    fn delete_is_noop_ok() {
        assert_eq!(provider("123456").delete(), Ok(()));
    }
}
