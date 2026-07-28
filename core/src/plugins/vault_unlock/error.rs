//! Tauri-layer error type for the vault-unlock plugin.
//!
//! Mirrors `vault_creation::error::AppError` in spirit (no `String`
//! field anywhere reaches the frontend) but specialized to the unlock
//! domain. The seven variants form a closed set that the TS-side
//! discriminated union (Task 9 of `vault-unlock-password`) hand-mirrors.
//!
//! Spec touchpoints:
//! - `protocol.md` §7.3: `InvalidCredentialOrVault` is the single
//!   non-distinguishing tag for AEAD-tag failure on the password
//!   wrap-key. By design it does NOT distinguish "wrong password"
//!   from "tampered password section of vault.meta".
//! - `decisions.md` 2026-05-02 (Phase 1 unlock error discipline,
//!   Task 11): `InvalidVaultMeta` is the single category for parse
//!   errors AND post-derivation `items_key` wrap failures — both
//!   leak nothing about credential validity.
//! - Grilling session
//!   `myne-agents/sessions/grill/2026-05-02-vault-unlock-password.md`
//!   Q3 + Q4 + Final Summary.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// vault-unlock plugin's commands.
///
/// Hand-mirrored on the TS side at `src/types/vault-unlock-error.ts`
/// (Task 9 of `vault-unlock-password`). Variant set is closed;
/// adding a variant is an IPC contract change that requires updating
/// both sides.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultUnlockError {
    /// `vault.meta` does not exist at the expected path. Frontend
    /// routes to vault-creation flow rather than showing the unlock
    /// screen — first-run UX.
    #[error("vault not found")]
    VaultNotFound,

    /// AEAD-tag failure on the password wrap-key. **By design this
    /// single variant does NOT distinguish** "wrong password" from
    /// "tampered password section of vault.meta" — see
    /// `protocol.md` §7.3.
    #[error("invalid credential or vault")]
    InvalidCredentialOrVault,

    /// `vault.meta` is structurally malformed (bad magic, wrong
    /// length, wrong protocol_version, invalid KDF block) OR the
    /// post-derivation `items_key` wrap blob fails AEAD verification.
    /// Both share a single user-facing CTA ("vault file is unreadable,
    /// restore from a backup"); the internal sub-stage is emitted via
    /// `tracing::error!(stage = "...")` for ops debugging only and
    /// MUST NOT cross the IPC boundary as a distinguisher.
    #[error("invalid vault.meta")]
    InvalidVaultMeta,

    /// File-system IO failure while reading `vault.meta`. The bounded
    /// [`IoFailureKind`] keeps OS error messages off the wire.
    #[error("io error")]
    IoError { io_error_kind: IoFailureKind },

    /// The vault's Argon2id memory cost is **legal but unaffordable on this
    /// host** (phase3-web-client task 31).
    ///
    /// Distinct from [`Self::InvalidVaultMeta`] on purpose, and the distinction
    /// is the whole point: `InvalidVaultMeta` means "this file is unreadable,
    /// restore from a backup", which is **wrong advice here**. The vault is
    /// fine; this client cannot open it. The user's action is to open it on a
    /// desktop client, and a variant that said "corrupted" would send them to
    /// restore a backup they do not need.
    ///
    /// Raised **before** the allocation, so it is a refusal rather than a caught
    /// OOM — on `wasm32` an over-large allocation aborts the instance, which
    /// cannot be caught at all and presents as a dead Worker with no cause.
    ///
    /// Both figures are in MiB and both are **public**: `required` comes from
    /// the unencrypted `vault.meta` KDF block, which `protocol.md` §4.2 makes
    /// deliberately inspectable, and `available` is a property of the client
    /// build. Neither is credential-adjacent, so carrying them is safe and lets
    /// the UI say something concrete instead of "this vault will not open".
    #[error("kdf memory cost exceeds host capability")]
    KdfMemoryExceedsHostCapability {
        required_mib: u32,
        available_mib: u32,
    },

    /// Another unlock attempt is already in progress — the unlock
    /// permit (`Semaphore` capacity 1) is held. Returned by
    /// `Semaphore::try_acquire()` rather than queued (see grilling
    /// Q2 — reject, do not queue).
    /// **Not user-facing**: B4a holds an inFlight boolean locally and
    /// disables Submit during the in-flight window. If the user ever
    /// sees this, it indicates a UI-side disable bug.
    #[error("unlock in progress")]
    UnlockInProgress,

    /// The vault is already unlocked. Returned by the slot-peek guard
    /// when an unlock attempt arrives with the slot occupied by
    /// `Slot::Unlocked(_)`.
    /// **Not user-facing**: frontend routes the user to the editor
    /// when the slot is occupied; if this surfaces, a router bug.
    #[error("vault already unlocked")]
    VaultAlreadyUnlocked,

    /// A recovery flow is in progress (`Slot::Recovering`) — the user
    /// has successfully recovered with their phrase but has not yet
    /// committed a new master password via `vault_complete_recovery`.
    /// `vault_unlock` is structurally rejected during this window per
    /// `recovery-flow.md` §4.1's non-dismissible mandatory chained
    /// step. Not user-facing: frontend routes via `vault_status` and
    /// only invokes unlock when slot is Empty.
    #[error("vault recovery in progress")]
    VaultRecoveryInProgress,

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing
    /// CTA is "try again" — recoverable banner, not a credential error.
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for VaultUnlockError {
    fn from(e: std::io::Error) -> Self {
        // NotFound is special-cased by the calling command (the
        // canonical missing-vault.meta case surfaces as
        // `VaultNotFound`, distinct from generic IO failures). This
        // From impl handles the residual case where an `io::Error`
        // bubbles up after that classification has already been made.
        VaultUnlockError::IoError {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Error type returned by [`super::commands::vault_status`].
///
/// Distinct from [`VaultUnlockError`]: the status probe runs before
/// any unlock attempt, so credential-related variants
/// (`InvalidCredentialOrVault`, `UnlockInProgress`, `VaultAlreadyUnlocked`,
/// `JoinFailure`) have no IPC contract meaning here. A per-command
/// error type keeps the contract minimal and forces the frontend caller
/// to handle the right error shape.
///
/// **`IoError` is the only failure surface.** `parse_vault_meta`
/// rejects surface as `Ok(VaultStatus::Corrupted)` (β=i in
/// `myne-agents/sessions/grill/2026-05-02-app-state-machine.md` Q9):
/// IO failure ≠ corruption, and the frontend's fail-closed UI
/// branches the same way for both, but the distinction matters for
/// log triage.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultStatusError {
    /// File-system IO failure while probing `vault.meta`. `NotFound`
    /// is special-cased upstream as `Ok(VaultStatus::Missing)`; only
    /// `PermissionDenied` / `NoSpace` / `Other` surface here.
    #[error("io error")]
    IoError { io_error_kind: IoFailureKind },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize(e: &VaultUnlockError) -> String {
        serde_json::to_string(e).expect("VaultUnlockError must serialize cleanly")
    }

    #[test]
    fn vault_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::VaultNotFound),
            r#"{"kind":"VaultNotFound"}"#
        );
    }

    #[test]
    fn invalid_credential_or_vault_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::InvalidCredentialOrVault),
            r#"{"kind":"InvalidCredentialOrVault"}"#
        );
    }

    #[test]
    fn invalid_vault_meta_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::InvalidVaultMeta),
            r#"{"kind":"InvalidVaultMeta"}"#
        );
    }

    #[test]
    fn io_error_serializes_with_io_failure_kind_payload() {
        let e = VaultUnlockError::IoError {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize(&e),
            r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn unlock_in_progress_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::UnlockInProgress),
            r#"{"kind":"UnlockInProgress"}"#
        );
    }

    #[test]
    fn vault_already_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::VaultAlreadyUnlocked),
            r#"{"kind":"VaultAlreadyUnlocked"}"#
        );
    }

    #[test]
    fn vault_recovery_in_progress_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::VaultRecoveryInProgress),
            r#"{"kind":"VaultRecoveryInProgress"}"#
        );
    }

    #[test]
    fn join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize(&VaultUnlockError::JoinFailure),
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
        fn assert_closed(e: &VaultUnlockError) {
            match e {
                VaultUnlockError::VaultNotFound => {}
                VaultUnlockError::InvalidCredentialOrVault => {}
                VaultUnlockError::InvalidVaultMeta => {}
                VaultUnlockError::IoError { io_error_kind: _ } => {}
                VaultUnlockError::UnlockInProgress => {}
                VaultUnlockError::VaultAlreadyUnlocked => {}
                VaultUnlockError::VaultRecoveryInProgress => {}
                VaultUnlockError::JoinFailure => {}
                VaultUnlockError::KdfMemoryExceedsHostCapability {
                    required_mib: _,
                    available_mib: _,
                } => {}
            }
        }
        assert_closed(&VaultUnlockError::VaultNotFound);
    }

    /// The wire shape the TS mirror in `src/types/vault-unlock-error.ts`
    /// hand-mirrors (phase3-web-client task 31). Both figures are MiB and both
    /// are public — `required` is read from the unencrypted `vault.meta` KDF
    /// block, `available` is a property of the client build — so carrying them
    /// across the boundary lets the UI say which vault, on which client,
    /// instead of "this vault will not open".
    #[test]
    fn kdf_memory_exceeds_host_capability_serializes_with_both_figures() {
        assert_eq!(
            serialize(&VaultUnlockError::KdfMemoryExceedsHostCapability {
                required_mib: 2048,
                available_mib: 1024,
            }),
            r#"{"kind":"KdfMemoryExceedsHostCapability","detail":{"required_mib":2048,"available_mib":1024}}"#
        );
    }

    #[test]
    fn from_io_error_maps_via_closed_enum() {
        // Synthesize an io::Error of a specific ErrorKind; verify it
        // arrives as the matching IoFailureKind variant. The raw
        // io::Error::Display string is dropped at the boundary.
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: VaultUnlockError = raw.into();
        match mapped {
            VaultUnlockError::IoError { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected IoError variant, got {other:?}"),
        }
    }

    #[test]
    fn from_io_error_unknown_kind_collapses_to_other() {
        let raw = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let mapped: VaultUnlockError = raw.into();
        match mapped {
            VaultUnlockError::IoError { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::Other);
            }
            other => panic!("expected IoError variant, got {other:?}"),
        }
    }

    #[test]
    fn vault_status_error_io_serializes_with_io_failure_kind_payload() {
        let e = VaultStatusError::IoError {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serde_json::to_string(&e).expect("VaultStatusError must serialize cleanly"),
            r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    /// Compile-time enforcement of "no `String` field on any variant"
    /// for [`VaultStatusError`] — mirror of
    /// `all_variants_have_closed_payloads_only` for the unlock error.
    /// If a variant grows a `String` field, the match below stops
    /// covering, the test fails to compile, and the boundary discipline
    /// is enforced at compile time.
    #[test]
    fn vault_status_error_variants_have_closed_payloads_only() {
        fn assert_closed(e: &VaultStatusError) {
            match e {
                VaultStatusError::IoError { io_error_kind: _ } => {}
            }
        }
        assert_closed(&VaultStatusError::IoError {
            io_error_kind: IoFailureKind::Other,
        });
    }
}
