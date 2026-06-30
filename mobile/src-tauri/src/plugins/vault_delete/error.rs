//! `vault_delete` IPC error enum.
//!
//! Closed taxonomy mirroring the `NoteDeleteError` shape — DENY-list
//! clean (no path strings, no note identifiers, no kernel-error
//! display strings). See `src-tauri/CLAUDE.md` "Secret-handling
//! logging discipline".
//!
//! The variant set is pinned by `decisions.md` 2026-05-26 entries
//! "vault_delete Slot precondition matrix + R3 anti-affordance +
//! VaultNotUnlocked bug-canary" (rejection-arm variants) and
//! "vault_delete partial-fail posture" (`PartialDelete`). The
//! MYND-108-bis extension (2026-05-26 entry "MYND-108-bis vault_delete
//! extended to accept Slot::Empty + vault.meta-exists") **does not add
//! a new variant**: the `Slot::Empty + meta-exists` state moved from
//! a rejection arm (formerly `VaultNotUnlocked`) to a happy path. The
//! `VaultNotUnlocked` variant is **retained in the wire format** for
//! cross-version forward compatibility + defense-in-depth, but is now
//! **unreachable from current code paths**. Hand-mirrored on the TS
//! side at `src/types/vault-delete-error.ts`.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by
/// [`super::commands::vault_delete`].
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                                            | JSON                                                                |
/// |----------------------------------------------------|---------------------------------------------------------------------|
/// | `VaultBusyAuth`                                    | `{"kind":"VaultBusyAuth"}`                                          |
/// | `VaultNotUnlocked`                                 | `{"kind":"VaultNotUnlocked"}`                                       |
/// | `VaultNotFound`                                    | `{"kind":"VaultNotFound"}`                                          |
/// | `PartialDelete { remaining_count }`                | `{"kind":"PartialDelete","detail":{"remaining_count":3}}`           |
/// | `Io { io_error_kind }`                             | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}`       |
//
// Task 5 wired the rejection arms (VaultBusyAuth, VaultNotUnlocked,
// VaultNotFound). Task 7 wired `PartialDelete` (via
// `aggregate_unlink_results`). `Io` is constructed via the
// `From<io::Error>` impl below (race fallback paths). All five
// variants are now production-constructed — no `#[allow(dead_code)]`
// suppression needed; dead-code lint remains active on every variant.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultDeleteError {
    /// Another auth-pipeline operation (vault_unlock,
    /// vault_recover_with_phrase, vault_complete_recovery,
    /// vault_change_password) holds the `auth_permits` capacity-1
    /// semaphore. `vault_delete` uses `try_acquire` (reject, never
    /// queue) per the `auth_permits` discipline established by
    /// `decisions.md` 2026-05-02 "Phase 1 unlock UI semantics — single
    /// in-flight, run to completion" and extended in MYND-105 grill
    /// Q3-D3. Frontend CTA: "try again in a moment".
    #[error("vault busy with auth operation")]
    VaultBusyAuth,

    /// **Unreachable from current code paths** as of MYND-108-bis
    /// (`docs/decisions.md` 2026-05-26 entry "MYND-108-bis vault_delete
    /// extended to accept Slot::Empty + vault.meta-exists"): the
    /// `Slot::Empty + vault.meta-exists` state that previously surfaced
    /// this variant is now the lost-credentials no-keys happy path
    /// (Unlock screen + Recovery phrase-entry surfaces). The variant
    /// is **retained in the wire format** for two reasons: (a)
    /// cross-version forward compatibility — a future client compiled
    /// against this enum should not break if a hypothetical future
    /// backend revives this rejection arm under a different precondition;
    /// (b) defense-in-depth against unanticipated races (e.g., the
    /// `take_and_run_blocking` SlotEmpty branch fell through to
    /// `dispatch_empty_arm` per current code, but a future refactor
    /// might reintroduce a path where surfacing this variant is the
    /// safest choice). Frontend consumers (`mapDeleteVaultError`)
    /// continue to treat this variant as a bug-canary (`console.warn`,
    /// no user-facing banner).
    #[error("vault not unlocked")]
    #[allow(dead_code)]
    // MYND-108-bis: retained in wire format; unreachable from current code paths
    VaultNotUnlocked,

    /// `Slot::Empty` AND `vault.meta` missing on disk. Idempotent
    /// no-op success was deliberately **rejected** in favor of an
    /// explicit rejection per `decisions.md` 2026-05-26
    /// "vault_delete Slot precondition matrix" — silent success
    /// would mask UI bugs and capability-ACL fuzz attempts.
    /// Orphan-artefact cleanup (`vault.meta.tmp`, stray `.myn` files
    /// without a `vault.meta`) is the v0.2 `vault_repair` feature's
    /// responsibility (Plane MYND-159), not `vault_delete`'s.
    #[error("vault not found")]
    VaultNotFound,

    /// One or more files in `<vault>/` could not be unlinked during
    /// the recursive walk. `remaining_count` is the number of files
    /// the loop failed to remove (the count, not the paths — DENY-list
    /// discipline; per-file `io::Error::kind()` reductions emit via
    /// `tracing::warn!(stage = "unlink_blob", io_failure_kind = ?...)`).
    ///
    /// **The slot zeroize (`state.take()`) fires BEFORE the unlink
    /// loop**, so partial-fail does NOT weaken the cryptographic-erase
    /// claim — orphan ciphertext bytes remain Argon2id-wrapped junk
    /// without the in-memory keys. User-facing recovery: manual cleanup
    /// of the vault directory. v0.2 in-app cleanup tracked under
    /// `vault_repair` (Plane MYND-159). See `decisions.md` 2026-05-26
    /// "vault_delete partial-fail posture".
    #[error("partial vault delete: {remaining_count} file(s) remained")]
    PartialDelete {
        /// Count of files the unlink loop could not remove. Always
        /// `>= 1` when this variant is returned (zero would be
        /// returned as `Ok(())`).
        remaining_count: usize,
    },

    /// File-system IO failure outside the per-file unlink loop —
    /// typically `read_dir` failure when enumerating the vault
    /// directory itself, before per-file unlink has started. Per-file
    /// failures inside the loop accumulate into `PartialDelete`
    /// instead. The closed [`IoFailureKind`] keeps OS error messages
    /// off the wire (kernel-dependent path leakage).
    #[error("io error")]
    Io {
        /// Closed-enum categorization of the underlying
        /// `std::io::ErrorKind`. Field name `io_error_kind` mirrors the
        /// `NoteDeleteError::Io { io_error_kind }` shape for TS-side
        /// parser uniformity.
        io_error_kind: IoFailureKind,
    },
}

impl From<std::io::Error> for VaultDeleteError {
    fn from(e: std::io::Error) -> Self {
        VaultDeleteError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}
