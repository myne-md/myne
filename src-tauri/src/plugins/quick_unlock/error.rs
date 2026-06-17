//! Tauri-layer error type for the quick-unlock plugin (MYND-329, task 6).
//!
//! Closed, `serde`-tagged set hand-mirrored on the TS side. No `String` field
//! reaches the frontend; provider/OS detail is reduced to coarse variants per
//! the secret-handling logging discipline (`../../CLAUDE.md`).

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

use super::provider::ProviderError;

/// Single error type returned across IPC by the quick-unlock plugin.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum QuickUnlockError {
    /// Setup requires the vault to be Unlocked (so `root_key` is in memory).
    #[error("vault is not unlocked")]
    NotUnlocked,
    /// No quick-unlock credential is configured for this vault.
    #[error("quick-unlock not configured")]
    NotConfigured,
    /// The spring-loaded gate is closed: no full-credential unlock has happened
    /// this session (e.g. just after an app restart), so quick-unlock is
    /// suppressed until the user unlocks once with the full master password.
    #[error("quick-unlock requires a full password unlock first this session")]
    RequiresFullPassword,
    /// The user dismissed the biometric prompt. Caller falls back to password.
    #[error("biometric prompt cancelled")]
    Cancelled,
    /// Biometric hardware / OS facility unavailable on this device.
    #[error("biometric hardware unavailable")]
    HardwareUnavailable,
    /// The PIN / biometric did not reproduce the wrap key — the blob did not
    /// decrypt. `remaining` attempts before the credential is wiped. Deliberately
    /// non-distinguishing (wrong PIN vs tampered blob).
    #[error("quick-unlock credential rejected")]
    WrongCredential {
        /// Attempts left before the credential is wiped.
        remaining: u32,
    },
    /// Too many consecutive failures — the credential was wiped; the user must
    /// use the full master password and re-set quick-unlock.
    #[error("quick-unlock attempts exhausted; credential wiped")]
    AttemptsExhausted,
    /// PIN shorter than the minimum at setup.
    #[error("PIN too short")]
    PinTooShort,
    /// PIN contained a non-digit character at setup.
    #[error("PIN must be digits only")]
    PinNotDigits,
    /// `vault.meta` could not be read or parsed.
    #[error("vault metadata invalid")]
    InvalidVaultMeta,
    /// Filesystem failure (bounded kind; no path string leaked).
    #[error("quick-unlock io failure")]
    Io(IoFailureKind),
    /// Opaque provider/codec backend failure (keychain API, CSPRNG, Argon2id).
    #[error("quick-unlock backend failure")]
    Backend,
}

impl From<ProviderError> for QuickUnlockError {
    fn from(e: ProviderError) -> Self {
        match e {
            ProviderError::UserCancelled => QuickUnlockError::Cancelled,
            ProviderError::HardwareUnavailable => QuickUnlockError::HardwareUnavailable,
            ProviderError::CredentialMissing => QuickUnlockError::NotConfigured,
            ProviderError::Backend => QuickUnlockError::Backend,
        }
    }
}
