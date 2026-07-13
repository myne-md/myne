//! Wrap-key providers for quick-unlock (MYND-329).
//!
//! The `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`) is
//! **provider-agnostic**: it is always `AEAD(wrap_key, root_key)`, and only the
//! source of the 32-byte `wrap_key` differs. [`QuickUnlockProvider`] is the
//! single seam every source plugs into (the KeePassXC "QuickUnlockProvider"
//! pattern): macOS Keychain biometric secret, a future Windows Hello / TPM
//! challenge-response, or a PIN run through the vault's Argon2id parameters.
//!
//! This module owns the trait + the test [`MockProvider`]. The concrete PIN
//! and Apple-biometric providers land in their own modules (`pin.rs`, `apple.rs`).
//!
//! Secret-handling discipline (see `../../CLAUDE.md`): `wrap_key` material is
//! always carried in `Zeroizing`; no provider ever logs a wrap key, PIN, or
//! `root_key`.

use protocol::quick_unlock_blob::QUICK_UNLOCK_PIN_SALT_LEN;
use zeroize::Zeroizing;

/// Length of the symmetric wrap key every provider produces (matches the AEAD
/// key length the `MYQ1` codec wraps `root_key` under).
pub const WRAP_KEY_LEN: usize = 32;

/// The output of [`QuickUnlockProvider::create`]: the freshly-minted `wrap_key`
/// plus the `pin_salt` to persist in the blob header (zero for providers that
/// do not use a salt, e.g. biometric).
pub struct ProviderSecret {
    /// The 32-byte symmetric wrap key, zeroized on drop.
    pub wrap_key: Zeroizing<[u8; WRAP_KEY_LEN]>,
    /// The salt written to the blob header; the PIN provider needs it at
    /// retrieve time to re-derive the same `wrap_key`. All-zero for biometric.
    pub pin_salt: [u8; QUICK_UNLOCK_PIN_SALT_LEN],
}

/// Failure modes common to all wrap-key providers. Deliberately coarse — the
/// command layer maps these onto user-facing outcomes (cancel → silent
/// fallback to password; missing/hardware → offer re-setup) without leaking OS
/// error detail (`../../CLAUDE.md` secret-handling logging discipline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    // `UserCancelled` / `HardwareUnavailable` / `CredentialMissing` are
    // constructed on macOS (the biometric provider + command branch) and by the
    // test `MockProvider`. On non-macOS lib builds (Linux/Windows CI) only
    // `HardwareUnavailable` is constructed, so the other two stay
    // `#[allow(dead_code)]` there; the allows are inert on macOS where the code
    // path constructs them.
    /// The user dismissed the biometric prompt. Caller falls back to password
    /// silently (not an error to surface loudly).
    #[allow(dead_code)]
    UserCancelled,
    /// The biometric hardware / OS facility is unavailable on this device.
    #[allow(dead_code)]
    HardwareUnavailable,
    /// The stored provider credential is gone (e.g. the keychain item was
    /// removed, or the biometric set changed and the OS invalidated it).
    #[allow(dead_code)]
    CredentialMissing,
    /// An opaque backend failure (keychain API error, Argon2id failure, CSPRNG
    /// unavailable). Detail is deliberately not carried across this boundary.
    Backend,
}

/// The pluggable source of a quick-unlock `wrap_key`. One implementation per
/// method (PIN, macOS biometric, future Windows Hello).
pub trait QuickUnlockProvider {
    /// The `provider_kind` byte this provider writes into / expects in the blob
    /// header (`protocol::quick_unlock_blob::PROVIDER_KIND_*`).
    fn kind(&self) -> u8;

    /// Mint a fresh `wrap_key` at setup time (vault is Unlocked). The biometric
    /// provider generates a random secret and stores it in the OS keychain; the
    /// PIN provider generates a random salt and derives the key from the PIN.
    fn create(&self) -> Result<ProviderSecret, ProviderError>;

