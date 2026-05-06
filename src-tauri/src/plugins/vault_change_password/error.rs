//! Tauri-layer error type for the `vault-change-password` plugin.
//!
//! Closed set; no `String` field reaches the frontend. TS hand-mirror
//! lives at `src/types/vault-change-password-error.ts`.
//!
//! Variant naming follows the cross-plugin shared-name discipline
//! pinned by `decisions.md` 2026-05-02 "Recovery error discipline
//! parallels unlock; InvalidCredentialOrVault shared by name across
//! plugins" and the project-wide "naming-discipline >
//! scenario-optimization" rule from MYND-22 grilling Q6:
//! `InvalidCredentialOrVault`, `InvalidVaultMeta`, and `WeakNewPassword`
//! share their **names** (and JSON wire encodings) with the same
//! variants on `VaultUnlockError`, `VaultRecoveryError`, and (where
//! applicable) `AppError`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// `vault-change-password` plugin's `change_password` command.
///
/// Hand-mirrored on the TS side at
/// `src/types/vault-change-password-error.ts`. Variant set is closed;
/// adding a variant is an IPC contract change that requires updating
/// both sides in lockstep.
///
/// Wire shape: `#[serde(tag = "kind", content = "detail")]`. Unit
/// variants serialize as `{"kind":"<Variant>"}`; `IoError` carries a
/// closed `IoFailureKind` payload.
///
/// **`#[allow(dead_code)]`** because Task 7 (scaffolding) lands the
/// enum but no production code path constructs the variants yet —
/// the pipeline body (Tasks 8–13) will exercise each variant in turn.
/// JSON wire tests in this module exercise all variants under
/// `#[cfg(test)]`. Pattern parallels `vault_unlock::state::UnlockedVault`'s
/// `#[allow(dead_code)]` for the same reason (forward-defined types
/// with deferred consumer landing).
#[allow(dead_code)]
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultChangePasswordError {
    /// AEAD-tag failure on the **current** password's wrap-key during
    /// the re-auth step (MYND-22 grilling Q2 — current-password proof
    /// = AEAD-tag-verify success). **By design this single variant
    /// does NOT distinguish** "wrong current password" from "tampered
    /// password section of vault.meta", per `protocol.md` §7.3 +
    /// `decisions.md` 2026-05-02 "Phase 1 unlock error discipline".
    /// Shared variant name with `VaultUnlockError::InvalidCredentialOrVault`
    /// and `VaultRecoveryError::InvalidCredentialOrVault` (distinct
    /// Rust types, identical name + JSON wire encoding).
    ///
    /// Frontend UX: LITERAL compound `"Yanlış mevcut parola veya
    /// vault dosyası bozuk."` (`decisions.md` 2026-05-06 entry pinned
    /// alongside this variant's introduction).
    #[error("invalid credential or vault")]
    InvalidCredentialOrVault,

    /// `vault.meta` is structurally malformed (bad magic, wrong
    /// length, wrong protocol_version, invalid KDF block) OR the
    /// post-derivation `items_key` wrap blob fails AEAD verification
    /// (MYND-22 grilling Q6(b) — InvalidVaultMeta posture: force-
    /// relock + dedicated screen, parallel to vault_unlock). Both
    /// share a single user-facing CTA "Vault file is unreadable.
    /// Restore from a backup." — internal sub-stage emitted via
    /// `tracing::error!(stage = "...")` for ops debugging only and
    /// MUST NOT cross the IPC boundary as a distinguisher.
    ///
    /// Force-relock on this path: slot drops to `Empty` so the user
    /// is routed to the dedicated `<InvalidVaultMetaScreen />`.
    #[error("invalid vault.meta")]
    InvalidVaultMeta,

    /// Compare-and-swap mismatch between the `Slot::Unlocked.vault_meta_bytes_hash`
    /// captured at unlock time and the SHA-256 of the on-disk
    /// `vault.meta` re-read just before the rewrite. Indicates an
    /// external mutation — typically a parallel app instance committed
    /// a competing rewrite (e.g. `vault_complete_recovery` from a
    /// second process); could also indicate disk-level tampering.
    /// Detected by MYND-22 grilling Q1's CAS layer at both memory and
    /// file levels; force-relocks the session per Q3 (slot drops to
    /// `Empty`).
    ///
    /// Frontend UX: SUSPICION signal banner, `"Vault başka bir
    /// oturumda değişti — yeniden açın."` Distinct from
    /// [`VaultLockedDuringChange`] (informational) — both drop the
    /// slot but carry different UX bandwidth.
    #[error("vault meta changed externally")]
    VaultMetaChangedExternally,

    /// `vault_lock` (or another slot-dropping action) fired while the
    /// `commit` command's Argon2id-bound derivation was running in
    /// `spawn_blocking`. The post-Argon2id slot peek (option p,
    /// MYND-22 Q4) detected `Slot::Unlocked` had been dropped to
    /// `Slot::Empty`; the rewrite was bailed without touching
    /// `vault.meta`.
    ///
    /// Symmetric with `VaultRecoveryError::RecoveryAbortedByLock`
    /// (which is vacuous-by-affordance-absence today; this one is
    /// structurally reachable because Cmd+L is accessible from the
    /// Settings screen while `Slot::Unlocked`).
    ///
    /// Frontend UX: INFORMATIONAL banner, `"Şifre değişikliği iptal
    /// edildi: kilit atıldı."` — not a suspicion signal; user can
    /// just re-unlock with their CURRENT (unchanged) password.
    #[error("vault locked during change")]
    VaultLockedDuringChange,

    /// Another Argon2id-bound auth operation is in flight — the
    /// shared `auth_permits` Semaphore (capacity 1) is held by either
    /// `vault_unlock`, `vault_recover_with_phrase`,
    /// `vault_complete_recovery`, or this command's own duplicate
    /// submit. Reject, never queue (avoids silently linearizing
    /// multi-click DoS into N×Argon2id per `decisions.md` 2026-05-02
    /// "Slot state machine + auth_permits generalization"). Not
    /// user-facing: the Settings UI disables Submit during the
    /// in-flight window; if the user sees this, it indicates a UI-
    /// disable bug.
    #[error("change password in progress")]
    ChangePasswordInProgress,

    /// The slot is not `Slot::Unlocked` — either no vault is unlocked
    /// (`Slot::Empty`) or a recovery is mid-flight (`Slot::Recovering`).
    /// Password change requires an unlocked vault per the MYND-22
    /// PRD's Implementation Decisions ("Re-auth on credential change").
    ///
    /// Not user-facing: the Settings UI is unreachable when the slot
    /// is not `Unlocked`; if this surfaces, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// User typed a new password identical to the current password
    /// (compared as raw UTF-8 bytes BEFORE Argon2id). Pre-Argon2id
    /// reject saves 2× Argon2id cost and avoids the "I did nothing →
    /// nothing changed" UX-violation of silent salt rotation per
    /// MYND-22 grilling Q7-α. Side-channel A7 is out of scope per
    /// `threat-model.md`; constant-time comparison not required.
    ///
    /// Frontend UX: form-level error `"Yeni parola mevcut parolayla
    /// aynı."`
    #[error("same password rejected")]
    SamePasswordRejected,

    /// Backend min-length floor (`protocol::password_policy::MIN_PASSWORD_LEN`,
    /// currently 12 Unicode chars) rejected the new password. The
    /// frontend `PasswordForm` already gates this; the backend is a
    /// structural belt+suspenders defense per `decisions.md`
    /// 2026-05-06 "Auth-pipeline backend MIN_PASSWORD_LEN floor;
    /// project-wide retroactive". Cross-plugin shared variant name
    /// with `AppError::WeakNewPassword` and
    /// `VaultRecoveryError::WeakNewPassword`. **Not** an entropy
    /// guarantee — zxcvbn-style entropy gating remains frontend-only.
    #[error("weak new password")]
    WeakNewPassword,

    /// File-system IO failure during `vault.meta` read or atomic
    /// write. The bounded [`IoFailureKind`] keeps OS error messages
    /// off the wire (vault-path leakage prevented at the type level).
    #[error("io error")]
    IoError { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing
    /// CTA is "try again" — recoverable banner, not a credential
    /// error. Cross-plugin shared variant name with
    /// `VaultUnlockError::JoinFailure` and
    /// `VaultRecoveryError::JoinFailure`.
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for VaultChangePasswordError {
    fn from(e: std::io::Error) -> Self {
        VaultChangePasswordError::IoError {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(e: &VaultChangePasswordError) -> String {
        serde_json::to_string(e).expect("VaultChangePasswordError must serialize cleanly")
    }

    #[test]
    fn invalid_credential_or_vault_serializes_with_kind_tag() {
        // Wire shape MUST match `VaultUnlockError::InvalidCredentialOrVault`
        // and `VaultRecoveryError::InvalidCredentialOrVault` — same
        // `kind` tag, same absence of payload. This is the
        // shared-by-name discipline from `decisions.md` 2026-05-02
        // "Recovery error discipline parallels unlock", extended to
        // `vault_change_password` per MYND-22 grilling Q6.
        assert_eq!(
            serialize(&VaultChangePasswordError::InvalidCredentialOrVault),
            r#"{"kind":"InvalidCredentialOrVault"}"#
        );
    }

    #[test]
    fn invalid_vault_meta_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::InvalidVaultMeta),
            r#"{"kind":"InvalidVaultMeta"}"#
        );
    }

    #[test]
    fn vault_meta_changed_externally_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::VaultMetaChangedExternally),
            r#"{"kind":"VaultMetaChangedExternally"}"#
        );
    }

    #[test]
    fn vault_locked_during_change_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::VaultLockedDuringChange),
            r#"{"kind":"VaultLockedDuringChange"}"#
        );
    }

    #[test]
    fn change_password_in_progress_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::ChangePasswordInProgress),
            r#"{"kind":"ChangePasswordInProgress"}"#
        );
    }

    #[test]
    fn vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn same_password_rejected_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::SamePasswordRejected),
            r#"{"kind":"SamePasswordRejected"}"#
        );
    }

    #[test]
    fn weak_new_password_serializes_with_kind_tag() {
        // Cross-plugin shared variant name with `AppError::WeakNewPassword`
        // and `VaultRecoveryError::WeakNewPassword`.
        assert_eq!(
            serialize(&VaultChangePasswordError::WeakNewPassword),
            r#"{"kind":"WeakNewPassword"}"#
        );
    }

    #[test]
    fn io_error_serializes_with_io_failure_kind_payload() {
        let e = VaultChangePasswordError::IoError {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize(&e),
            r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultChangePasswordError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    /// Compile-time enforcement of "no `String` field on any variant".
    ///
    /// If a variant ever grows a `String` (or any non-closed) field,
    /// the unit-or-closed-payload pattern below stops matching and
    /// **this test fails to compile** — the entire point.
    #[test]
    fn all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &VaultChangePasswordError) {
            match e {
                VaultChangePasswordError::InvalidCredentialOrVault => {}
                VaultChangePasswordError::InvalidVaultMeta => {}
                VaultChangePasswordError::VaultMetaChangedExternally => {}
                VaultChangePasswordError::VaultLockedDuringChange => {}
                VaultChangePasswordError::ChangePasswordInProgress => {}
                VaultChangePasswordError::VaultNotUnlocked => {}
                VaultChangePasswordError::SamePasswordRejected => {}
                VaultChangePasswordError::WeakNewPassword => {}
                VaultChangePasswordError::IoError { io_error_kind: _ } => {}
                VaultChangePasswordError::JoinFailure => {}
            }
        }
        assert_closed(&VaultChangePasswordError::JoinFailure);
    }
}
