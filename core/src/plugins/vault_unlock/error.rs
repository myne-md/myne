// SPDX-License-Identifier: AGPL-3.0
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
//!   `agent-tooling/sessions/grill/2026-05-02-vault-unlock-password.md`
//!   Q3 + Q4 + Final Summary.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

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

    /// The `vault.meta` magic is a **newer major version this client does not
    /// implement** (`protocol.md` §10.5 anti-downgrade). The same "distinct
    /// advice, not corrupted" reasoning as [`Self::KdfMemoryExceedsHostCapability`]:
    /// the vault is fine, this build is too old. The user's action is **update
    /// this app**, never restore a backup — so it MUST NOT collapse to
    /// [`Self::InvalidVaultMeta`], which would send them to fix a vault that is
    /// not broken. A v0.1-only client hits this on a migrated `NTV5` vault; the
    /// current client handles `MYV1` + `NTV5` and reaches it only on a
    /// hypothetical later major. Never a silent half-parse (§10.1).
    #[error("vault upgraded to an unsupported newer version")]
    VaultUpgradedUnsupported,

    /// Another unlock attempt is already in progress — the unlock
    /// permit (`Semaphore` capacity 1) is held. Returned by
    /// `Semaphore::try_acquire()` rather than queued (see grilling
    /// Q2 — reject, do not queue).
    /// **Not user-facing**: B4a holds an inFlight boolean locally and
    /// disables Submit during the in-flight window. If the user ever
    /// sees this, it indicates a UI-side disable bug.
    #[error("unlock in progress")]
    UnlockInProgress,

    /// A vault-import run is holding THIS vault open as a read-only source
    /// (myne-md/myne#464). The slot map is keyed by `VaultId`, so unlocking it
    /// would have to evict a key context the import is actively reading
    /// through.
    ///
    /// Kept distinct from [`Self::UnlockInProgress`] rather than folded into
    /// it: that variant is documented as not user-facing, on the grounds that
    /// the frontend disables Submit for its whole window, so a user who ever
    /// sees it has hit a UI bug. This one has no such window. It is a state the
    /// user can reach deliberately (start an import, then try to unlock its
    /// source vault), and its resolution is theirs: finish or cancel the
    /// import, or wait for the import slot's TTL.
    #[error("vault is open as a vault-import source")]
    VaultOpenAsImportSource,

    /// A vault import was asked for with NO vault unlocked to import INTO
    /// (myne-md/myne#464).
    ///
    /// **Not user-facing**: the flow is reachable only from the editor, which
    /// exists only while a vault is unlocked, so a user who sees this has hit a
    /// router bug. It is a hard precondition rather than a UI assumption
    /// because of what the absence costs: `open()` would otherwise mint a slot
    /// holding a second vault's `root_key` and `items_key` with no session to
    /// bound it, and `threat-model.md` A6 as amended by this feature bounds
    /// that residency as "no longer than the target vault's own session". A
    /// slot that predates the session is outside that sentence, and
    /// `reseal_attachment` resolves its destination from `active_vault_id()`
    /// at call time, so it would also have no destination to resolve.
    #[error("no vault is unlocked to import into")]
    NoActiveVaultToImportInto,

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
/// `agent-tooling/sessions/grill/2026-05-02-app-state-machine.md` Q9):
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

    fn json<T: serde::Serialize>(e: &T) -> String {
        serde_json::to_string(e).expect("vault unlock error enum must serialize cleanly")
    }

    /// Every unit variant of [`VaultUnlockError`] serializes under
    /// `#[serde(tag = "kind", content = "detail")]` as `{"kind":"<VariantName>"}`.
    #[test]
    fn unit_variants_serialize_with_kind_tag() {
        let cases = [
            (
                json(&VaultUnlockError::VaultNotFound),
                r#"{"kind":"VaultNotFound"}"#,
            ),
            (
                json(&VaultUnlockError::InvalidCredentialOrVault),
                r#"{"kind":"InvalidCredentialOrVault"}"#,
            ),
            (
                json(&VaultUnlockError::InvalidVaultMeta),
                r#"{"kind":"InvalidVaultMeta"}"#,
            ),
            (
                json(&VaultUnlockError::UnlockInProgress),
                r#"{"kind":"UnlockInProgress"}"#,
            ),
            (
                json(&VaultUnlockError::VaultUpgradedUnsupported),
                r#"{"kind":"VaultUpgradedUnsupported"}"#,
            ),
            (
                json(&VaultUnlockError::VaultOpenAsImportSource),
                r#"{"kind":"VaultOpenAsImportSource"}"#,
            ),
            (
                json(&VaultUnlockError::NoActiveVaultToImportInto),
                r#"{"kind":"NoActiveVaultToImportInto"}"#,
            ),
            (
                json(&VaultUnlockError::VaultAlreadyUnlocked),
                r#"{"kind":"VaultAlreadyUnlocked"}"#,
            ),
            (
                json(&VaultUnlockError::VaultRecoveryInProgress),
                r#"{"kind":"VaultRecoveryInProgress"}"#,
            ),
            (
                json(&VaultUnlockError::JoinFailure),
                r#"{"kind":"JoinFailure"}"#,
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
    }

    /// Payload variants serialize as `{"kind":"<Name>","detail":{…}}`. Both KDF
    /// figures are MiB and both are public (`required` from the unencrypted
    /// `vault.meta` KDF block, `available` a property of the client build), so
    /// carrying them lets the UI say which vault, on which client.
    #[test]
    fn payload_variants_serialize_with_detail() {
        let cases = [
            (
                json(&VaultUnlockError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }),
                r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#,
            ),
            (
                json(&VaultUnlockError::KdfMemoryExceedsHostCapability {
                    required_mib: 2048,
                    available_mib: 1024,
                }),
                r#"{"kind":"KdfMemoryExceedsHostCapability","detail":{"required_mib":2048,"available_mib":1024}}"#,
            ),
            (
                json(&VaultStatusError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }),
                r#"{"kind":"IoError","detail":{"io_error_kind":"PermissionDenied"}}"#,
            ),
        ];
        for (actual, expected) in cases {
            assert_eq!(actual, expected);
        }
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
                VaultUnlockError::VaultUpgradedUnsupported => {}
                VaultUnlockError::VaultOpenAsImportSource => {}
                VaultUnlockError::NoActiveVaultToImportInto => {}
            }
        }
        assert_closed(&VaultUnlockError::VaultNotFound);
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
