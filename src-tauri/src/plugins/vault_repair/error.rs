// SPDX-License-Identifier: AGPL-3.0-only
//! `vault_repair` IPC error enum (MYND-159).
//!
//! Closed taxonomy, DENY-list clean (no path strings, no kernel-error
//! display strings) — same discipline as `VaultDeleteError`. See
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline".
//!
//! The rejection arms are the exact mirror of `vault_delete`'s
//! `dispatch_empty_arm`: vault_delete owns "vault.meta present" (its
//! typed-DELETE-gated territory), vault_repair owns "vault.meta absent +
//! residue". Together they partition the Empty-slot state space (design
//! session 2026-06-06, Q3). Hand-mirrored on the TS side at
//! `src/types/vault-repair-error.ts`.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// `vault-repair` plugin's commands.
///
/// Serialization shape (`tag = "kind", content = "detail"`):
///
/// | Variant                              | JSON                                                          |
/// |--------------------------------------|---------------------------------------------------------------|
/// | `VaultBusyAuth`                      | `{"kind":"VaultBusyAuth"}`                                    |
/// | `VaultPresent`                      | `{"kind":"VaultPresent"}`                                     |
/// | `NothingToRepair`                  | `{"kind":"NothingToRepair"}`                                  |
/// | `PartialDelete { remaining_count }` | `{"kind":"PartialDelete","detail":{"remaining_count":3}}`     |
/// | `Io { io_error_kind }`              | `{"kind":"Io","detail":{"io_error_kind":"Other"}}`           |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultRepairError {
    /// Another vault.meta-lifecycle operation holds the `auth_permits`
    /// capacity-1 semaphore. `vault_repair` uses `try_acquire` (reject,
    /// never queue) and holds the permit across the precondition check AND
    /// the sweep, so a concurrent `vault_create::commit` (also pulled into
    /// the permit by MYND-159) cannot write a fresh vault into the
    /// directory mid-sweep (the closed TOCTOU). Shares the variant name
    /// with `VaultDeleteError::VaultBusyAuth`.
    #[error("vault busy with auth operation")]
    VaultBusyAuth,

    /// A live vault is present — either `vault.meta` exists on disk
    /// (**byte-presence**, divorced from parseability — a corrupt meta
    /// still counts) or the runtime slot is non-Empty (an active
    /// Unlocked / Recovering session). Either way this is `vault_delete`'s
    /// typed-DELETE-gated territory, never `vault_repair`'s gate-free
    /// sweep. This rejection is the load-bearing safety property: it makes
    /// vault_repair structurally incapable of destroying a vault that
    /// still has a `vault.meta`, so it can never bypass the typed-DELETE
    /// confirmation gate.
    #[error("vault present")]
    VaultPresent,

    /// Slot Empty + `vault.meta` absent + **no residue** — there is
    /// nothing to repair. Returned (not silent-success) so a UI bug or
    /// capability-ACL fuzz that fires `vault_repair` on a clean device
    /// surfaces loudly rather than masquerading as a successful cleanup
    /// (the bug-canary discipline inherited from `vault_delete`'s D1).
    #[error("nothing to repair")]
    NothingToRepair,

    /// One or more residue entries could not be removed during the sweep
    /// (e.g. a file lock from antivirus / Spotlight / OneDrive that has not
    /// yet released). `remaining_count` is the failure count only — never
    /// per-file paths (DENY-list discipline). Same one-shot best-effort
    /// posture as `vault_delete` (decisions.md 2026-05-26 "partial-fail
    /// posture"); the UI falls back to the manual-cleanup instruction.
    #[error("partial vault repair: {remaining_count} file(s) remained")]
    PartialDelete {
        /// Count of residue entries the sweep could not remove. Always
        /// `>= 1` when this variant is returned (zero is `Ok(removed)`).
        remaining_count: usize,
    },

    /// File-system / path-resolution failure outside the per-file sweep
    /// loop (`app_data_dir` lookup, `spawn_blocking` join failure, or an
    /// indeterminate `vault.meta` byte-presence stat — fail-closed). The
    /// closed [`IoFailureKind`] keeps OS error messages off the wire.
    #[error("io error")]
    Io {
        /// Closed categorization of the underlying `std::io::ErrorKind`.
        io_error_kind: IoFailureKind,
    },
}
