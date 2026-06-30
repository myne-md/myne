//! Tauri-layer error type for the vault-recover plugin.
//!
//! Closed set; no `String` field reaches the frontend. TS hand-mirror
//! lives at `src/types/vault-recovery-error.ts`.
//!
//! Spec: `recovery-flow.md` §3.4 — `InvalidCredentialOrVault` is the
//! single non-distinguishing tag for AEAD-tag failure on the recovery
//! wrap-key (does NOT distinguish "wrong phrase" from "tampered
//! recovery section of vault.meta"). Variant name is shared with
//! `VaultUnlockError::InvalidCredentialOrVault` (distinct Rust types,
//! identical name + shape) per the recovery-error-discipline parallel
//! in `decisions.md`: variant encodes the error class; tracing stage
//! tag does call-site disambiguation.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// vault-recover plugin's commands.
///
/// Hand-mirrored on the TS side at `src/types/vault-recovery-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides in lockstep.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultRecoveryError {
    /// `vault.meta` does not exist at the expected path. Frontend
    /// routes to vault-creation flow rather than showing the recovery
    /// screen — the recovery flow is unreachable when no vault exists.
    #[error("vault not found")]
    VaultNotFound,

    /// AEAD-tag failure on the recovery wrap-key. **By design this
    /// single variant does NOT distinguish** "wrong phrase" from
    /// "tampered recovery section of vault.meta" per
    /// `recovery-flow.md` §3.4. Shared name with
    /// `VaultUnlockError::InvalidCredentialOrVault`.
    #[error("invalid credential or vault")]
    InvalidCredentialOrVault,

    /// `vault.meta` is structurally malformed (bad magic, wrong
    /// length, wrong protocol_version, invalid KDF block) OR the
    /// post-derivation `items_key` wrap blob fails AEAD verification
    /// after the recovery wrap-key has already verified. Both share a
    /// single user-facing CTA ("vault file is unreadable, restore from
    /// a backup"); the internal sub-stage is emitted via
    /// `tracing::error!(stage = "...")` for ops debugging only and
    /// MUST NOT cross the IPC boundary as a distinguisher.
    #[error("invalid vault.meta")]
    InvalidVaultMeta,

    /// File-system IO failure while reading `vault.meta`. The bounded
    /// [`IoFailureKind`] keeps OS error messages off the wire.
    #[error("io error")]
    IoError { io_error_kind: IoFailureKind },

    /// Another Argon2id-bound auth operation is in flight — the shared
    /// `auth_permits` Semaphore (capacity 1) is held. Reject, never
    /// queue (avoids silently linearizing multi-click DoS into N×Argon2id).
    /// Not user-facing: the frontend disables Submit during the in-flight
    /// window; if the user sees this, it indicates a UI-disable bug.
    #[error("recovery in progress")]
    RecoveryInProgress,

    /// The vault is already unlocked (`Slot::Unlocked`). Returned by
    /// the slot-peek guard when a recovery attempt arrives with a
    /// fully-unlocked vault.
    /// **Not user-facing**: frontend routes the user to the editor
    /// when the slot is `Unlocked`; if this surfaces from a recovery
    /// attempt, a router bug.
    #[error("vault already unlocked")]
    VaultAlreadyUnlocked,

    /// A previous recovery (A8d) succeeded but the chained password
    /// commit (A8f) has not run yet — the slot is `Slot::Recovering`.
    /// A fresh recovery attempt cannot start while the old one is
    /// pending its password commit per `recovery-flow.md` §4.1's
    /// "non-dismissible mandatory chained step" rule. The user must
    /// either complete the password reset (A8f) or `vault_lock` to
    /// abort.
    /// **Not user-facing**: frontend routes the user to the password-
    /// reset form when `vault_status` returns `Recovering`; if this
    /// surfaces from a recovery attempt, a router bug.
    #[error("recovery already in progress")]
    RecoveryAlreadyInProgress,

    /// `vault_complete_recovery` was invoked but the slot is not in
    /// `Slot::Recovering` — either no recovery has started or the
    /// vault is already fully unlocked. Post-recovery password commit
    /// can only run against an in-flight recovery session per
    /// `recovery-flow.md` §4.1. Not user-facing: frontend routes via
    /// `vault_status` and only invokes this when slot is Recovering.
    #[error("vault recovery requires active session")]
    VaultRecoveryRequiresActiveSession,

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing
    /// CTA is "try again" — recoverable banner, not a credential
    /// error.
    #[error("blocking task join failure")]
    JoinFailure,

    /// `vault_lock` (or another slot-dropping action) fired while
    /// `complete_recovery`'s Argon2id-bound derivation was running in
    /// `spawn_blocking`. The post-Argon2id slot peek (option p)
    /// detected `Slot::Recovering` had been dropped to `Slot::Empty`;
    /// the rewrite was bailed without touching `vault.meta` and the
    /// recovery material was zeroized when the slot dropped. The user
    /// must restart from A8d.
    ///
    /// Symmetric with `vault_change_password::commit`'s
    /// `VaultLockedDuringChange` (MYND-22 plugin tasks). The contract
    /// is **vacuous-by-affordance-absence today** — the recovery UI
    /// shows no Cancel during decrypting per `recovery-flow.md` §3.3,
    /// so the race cannot fire in normal flow — but the contract is
    /// in place if a Cancel affordance is ever added. See
    /// `decisions.md` 2026-05-06 entry "vault_complete_recovery
    /// post-Argon2id slot peek symmetric retrofit".
    ///
    /// Frontend UX: informational banner, "Recovery cancelled: vault
    /// was locked." — not a suspicion signal. User can restart
    /// recovery from the unlock screen.
    #[error("recovery aborted by lock")]
    RecoveryAbortedByLock,

    /// Backend min-length floor (`protocol::password_policy::MIN_PASSWORD_LEN`,
    /// currently 12 Unicode chars) rejected the new password chosen
    /// during the post-recovery password reset flow (A8f). The
    /// frontend `PasswordForm` already gates this; the backend is a
    /// structural belt+suspenders defense against a frontend bypass
    /// per `decisions.md` 2026-05-06 "Auth-pipeline backend
    /// MIN_PASSWORD_LEN floor; project-wide retroactive". Not an
    /// entropy guarantee.
    ///
    /// Cross-plugin shared variant name with
    /// `AppError::WeakNewPassword` (vault_creation) and the future
    /// `VaultPasswordChangeError::WeakNewPassword`. Distinct Rust
    /// types, identical JSON wire encoding `{"kind":"WeakNewPassword"}`.
    #[error("weak new password")]
    WeakNewPassword,
}

