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
