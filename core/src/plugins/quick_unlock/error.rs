//! Tauri-layer error type for the quick-unlock plugin (MYND-329, task 6).
//!
//! Closed, `serde`-tagged set hand-mirrored on the TS side. No `String` field
//! reaches the frontend; provider/OS detail is reduced to coarse variants per
//! the secret-handling logging discipline (`../../AGENTS.md`).

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

use super::provider::ProviderError;

/// Single error type returned across IPC by the quick-unlock plugin.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum QuickUnlockError {
    /// Another auth-pipeline operation (`vault_unlock`, `vault_recover_*`,
    /// `vault_change_password`, `vault_delete`, `vault_repair`, a backup export)
    /// holds the capacity-1 `auth_permits` semaphore. `try_acquire` — reject,
    /// never queue, per the `decisions.md` 2026-05-02 single-in-flight posture.
    ///
    /// Shares the variant name with `VaultDeleteError::VaultBusyAuth` and
    /// `VaultRepairError::VaultBusyAuth`, which is this crate's name for exactly
    /// this condition. Frontend copy is "operation in progress", NEVER a
    /// credential failure: no attempt is burned here and the credential is
    /// intact.
    #[error("vault busy with auth operation")]
    VaultBusyAuth,

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
    /// The OS refused the biometric store with `errSecAuthFailed`, so a
    /// biometric credential could not be created. Most often no biometric is
    /// enrolled, but the status is broad, so the copy names the likely remedy
    /// rather than asserting the cause. Distinct from
    /// [`QuickUnlockError::HardwareUnavailable`] (this BUILD cannot use the
    /// facility at all). myne-md/myne#830.
    #[error("biometric authentication failed")]
    BiometricAuthFailed,
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
    /// `disable` could NOT remove the device-local credential file, so
    /// quick-unlock is STILL configured and the credential still unwraps the
    /// live `root_key`. Fail-closed: the caller surfaces this rather than
    /// reporting "turned off" over a file that remains on disk. Distinct from
    /// [`QuickUnlockError::Io`] because the user-facing advice differs — retry
    /// the toggle or check the vault directory's permissions, rather than the
    /// generic "io failure" copy — and because the frontend gate reads it to
    /// keep the toggle ON.
    #[error("quick-unlock credential could not be removed")]
    WipeFailed { io_error_kind: IoFailureKind },
    /// Opaque provider/codec backend failure (keychain API, CSPRNG, Argon2id).
    #[error("quick-unlock backend failure")]
    Backend,
}

impl From<ProviderError> for QuickUnlockError {
    fn from(e: ProviderError) -> Self {
        match e {
            ProviderError::UserCancelled => QuickUnlockError::Cancelled,
            ProviderError::HardwareUnavailable => QuickUnlockError::HardwareUnavailable,
            ProviderError::BiometricAuthFailed => QuickUnlockError::BiometricAuthFailed,
            ProviderError::CredentialMissing => QuickUnlockError::NotConfigured,
            ProviderError::Backend => QuickUnlockError::Backend,
        }
    }
}