    /// Recover the `wrap_key` at unlock time. The biometric provider reads the
    /// keychain (triggering the OS biometric prompt); the PIN provider
    /// re-derives from the PIN and the stored `pin_salt`.
    fn retrieve(
        &self,
        pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError>;

    /// Delete the provider's stored credential (keychain item) on invalidation
    /// (disable / password change / wipe). Idempotent: deleting an
    /// already-absent credential is `Ok(())`.
    fn delete(&self) -> Result<(), ProviderError>;
}

/// A deterministic in-memory provider for tests — lets the blob / plugin /
/// invalidation logic run end-to-end without real Touch ID or Argon2id.
/// `create`/`retrieve` return a fixed `wrap_key`; failure modes are injectable.
#[cfg(test)]
#[derive(Clone)]
pub struct MockProvider {
    kind: u8,
    wrap_key: [u8; WRAP_KEY_LEN],
    pin_salt: [u8; QUICK_UNLOCK_PIN_SALT_LEN],
    /// When set, `retrieve` returns this error instead of the key (simulates a
    /// cancelled prompt / missing credential).
    retrieve_error: Option<ProviderError>,
}

#[cfg(test)]
impl MockProvider {
    /// A mock with a fixed wrap key derived from `seed` and the given
    /// `provider_kind`. `retrieve` succeeds.
    pub fn new(kind: u8, seed: u8) -> Self {
        Self {
            kind,
            wrap_key: [seed; WRAP_KEY_LEN],
            pin_salt: [seed ^ 0xff; QUICK_UNLOCK_PIN_SALT_LEN],
            retrieve_error: None,
        }
    }

    /// A mock whose `retrieve` always fails with `error` (e.g. simulate a
    /// cancelled biometric prompt or a wiped credential).
    pub fn failing(kind: u8, error: ProviderError) -> Self {
        Self {
            kind,
            wrap_key: [0u8; WRAP_KEY_LEN],
            pin_salt: [0u8; QUICK_UNLOCK_PIN_SALT_LEN],
            retrieve_error: Some(error),
        }
    }
}

#[cfg(test)]
impl QuickUnlockProvider for MockProvider {
    fn kind(&self) -> u8 {
        self.kind
    }

    fn create(&self) -> Result<ProviderSecret, ProviderError> {
        Ok(ProviderSecret {
            wrap_key: Zeroizing::new(self.wrap_key),
            pin_salt: self.pin_salt,
        })
    }

    fn retrieve(
        &self,
        _pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        if let Some(err) = self.retrieve_error {
            return Err(err);
        }
        Ok(Zeroizing::new(self.wrap_key))
    }

    fn delete(&self) -> Result<(), ProviderError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::quick_unlock_blob::{
        decode_quick_unlock_blob, encode_quick_unlock_blob, PROVIDER_KIND_BIOMETRIC,
    };

    const ACCOUNT_HASH: [u8; 16] = [0x5a; 16];
    const ROOT_KEY: [u8; 32] = [0x77; 32];

    #[test]
    fn mock_create_retrieve_round_trips_through_the_codec() {
        // The provider mints a wrap_key; the codec wraps root_key under it; the
        // provider retrieves the same wrap_key; the codec unwraps root_key.
        let provider = MockProvider::new(PROVIDER_KIND_BIOMETRIC, 0x11);
        let secret = provider.create().expect("create");

        let blob = encode_quick_unlock_blob(
            &secret.wrap_key,
            &ACCOUNT_HASH,
            provider.kind(),
            &secret.pin_salt,
            &ROOT_KEY,
        )
        .expect("encode");

        let wrap_key = provider.retrieve(&secret.pin_salt).expect("retrieve");
        let root_key = decode_quick_unlock_blob(&wrap_key, &ACCOUNT_HASH, &blob).expect("decode");
        assert_eq!(root_key.as_slice(), &ROOT_KEY);
    }

    #[test]
    fn mock_kind_is_reported() {
        let provider = MockProvider::new(PROVIDER_KIND_BIOMETRIC, 0x01);
        assert_eq!(provider.kind(), PROVIDER_KIND_BIOMETRIC);
    }

    #[test]
    fn failing_provider_surfaces_the_injected_error() {
        let provider = MockProvider::failing(PROVIDER_KIND_BIOMETRIC, ProviderError::UserCancelled);
        assert_eq!(
            provider.retrieve(&[0u8; QUICK_UNLOCK_PIN_SALT_LEN]),
            Err(ProviderError::UserCancelled)
        );
    }

    #[test]
    fn delete_is_idempotent_ok() {
        let provider = MockProvider::new(PROVIDER_KIND_BIOMETRIC, 0x01);
        assert_eq!(provider.delete(), Ok(()));
        assert_eq!(provider.delete(), Ok(()));
    }
}