impl From<std::io::Error> for VaultRecoveryError {
    fn from(e: std::io::Error) -> Self {
        // NotFound is special-cased by the calling command (the
        // canonical missing-vault.meta case surfaces as `VaultNotFound`,
        // distinct from generic IO failures). This From impl handles
        // the residual case where an `io::Error` bubbles up after
        // that classification has already been made.
        VaultRecoveryError::IoError {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(e: &VaultRecoveryError) -> String {
        serde_json::to_string(e).expect("VaultRecoveryError must serialize cleanly")
    }

    #[test]
    fn vault_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::VaultNotFound),
            r#"{"kind":"VaultNotFound"}"#
        );
    }

    #[test]
    fn invalid_credential_or_vault_serializes_with_kind_tag() {
        // Wire shape MUST match `VaultUnlockError::InvalidCredentialOrVault`
        // — same `kind` tag, same absence of payload. This is the
        // shared-by-name discipline from `decisions.md` 2026-05-02
        // "Recovery error discipline parallels unlock".
        assert_eq!(
            serialize(&VaultRecoveryError::InvalidCredentialOrVault),
            r#"{"kind":"InvalidCredentialOrVault"}"#
        );
    }

    #[test]
    fn invalid_vault_meta_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::InvalidVaultMeta),
            r#"{"kind":"InvalidVaultMeta"}"#
        );
    }

    #[test]
    fn io_error_serializes_with_io_failure_kind_payload() {
        let e = VaultRecoveryError::IoError {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize(&e),
            r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn recovery_in_progress_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::RecoveryInProgress),
            r#"{"kind":"RecoveryInProgress"}"#
        );
    }

    #[test]
    fn vault_already_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::VaultAlreadyUnlocked),
            r#"{"kind":"VaultAlreadyUnlocked"}"#
        );
    }

    #[test]
    fn recovery_already_in_progress_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::RecoveryAlreadyInProgress),
            r#"{"kind":"RecoveryAlreadyInProgress"}"#
        );
    }

    #[test]
    fn vault_recovery_requires_active_session_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::VaultRecoveryRequiresActiveSession),
            r#"{"kind":"VaultRecoveryRequiresActiveSession"}"#
        );
    }

    #[test]
    fn join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    #[test]
    fn recovery_aborted_by_lock_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultRecoveryError::RecoveryAbortedByLock),
            r#"{"kind":"RecoveryAbortedByLock"}"#
        );
    }

    #[test]
    fn weak_new_password_serializes_with_kind_tag() {
        // Cross-plugin shared variant name with
        // `AppError::WeakNewPassword` (vault_creation) — both must
        // serialize to the same `{"kind":"WeakNewPassword"}` JSON for
        // the frontend to discriminate uniformly.
        assert_eq!(
            serialize(&VaultRecoveryError::WeakNewPassword),
            r#"{"kind":"WeakNewPassword"}"#
        );
    }

    /// Compile-time enforcement of "no `String` field on any variant".
    ///
    /// If a variant ever grows a `String` (or any non-closed) field,
    /// the unit-or-closed-payload pattern below stops matching and
    /// **this test fails to compile** — the entire point. Treat a
    /// compile failure here as a design red flag, not a test bug.
    #[test]
    fn all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &VaultRecoveryError) {
            match e {
                VaultRecoveryError::VaultNotFound => {}
                VaultRecoveryError::InvalidCredentialOrVault => {}
                VaultRecoveryError::InvalidVaultMeta => {}
                VaultRecoveryError::IoError { io_error_kind: _ } => {}
                VaultRecoveryError::RecoveryInProgress => {}
                VaultRecoveryError::VaultAlreadyUnlocked => {}
                VaultRecoveryError::RecoveryAlreadyInProgress => {}
                VaultRecoveryError::VaultRecoveryRequiresActiveSession => {}
                VaultRecoveryError::JoinFailure => {}
                VaultRecoveryError::RecoveryAbortedByLock => {}
                VaultRecoveryError::WeakNewPassword => {}
            }
        }
        assert_closed(&VaultRecoveryError::VaultNotFound);
    }

    #[test]
    fn from_io_error_maps_via_closed_enum() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: VaultRecoveryError = raw.into();
        match mapped {
            VaultRecoveryError::IoError { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected IoError variant, got {other:?}"),
        }
    }
}
