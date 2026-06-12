//! `vault_delete` Tauri command — one-shot vault destruction.
//!
//! Feature `backend-vault-delete` (Plane MYND-105) shipped the initial
//! Unlocked/Recovering arms; MYND-108-bis (2026-05-26 `/plan` session,
//! consumed by `ui-vault-delete`) extended the IPC to also accept
//! `Slot::Empty` when `vault.meta` exists on disk (lost-credentials
//! cul-de-sac escape from the Unlock + Recovery phrase-entry surfaces).
//! See `design-notes.md` 2026-05-26 entry "MYND-108-bis vault_delete
//! extended to accept Slot::Empty + vault.meta-exists" for the
//! full rationale.
//!
//! - **Slot precondition matrix** — `VaultBusyAuth` (auth_permits
//!   taken), `Slot::Unlocked` / `Slot::Recovering` (zeroize-then-unlink
//!   happy path), `Slot::Empty + vault.meta-exists` (no-keys lost-
//!   credentials path per MYND-108-bis), `Slot::Empty + no vault.meta`
//!   (rejects `VaultNotFound`; no silent no-op). `VaultNotUnlocked`
//!   variant retained in wire format for cross-version-skew forward
//!   compat + defense-in-depth, but unreachable from current code
//!   paths.
//! - **Happy-path (Unlocked/Recovering):** [`VaultRuntimeState::take_and_run_blocking_for_id`]
//!   takes the slot for the targeted `VaultId` (zeroize via the moved-out variant's `Drop`)
//!   BEFORE any I/O, then runs the per-file unlink walk inside
//!   `spawn_blocking` with the slot write-lock held across the
//!   await. Both `Slot::Unlocked` and `Slot::Recovering` arms
//!   accept (D2 revise per MYND-105 grill Q5 — terminal destroy ≠
//!   navigate-away bail).
//! - **Happy-path (Empty + meta-exists, MYND-108-bis):**
//!   `delete_vault_files_no_zeroize` skips the slot.take() step
//!   (slot is already Empty; no keys to zeroize) and runs the same
//!   `unlink_walk` / `emit_per_unlink_failure_trace` /
//!   `try_parent_dir_sync` / `aggregate_unlink_results` pipeline
//!   directly via `spawn_blocking`. The cryptographic-erase claim is
//!   structurally inapplicable on this arm (no in-memory keys exist
//!   to zeroize); the user reaches this path having lost both
//!   credentials, so the on-disk Argon2id-wrapped keys are already
//!   computationally unrecoverable — recursive unlink converts
//!   computationally-unrecoverable bytes into no-bytes, strictly
//!   stronger.
//! - **Partial-fail surface:** the shared `crate::vault_sweep::sweep`
//!   pipeline runs a post-order recursive walk without short-circuit,
//!   emits `tracing::warn!(stage = "unlink_blob", io_failure_kind = ?kind)`
//!   per failure (DENY-list clean, no paths), and returns a neutral
//!   `SweepOutcome`; `sweep_outcome_to_delete_result` maps it to
//!   `Ok(())` or `Err(PartialDelete { remaining_count })`.
//! - **Durability:** Unix dir `sync_all()` journal-commit hint
//!   (best-effort, never propagates) inside `vault_sweep`; Windows
//!   `#[cfg(unix)]`-gated no-op (matches `note_delete` 2026-05-07
//!   asymmetry precedent).
//! - **Tracing taxonomy:** `event = "vault_deleted"` on success;
//!   `event = "vault_delete_partial"` with `remaining_count` on
//!   partial-fail; per-file `stage = "unlink_blob"`; durability
//!   `stage = "parent_dir_sync"`; rejection-arm `stage = "slot_check"
//!   | "auth_permits"`. All payloads DENY-list-clean (no paths,
//!   no note_ids, no kernel-error display strings).
//!
//! ### Design history
//!
//! - PRD: `agent-tooling/features/backend-vault-delete/prd.md`
//! - Grilling: `agent-tooling/sessions/grill/2026-05-26-mynd-105-vault-delete.md`
//!   Q1–Q9 (cryptographic-erase claim, slot precondition matrix,
//!   R3 escape, partial-fail posture, artefact taxonomy, plugin
//!   layout, test surface)
//! - decisions.md anchors: 2026-05-26 (a) cryptographic-erase
//!   claim, (b) Slot precondition matrix + R3 + VaultNotUnlocked
//!   bug-canary, (c) partial-fail posture + v0.2 vault_repair
//!   (Plane MYND-159), (d) VaultArtifactsPresent rename
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::VaultDeleteError;
use crate::plugins::vault_unlock::state::{SlotKind, TakeAndRunError, VaultRuntimeState};
use crate::vault_id::VaultId;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

/// One-shot vault destruction.
///
/// Zeroizes the in-memory `Slot` (root_key + items_key via the
/// moved-out `UnlockedVault` / `RecoveringMaterial` `Drop`) BEFORE
/// any filesystem operation, then recursively unlinks every entry
/// under `<app_data_dir>/vault/` (post-order, symlinks not
/// followed). Returns `Ok(())` on full success or
/// `Err(VaultDeleteError::PartialDelete { remaining_count })` if
/// some files could not be unlinked (e.g., antivirus / Spotlight /
/// OneDrive sync file locks). On rejection the slot is left intact;
/// on any acceptance path (happy or partial-fail) the slot is Empty.
///
/// # Frontend contract
///
/// **Caller MAY pre-[`crate::plugins::vault_unlock::commands::lock`]
/// (`vault_lock` IPC).** As of MYND-108-bis (`design-notes.md`
/// 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
/// Slot::Empty + vault.meta-exists"), the IPC also accepts the
/// `Slot::Empty` arm when `vault.meta` exists on disk — so pre-locking
/// (which drops the slot to Empty while leaving `vault.meta` on disk)
/// falls through to the new no-keys path with the same end-to-end
/// cryptographic-erase property (`vault_lock`'s zeroize fires before
/// our recursive unlink, preserving the zeroize-before-IO ordering).
/// The MYND-105 era contract that read "MUST NOT pre-lock" is
/// **loosened** by this revision.
///
/// The canonical specification of the broader contract is the PRD at
/// `agent-tooling/features/backend-vault-delete/prd.md` §"Implementation
/// Decisions → Frontend contract surface" (initial shape); the
/// MYND-108-bis extension is canonical in `design-notes.md`
/// 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
/// Slot::Empty + vault.meta-exists".
///
/// # Slot precondition matrix
///
/// | Slot state + disk                                | Behavior                                                                  |
/// |--------------------------------------------------|---------------------------------------------------------------------------|
/// | `Slot::Unlocked`                                 | take() + zeroize + recursive unlink (happy)                               |
/// | `Slot::Recovering`                               | take() + zeroize + recursive unlink (R3 escape, MYND-105 Q5)              |
/// | `Slot::Empty` + `vault.meta` on disk             | no-keys recursive unlink (lost-credentials path, MYND-108-bis)            |
/// | `Slot::Empty` + no `vault.meta`                  | reject `VaultNotFound` (no silent no-op success)                          |
/// | `auth_permits` taken (other auth op mid-Argon2id)| reject `VaultBusyAuth` (try_acquire, never queue)                         |
/// | (legacy) bug-canary defense-in-depth             | `VaultNotUnlocked` retained in wire format but unreachable from current code |
///
/// # See also
///
/// - `agent-tooling/features/backend-vault-delete/prd.md` — PRD
///   (canonical specification of all behavior on this command)
/// - `design-notes.md` 2026-05-26 entries (a)-(d) —
///   cryptographic-erase claim, Slot precondition matrix + R3,
///   partial-fail posture, VaultArtifactsPresent rename
/// - `docs/threat-model.md` A5 (lost or stolen device — locked,
///   Strong) — the load-bearing at-rest guarantee that the
///   "geri getirilemez" UX claim reaffirms post-unlink
#[tauri::command]
pub async fn vault_delete<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
    vault_id: Option<String>,
) -> Result<(), VaultDeleteError> {
    // SYNC-6 explicit-id targeting (mirrors `unlock` / `recover`): the IPC layer
    // carries a canonical hyphenated `VaultId` string. `Some(id)` resolves to
    // `vaults/<id>/` directly (NOT the sole-vault `paths::vault_dir()` scan), so
    // the erase hits exactly the chosen vault and never a sibling. A malformed
    // or absent id is treated as "no explicit target → the active vault", the
    // SYNC-1 sole-`Unlocked` vault the danger-zone delete is driven from. The
    // slot-map key is the same `VaultId` so the per-id slot peek + keyed
    // `take_and_run_blocking_for_id` zeroize only the targeted slot.
    let target = VaultId::parse_optional(vault_id.as_deref());
    // Non-creating resolver (MYND-253): delete destroys an EXISTING vault;
    // a stale/forged id must resolve to a path the scan below turns into
    // VaultNotFound — never materialize an empty `vaults/<bogus-id>/`.
    let vault_dir = crate::paths::vault_root_for_id_optional(&app, target).map_err(|_| {
        VaultDeleteError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        }
    })?;
    // Name the slot-map key: the explicit `target` when present, else the
    // sole-vault id derived from the resolved root (same derivation as
    // `unlock` / `recover` when no explicit id was threaded).
    let vault_id = target.unwrap_or_else(|| crate::paths::vault_id_from_root(&vault_dir));
    let result = vault_delete_with_dir(vault_dir, vault_id, state.inner()).await;

    // MYND-29 Task 8: the slot was dropped iff the delete actually proceeded
    // (full `Ok` or a `PartialDelete`) — wipe the plaintext-derived search
    // index on that same path so it does not outlive the deleted vault. A
    // rejected delete (`BusyAuth` / `VaultNotFound`) left the slot untouched,
    // so any live index belongs to a still-unlocked session and MUST NOT be
    // wiped.
    if matches!(
        &result,
        Ok(()) | Err(VaultDeleteError::PartialDelete { .. })
    ) {
        crate::plugins::notes::search_sync::zeroize_search_index(&app);
        // MYND-166: wipe the staged editor-workspace descriptor too.
        crate::plugins::workspace::commands::clear_staged_descriptor();
        // MYND-255: destroy the hidden pdf-export render window (a
        // plaintext-bearing second WebView) and wipe its stashed HTML
        // payload on the same delete-proceeded path — the deleted vault's
        // plaintext must not outlive the vault in a second window.
        crate::plugins::pdf_export::teardown_on_lock(&app);
        // MYND-31: wipe the plaintext-derived VaultIndices on the same
        // delete-proceeded path so it does not outlive the deleted vault.
        crate::plugins::vault_indices::zeroize_vault_indices(&app);
        // MYND-169: wipe the plaintext-derived attachment reference graph
        // on the same delete-proceeded path so it does not outlive the
        // deleted vault.
        crate::plugins::attachments::zeroize_attachment_refs(&app);
    }
    result
}

/// Testable core of [`vault_delete`]. The Tauri-command wrapper
/// resolves the platform-specific vault directory and delegates here
/// so tests do not need an `tauri::AppHandle`.
///
/// Full pipeline (MYND-105 initial + MYND-108-bis Empty-arm extension):
///
/// 1. `auth_permits.try_acquire()` — RAII guard, reject-not-queue.
/// 2. `state.slot_kind()` peek — discriminate the Slot variant.
/// 3. `Slot::Empty` arm: delegate to [`dispatch_empty_arm`] which
///    checks `vault.meta` on disk and routes either to the no-keys
///    recursive-unlink path (`vault.meta` present → MYND-108-bis
///    lost-credentials accept) or `VaultNotFound` rejection
///    (`vault.meta` absent → no silent no-op success).
/// 4. `Slot::Unlocked` / `Slot::Recovering` arm: delegate to
///    [`VaultRuntimeState::take_and_run_blocking_for_id`] which holds the
///    slot write-lock across the spawn_blocking closure. The
///    closure runs the shared [`crate::vault_sweep::sweep`] pipeline
///    (post-order unlink walk + per-file DENY-list tracing + Unix
///    journal-commit) with [`crate::vault_sweep::RootDisposal::Remove`],
///    then maps the neutral `SweepOutcome` via
///    [`sweep_outcome_to_delete_result`]. Returns Ok(()) on full
///    success, `PartialDelete{remaining_count}` on any per-file failure.
/// 5. On `TakeAndRunError::SlotEmpty` (concurrent `vault_lock`
///    raced between our peek and the write-lock acquire) the unlink
///    did NOT run; the racing `vault_lock`'s `Drop` already zeroized
///    the keys, so we fall through to [`dispatch_empty_arm`] which
///    routes the same way the cold Empty arm would. This preserves
///    the user's delete intent rather than surfacing a silent
///    bug-canary rejection.
pub(crate) async fn vault_delete_with_dir(
    vault_dir: PathBuf,
    vault_id: VaultId,
    state: &VaultRuntimeState,
) -> Result<(), VaultDeleteError> {
    // (1) auth_permits gate — RAII guard; try_acquire, reject not queue.
    //     Bound by `decisions.md` 2026-05-02 "single in-flight" posture
    //     extended in MYND-105 grill Q3-D3 to vault_delete. The permit
    //     stays held until end of function via the `_permit` binding.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "vault_delete rejected: another auth-pipeline op in flight"
            );
            return Err(VaultDeleteError::VaultBusyAuth);
        }
    };

    // (2) Slot precondition matrix — cheap read-lock peek to
    //     discriminate the variant. The Unlocked/Recovering arm
    //     escalates to a write-lock for `take()` inside
    //     `take_and_run_blocking`; the Empty arm routes through
    //     `dispatch_empty_arm` which decides between the new
    //     no-keys accept path (MYND-108-bis) and `VaultNotFound`
    //     rejection.
    match state.slot_kind(vault_id).await {
        SlotKind::Empty => dispatch_empty_arm(vault_dir).await,
        SlotKind::Recovering | SlotKind::Unlocked => {
            // Happy path: take_and_run_blocking takes the slot
            // (zeroize via the moved-out variant's Drop fires BEFORE
            // any IO) then runs the unlink pipeline inside
            // spawn_blocking with the slot write-lock held across
            // the await — concurrent slot-touching ops (vault_lock,
            // vault_unlock, note_*) queue on the RwLock as
            // defense-in-depth alongside the auth_permits hold.
            // Pipeline: `unlink_walk` (enumerated post-order
            // recursive walk, no short-circuit on per-file failure)
            // → `emit_per_unlink_failure_trace` (DENY-list-clean
            // per-file tracing) → `try_parent_dir_sync` (Unix-only
            // best-effort journal commit) → `aggregate_unlink_results`
            // (Ok or `PartialDelete{remaining_count}`). See
            // `decisions.md` 2026-05-26 "vault_delete Slot
            // precondition matrix" + "vault_delete partial-fail
            // posture" + PRD §"Implementation Decisions".
            let vault_dir_for_blocking = vault_dir.clone();
            match state
                .take_and_run_blocking_for_id(vault_id, move || -> Result<(), VaultDeleteError> {
                    // Shared sweep pipeline (`crate::vault_sweep`): post-order
                    // unlink walk + DENY-list-clean per-file tracing +
                    // best-effort Unix journal commit. `RootDisposal::Remove`
                    // keeps vault_delete's "destroy the directory too"
                    // behavior. The neutral `SweepOutcome` is mapped into
                    // `VaultDeleteError` here.
                    let outcome = crate::vault_sweep::sweep(
                        &vault_dir_for_blocking,
                        crate::vault_sweep::RootDisposal::Remove,
                    );
                    sweep_outcome_to_delete_result(outcome)
                })
                .await
            {
                Ok(()) => {
                    tracing::info!(event = "vault_deleted", stage = "complete");
                    Ok(())
                }
                Err(TakeAndRunError::SlotEmpty) => {
                    // Race: a concurrent `vault_lock` IPC fired between
                    // our `slot_kind()` peek and the
                    // `take_and_run_blocking` write-lock acquire.
                    // `vault_lock` doesn't consume an auth_permit, so
                    // the permit we hold doesn't block it. The unlink
                    // did NOT run inside `take_and_run_blocking`, but
                    // the racing `vault_lock`'s Drop already zeroized
                    // the keys — so falling through to the same
                    // `dispatch_empty_arm` as the cold Empty arm
                    // completes the user's delete intent (MYND-108-bis).
                    // No silent bug-canary rejection from this branch.
                    tracing::debug!(
                        stage = "slot_race",
                        "vault_delete: slot raced to Empty during write-lock acquire (vault_lock?); falling through to dispatch_empty_arm"
                    );
                    dispatch_empty_arm(vault_dir).await
                }
                Err(TakeAndRunError::Closure(vd_err)) => {
                    // The closure returned a fully-typed
                    // VaultDeleteError. Currently only PartialDelete
                    // (from aggregate_unlink_results) reaches here.
                    // Emit the partial-fail summary event before
                    // surfacing — DENY-list clean (only count, no
                    // paths).
                    if let VaultDeleteError::PartialDelete { remaining_count } = &vd_err {
                        tracing::warn!(
                            event = "vault_delete_partial",
                            remaining_count = *remaining_count,
                            "vault_delete completed with partial-fail"
                        );
                    } else {
                        // Future-proof: log unexpected closure error.
                        let kind = vault_delete_error_kind(&vd_err);
                        tracing::warn!(
                            stage = "unlink_pipeline",
                            error_kind = kind,
                            "vault_delete unlink pipeline returned non-PartialDelete error"
                        );
                    }
                    Err(vd_err)
                }
                Err(TakeAndRunError::Join) => {
                    tracing::error!(
                        stage = "spawn_blocking_join",
                        error_kind = "Io",
                        "vault_delete spawn_blocking join failure"
                    );
                    Err(VaultDeleteError::Io {
                        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                    })
                }
            }
        }
    }
}

/// Dispatch the `Slot::Empty` arm based on `vault.meta` presence on
/// disk. Called from both the cold Empty arm in [`vault_delete_with_dir`]
/// and the `TakeAndRunError::SlotEmpty` race branch (concurrent
/// `vault_lock` raced through during our write-lock acquire). Routes
/// to [`delete_vault_files_no_zeroize`] when `vault.meta` is present
/// (MYND-108-bis lost-credentials accept path) or returns
/// `VaultNotFound` when nothing is on disk to delete (unchanged from
/// MYND-105's rejection semantics — no silent no-op success).
///
/// See `design-notes.md` 2026-05-26 entry "MYND-108-bis vault_delete
/// extended to accept Slot::Empty + vault.meta-exists" for the
/// rationale that the racing `vault_lock`'s `Drop` already zeroized
/// the keys, so the race branch falling through to this dispatcher
/// preserves the user's delete intent without weakening cryptographic-
/// erase ordering.
pub(crate) async fn dispatch_empty_arm(vault_dir: PathBuf) -> Result<(), VaultDeleteError> {
    if vault_dir.join("vault.meta").is_file() {
        delete_vault_files_no_zeroize(vault_dir).await
    } else {
        tracing::debug!(
            stage = "slot_check",
            error_kind = "VaultNotFound",
            "vault_delete rejected: slot empty and vault.meta absent"
        );
        Err(VaultDeleteError::VaultNotFound)
    }
}

/// MYND-108-bis no-keys recursive unlink path. Used when the slot is
/// `Slot::Empty` but `vault.meta` exists on disk — the user has
/// lost both password and recovery phrase, so there are no in-memory
/// keys to zeroize before unlink. Skips the `take_and_run_blocking`
/// step entirely and runs the same `unlink_walk` /
/// `emit_per_unlink_failure_trace` / `try_parent_dir_sync` /
/// `aggregate_unlink_results` pipeline directly via
/// `tokio::task::spawn_blocking`.
///
/// Tracing emission is identical to the Unlocked/Recovering arm:
/// `event="vault_deleted", stage="complete"` on full success;
/// `event="vault_delete_partial", remaining_count=N` on partial
/// failure (uniform observability for SRE). DENY-list clean — no
/// path, no error::Display, no account identifier in payload.
///
/// See module-level rustdoc for the cryptographic-erase claim's
/// structural inapplicability on this arm (the on-disk Argon2id-
/// wrapped keys are already computationally unrecoverable; recursive
/// unlink converts unrecoverable-bytes → no-bytes).
pub(crate) async fn delete_vault_files_no_zeroize(
    vault_dir: PathBuf,
) -> Result<(), VaultDeleteError> {
    tracing::debug!(
        stage = "slot_check",
        slot_arm = "empty_meta_exists",
        "vault_delete proceeding: slot empty, vault.meta present (MYND-108-bis no-keys lost-credentials path)"
    );
    let vault_dir_for_blocking = vault_dir.clone();
    let join_result = tokio::task::spawn_blocking(move || -> Result<(), VaultDeleteError> {
        let outcome = crate::vault_sweep::sweep(
            &vault_dir_for_blocking,
            crate::vault_sweep::RootDisposal::Remove,
        );
        sweep_outcome_to_delete_result(outcome)
    })
    .await;
    match join_result {
        Ok(Ok(())) => {
            tracing::info!(event = "vault_deleted", stage = "complete");
            Ok(())
        }
        Ok(Err(vd_err)) => {
            if let VaultDeleteError::PartialDelete { remaining_count } = &vd_err {
                tracing::warn!(
                    event = "vault_delete_partial",
                    remaining_count = *remaining_count,
                    "vault_delete completed with partial-fail (no-keys path)"
                );
            } else {
                let kind = vault_delete_error_kind(&vd_err);
                tracing::warn!(
                    stage = "unlink_pipeline",
                    error_kind = kind,
                    "vault_delete unlink pipeline returned non-PartialDelete error (no-keys path)"
                );
            }
            Err(vd_err)
        }
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "Io",
                "vault_delete spawn_blocking join failure (no-keys path)"
            );
            Err(VaultDeleteError::Io {
                io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
            })
        }
    }
}

/// Map the neutral [`crate::vault_sweep::SweepOutcome`] returned by the
/// shared sweep pipeline into a [`VaultDeleteError`] verdict: `Ok(())`
/// when the sweep removed everything, else
/// `VaultDeleteError::PartialDelete { remaining_count }`.
///
/// This is the seam that keeps the shared `vault_sweep` layer
/// plugin-agnostic — the sweep never knows about `VaultDeleteError`; this
/// thin mapper is `vault_delete`'s view of the outcome. `vault_repair`
/// (MYND-159) has its own equivalent mapper into `VaultRepairError`.
pub(crate) fn sweep_outcome_to_delete_result(
    outcome: crate::vault_sweep::SweepOutcome,
) -> Result<(), VaultDeleteError> {
    if outcome.is_complete() {
        Ok(())
    } else {
        Err(VaultDeleteError::PartialDelete {
            remaining_count: outcome.remaining_count(),
        })
    }
}

/// Static-string label helper for every [`VaultDeleteError`] variant.
///
/// Used by `tracing::*!(error_kind = vault_delete_error_kind(&e), ...)`
/// call sites so the variant name (a `&'static str`) crosses the
/// tracing boundary instead of a `?e` Debug formatting that could
/// drag DENY-listed values (paths, io::Error::Display) into log
/// payloads. Same drift-detector discipline as `note_delete_error_kind`
/// — adding a new variant compile-fails this match (the reviewer
/// must update the helper + the wire test).
///
/// Production caller: the `take_and_run_blocking` non-PartialDelete
/// future-proof branch in `vault_delete_with_dir` (Task 7).
pub(crate) fn vault_delete_error_kind(e: &VaultDeleteError) -> &'static str {
    match e {
        VaultDeleteError::VaultBusyAuth => "VaultBusyAuth",
        VaultDeleteError::VaultNotUnlocked => "VaultNotUnlocked",
        VaultDeleteError::VaultNotFound => "VaultNotFound",
        VaultDeleteError::PartialDelete { .. } => "PartialDelete",
        VaultDeleteError::Io { .. } => "Io",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_failure_kind::IoFailureKind;
    use crate::plugins::vault_unlock::state::{test_vault_id, VaultRuntimeState};
    use crate::test_support::ScopedTempDir;

    /// Same per-test runtime pattern as the sibling plugins. Builds a
    /// current-thread tokio runtime each test (no `#[tokio::test]` —
    /// the `tokio = ["macros"]` feature is intentionally NOT enabled
    /// per workspace TB9 audit-anchor discipline; tests build the
    /// runtime manually via `block_on`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    // ---- Slot precondition matrix — rejection arms (Task 5) --------------

    /// Test that `vault_delete` rejects with `VaultBusyAuth` when the
    /// auth_permits semaphore is already taken by another in-flight
    /// op (simulated by acquiring the permit elsewhere first).
    /// `try_acquire` MUST reject rather than queue per the
    /// `decisions.md` 2026-05-02 + MYND-105 Q3-D3 "single in-flight,
    /// reject-not-queue" posture.
    #[test]
    fn vault_delete_returns_busy_auth_when_permit_taken() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-busy-auth").unwrap();
            let state = VaultRuntimeState::default();
            // Pre-acquire the single auth_permit; the guard's drop at
            // function end releases.
            let _held = state.auth_permits().acquire().await.unwrap();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultBusyAuth)),
                "expected VaultBusyAuth, got {result:?}"
            );
        });
    }

    /// Test that `vault_delete` rejects with `VaultNotFound` when
    /// Slot is Empty AND vault.meta is missing on disk. The
    /// "idempotent no-op success" path was explicitly rejected per
    /// `decisions.md` 2026-05-26 entry "vault_delete Slot precondition
    /// matrix" — silent success would mask UI bugs and capability-ACL
    /// fuzz attempts (Q3-D1). Orphan-artefact sweeping is the v0.2
    /// `vault_repair` feature's responsibility (Plane MYND-159).
    #[test]
    fn vault_delete_returns_not_found_when_empty_and_no_vault_meta() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-not-found").unwrap();
            // Empty tempdir — no vault.meta, no notes/, no artefacts.
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultNotFound)),
                "expected VaultNotFound, got {result:?}"
            );
        });
    }

    /// MYND-108-bis: Slot::Empty + vault.meta on disk is now the
    /// **happy path** for the lost-credentials cul-de-sac escape
    /// (Unlock screen tertiary link and Recovery phrase-entry footer
    /// link). The cryptographic-erase claim is structurally
    /// inapplicable on this arm (no keys in memory to zeroize); the
    /// user has lost both password and recovery phrase, so the
    /// on-disk Argon2id-wrapped keys are already computationally
    /// unrecoverable. Recursive unlink converts unrecoverable-bytes
    /// into no-bytes, strictly stronger.
    ///
    /// Test asserts: Ok(()) returned, vault directory gone, slot
    /// remains Empty (no state change since slot was already Empty
    /// entering the call). Was previously the
    /// `vault_delete_returns_not_unlocked_when_empty_with_vault_meta`
    /// rejection test; repurposed for the MYND-108-bis accept path.
    #[test]
    fn vault_delete_from_empty_with_meta_exists_succeeds() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-meta-exists").unwrap();
            // Seed vault.meta + one note + tmp orphan (mimic a real
            // post-creation vault directory without unlocking).
            std::fs::write(tmp.path().join("vault.meta"), b"placeholder vault.meta bytes")
                .expect("seed vault.meta");
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).expect("seed notes/");
            std::fs::write(
                notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"placeholder ciphertext",
            )
            .expect("seed .myn");
            // Slot stays Empty — no set_unlocked / set_recovering call.
            let state = VaultRuntimeState::default();
            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "MYND-108-bis: Empty + vault.meta-exists is the no-keys accept path; expected Ok, got {result:?}"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed by the no-keys recursive-unlink path"
            );
            // Slot was Empty entering the call and stays Empty exiting.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot was Empty entering and stays Empty exiting (no state change)"
            );
        });
    }

    /// Order-of-operations test: auth_permits gate fires BEFORE the
    /// slot peek. When the permit is taken AND the slot would
    /// otherwise produce `VaultNotFound`, the function MUST return
    /// `VaultBusyAuth` (not VaultNotFound). This pins the matrix
    /// order from MYND-105 grill Q3-D3 + Q3-D1.
    #[test]
    fn vault_delete_busy_auth_wins_over_not_found_when_both_apply() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-precedence").unwrap();
            let state = VaultRuntimeState::default();
            // Empty tempdir + slot Empty would normally produce
            // VaultNotFound. But we also hold the permit, so
            // VaultBusyAuth must win.
            let _held = state.auth_permits().acquire().await.unwrap();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultBusyAuth)),
                "auth_permits check must run before slot peek; got {result:?}"
            );
        });
    }

    // ---- Happy-path matrix arms (Task 6) ---------------------------------

    /// R3 recovery-escape happy-path test: from `Slot::Recovering`
    /// fixture + populated vault dir, fires vault_delete_with_dir
    /// and asserts the same post-state as the Unlocked path —
    /// slot Empty (RecoveringMaterial zeroize fired), vault_dir
    /// gone. Verifies user stories 4, 5 (R3 escape).
    #[test]
    fn vault_delete_recovering_removes_dir_and_zeroizes_slot() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-happy-recovering").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"x").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_recovering_with_keys(
                        0xAA, 0xBB, 0xCC,
                    ),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "R3 happy-path Slot::Recovering must succeed; got {result:?}"
            );
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot must be Empty after vault_delete (RecoveringMaterial zeroize fired)"
            );
            assert!(!tmp.path().exists(), "vault_dir must be removed");
        });
    }

    /// Task 9 strict-count L3 cascade test: chmod 0o555 on `notes/`
    /// produces a deterministic cascade of exactly 3 failures —
    /// (1) `notes/<uuid>.myn` unlink fails (notes/ is read-only),
    /// (2) `remove_dir(notes/)` fails (notes/ is non-empty because
    /// the .myn couldn't be removed), (3) `remove_dir(vault_dir)`
    /// fails (vault_dir is non-empty because notes/ couldn't be
    /// removed). `vault.meta` (directly under vault_dir) is removed
    /// successfully because vault_dir is writable.
    ///
    /// PRD Task 9 originally asked for `remaining_count == 1` from
    /// chmod-on-file, which is structurally unachievable on POSIX
    /// (see `vault_delete_chmod_on_myn_file_still_succeeds_posix_unlink_semantic`).
    /// The realistic strict-count assertion is `== 3` for the
    /// cascade topology — tighter than Task 7's `>= 1` end-to-end
    /// test. Regression detector if the walker semantics change.
    #[cfg(unix)]
    #[test]
    fn vault_delete_partial_fail_cascade_remains_count_exactly_three() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-l3-cascade").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(
                notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"x",
            )
            .unwrap();
            // chmod 0o555 on notes/ — read+exec but not write.
            // .myn unlink fails. Cascades upward (notes/, vault_dir).
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions BEFORE assertions so the
            // tempdir teardown can succeed regardless of assertion
            // outcome.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            // Exact cascade count: .myn unlink + remove_dir(notes/) +
            // remove_dir(vault_dir) = 3 failures.
            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert_eq!(
                        remaining_count, 3,
                        "expected cascade of exactly 3 failures (.myn + notes/ + vault_dir), got {remaining_count}"
                    );
                }
                other => panic!("expected PartialDelete{{3}}, got {other:?}"),
            }
            // Slot zeroize fired before walk — slot must be Empty
            // despite the unlink cascade failure.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "key zeroize must precede unlink, regardless of unlink outcome"
            );
            // vault.meta was directly under vault_dir (writable) — it
            // should have been successfully removed before the
            // cascade started.
            assert!(
                !tmp.path().join("vault.meta").exists(),
                "vault.meta should be removed (vault_dir is writable; only notes/ is the read-only barrier)"
            );
        });
    }

    /// Task 9 L3 integration test: chmod 0o000 directly on the .myn
    /// file under a writable notes/ parent. Documents the empirical
    /// finding that POSIX `unlink(2)` requires write permission on
    /// the **parent directory**, not on the file itself — so chmod
    /// on the file alone does NOT block deletion. Result: vault is
    /// fully removed (Ok), `remaining_count` is 0, no PartialDelete.
    ///
    /// The PRD's Task 9 spec called for `PartialDelete{remaining_count: 1}`
    /// from this setup, but that's structurally unachievable on POSIX.
    /// Task 7's `vault_delete_partial_fail_emits_partial_event_and_returns_partial_delete`
    /// (chmod 0o555 on notes/ — parent-dir injection) provides the
    /// realistic L3 partial-fail coverage. This test exists as the
    /// codified empirical evidence and as a regression detector if
    /// the walk's unlink semantics ever change.
    #[cfg(unix)]
    #[test]
    fn vault_delete_chmod_on_myn_file_still_succeeds_posix_unlink_semantic() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-l3-file-chmod").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            let myn = notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn");
            std::fs::write(&myn, b"x").unwrap();
            // chmod 0o000 on the .myn file — POSIX unlink does NOT
            // check this; it checks the parent dir's write perm.
            let mut perms = std::fs::metadata(&myn).unwrap().permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(&myn, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // POSIX semantic: vault is fully removed despite file chmod.
            assert!(
                result.is_ok(),
                "POSIX unlink ignores file perms; expected full Ok, got {result:?}"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed (POSIX unlink succeeded despite chmod 0o000 on file)"
            );
        });
    }

    /// Partial-fail end-to-end test: synthetic chmod injection on
    /// the .myn file (Unix-only) produces a partial-fail outcome,
    /// `PartialDelete{remaining_count: 1}`, AND the `vault_delete_partial`
    /// summary event fires with the right count. This is an
    /// end-to-end smoke for Task 7 — Task 9 will land a more
    /// comprehensive Unix-only integration test.
    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_partial_fail_emits_partial_event_and_returns_partial_delete() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-partial-event").unwrap();
            // Populate vault.meta + one .myn note.
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            let myn = notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn");
            std::fs::write(&myn, b"x").unwrap();
            // Make notes/ read-only so remove_file on myn fails with
            // PermissionDenied. (The myn file itself stays writable —
            // we need the parent dir to be unwritable to block unlink.)
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions so the test fixture's Drop
            // can clean up.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            // Expect PartialDelete; remaining_count depends on what
            // could and couldn't be unlinked (the .myn under
            // read-only notes/ is the at-least-one definite failure).
            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert!(remaining_count >= 1, "expected at least one failed file");
                }
                other => panic!("expected PartialDelete, got {other:?}"),
            }
            // Slot zeroize fired before the unlink — slot must be Empty.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "key zeroize must precede unlink failure"
            );
            assert!(
                logs_contain("event=\"vault_delete_partial\""),
                "expected vault_delete_partial summary event in tracing"
            );
            // NOTE: per-file `unlink_blob` events fire INSIDE the
            // spawn_blocking thread, outside this test's span scope.
            // `tracing_test::traced_test` only captures events emitted
            // from within the test's span — so the per-file emission
            // is verified by the L2 unit tests
            // (`emit_per_unlink_failure_trace_emits_*`) which call the
            // helper directly without spawning. The summary event is
            // captured because it fires post-await in the test's async
            // scope.
        });
    }

    /// MYND-108-bis no-keys partial-fail integration test: Slot::Empty
    /// + chmod 0o555 on notes/ produces the same 3-failure cascade
    /// as the Unlocked-path equivalent
    /// (`vault_delete_partial_fail_cascade_remains_count_exactly_three`),
    /// proving the shared `unlink_walk` pipeline is reused correctly
    /// from the no-keys path. PartialDelete + count assertion via
    /// `vault_delete_partial` summary event.
    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_from_empty_partial_fail_returns_partial() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-partial").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"x").unwrap();
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            // Slot stays Empty entering the call — MYND-108-bis path.
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions for tempdir teardown.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert!(
                        remaining_count >= 1,
                        "expected at least one failed file in the no-keys partial-fail cascade"
                    );
                }
                other => panic!("expected PartialDelete from no-keys path, got {other:?}"),
            }
            assert!(
                logs_contain("event=\"vault_delete_partial\""),
                "expected vault_delete_partial summary event from no-keys path"
            );
            // vault.meta was directly under vault_dir (writable) so
            // it should have been unlinked before the cascade.
            assert!(
                !tmp.path().join("vault.meta").exists(),
                "vault.meta should be removed (vault_dir writable; only notes/ is the barrier)"
            );
        });
    }

    /// Verify the `vault_deleted` tracing event is emitted on
    /// successful unlink, with no DENY-list payload (no path, no
    /// account identifier, no key material, no kernel error strings).
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_success_emits_vault_deleted_event() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-success-trace").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"x").unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("event=\"vault_deleted\""),
                "expected vault_deleted event in tracing on success"
            );
            assert!(
                logs_contain("stage=\"complete\""),
                "expected stage=complete in tracing on success"
            );
            // Path string must NOT appear (DENY-list discipline).
            let path_str = tmp.path().to_string_lossy().to_string();
            assert!(
                !logs_contain(&path_str),
                "vault_dir path leaked into tracing payload (DENY-list violation)"
            );
        });
    }

    /// MYND-160 Task 8 extension: `vault_delete` must remove
    /// `vault.prefs` + `vault.prefs.tmp` alongside the existing
    /// vault.meta / vault.meta.tmp / notes/*.myn artefact set. The
    /// recursive `walk_and_remove` walker is artefact-agnostic by
    /// design — this test pins the behavior so a future refactor that
    /// introduces a hard-coded artefact allow-list cannot silently
    /// orphan vault.prefs. Verifies user stories 9 (delete cleans up
    /// vault.prefs) and 10 (defensive guard catches orphan vault.prefs
    /// on next vault_create — coupled with the
    /// `vault_artifacts_present_returns_true_when_vault_prefs_present`
    /// test in the vault_creation suite).
    #[test]
    fn vault_delete_unlocked_removes_vault_prefs_and_vault_prefs_tmp() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-prefs").unwrap();
            // Populate the full v0.1 artefact set including MYND-160's
            // vault.prefs + vault.prefs.tmp.
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.prefs"), b"prefs bytes").unwrap();
            std::fs::write(
                tmp.path().join("vault.prefs.tmp"),
                b"mid-write prefs crash artefact",
            )
            .unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(11, 22, 1),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(
                result.is_ok(),
                "vault_delete must succeed with MYND-160 artefact set; got {result:?}"
            );
            assert!(
                !tmp.path().join("vault.prefs").exists(),
                "vault.prefs must be removed by vault_delete"
            );
            assert!(
                !tmp.path().join("vault.prefs.tmp").exists(),
                "vault.prefs.tmp must be removed by vault_delete"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (full MYND-160 artefact set + dir itself)"
            );
        });
    }

    /// MYND-169: `vault_delete` removes `vault.attachments` + the
    /// `attachments/` blob directory alongside the existing artefact set.
    /// The recursive `vault_sweep::sweep` walker is artefact-agnostic by
    /// design — this test pins the behaviour so a future refactor that
    /// introduces a hard-coded artefact allow-list cannot silently orphan
    /// the catalog or the blobs (the partner of the
    /// `vault_artifacts_present_returns_true_when_vault_attachments_present`
    /// guard test in the vault_creation suite).
    #[test]
    fn vault_delete_unlocked_removes_vault_attachments_and_blobs() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-attach").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.attachments"), b"catalog bytes").unwrap();
            let attach = tmp.path().join("attachments");
            std::fs::create_dir_all(&attach).unwrap();
            std::fs::write(attach.join("deadbeefcafef00d"), b"blob bytes").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(11, 22, 1),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "vault_delete must succeed with the MYND-169 artefact set; got {result:?}"
            );
            assert!(
                !tmp.path().join("vault.attachments").exists(),
                "vault.attachments must be removed by vault_delete"
            );
            assert!(
                !attach.exists(),
                "attachments/ dir + its blobs must be removed by vault_delete"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (full MYND-169 artefact set)"
            );
        });
    }

    /// Happy-path test: from `Slot::Unlocked` fixture + populated
    /// vault directory (vault.meta + notes/<uuid>.myn + vault.meta.tmp
    /// orphan from mid-write crash), fires `vault_delete_with_dir`
    /// and asserts: Ok(()), slot is now Empty, vault_dir gone.
    /// Verifies user stories 1, 2, 3, 12 (vault.meta.tmp removal).
    #[test]
    fn vault_delete_unlocked_removes_dir_and_zeroizes_slot() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-happy-unlocked").unwrap();
            // Populate a realistic vault directory.
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.meta.tmp"), b"mid-write crash artefact").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"note").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(result.is_ok(), "happy-path Slot::Unlocked must succeed; got {result:?}");
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot must be Empty after vault_delete (UnlockedVault zeroize-on-drop fired)"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (vault.meta + vault.meta.tmp + notes/*.myn + notes/ dir + vault_dir itself)"
            );
        });
    }

    // ---- MYND-205: VaultId-targeted erase leaves siblings untouched -------

    /// SYNC-6 explicit-id targeting: `vault_delete_with_dir` erases EXACTLY the
    /// resolved `vaults/<id>/` for the targeted `VaultId` and leaves any sibling
    /// `vaults/<other>/` directory completely untouched. Models the multi-vault
    /// danger-zone delete where vault A is the active (sole `Unlocked`) vault and
    /// vault B is a never-opened-this-session sibling that must survive. Two
    /// physically-separate vault roots under a shared `vaults/` parent stand in
    /// for the on-disk layout; the per-`VaultId` slot peek + the keyed
    /// `take_and_run_blocking_for_id` together guarantee only the targeted slot
    /// is zeroized and only the targeted directory is unlinked.
    #[test]
    fn vault_delete_targets_named_vault_and_leaves_sibling_untouched() {
        use crate::vault_id::VaultId;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-sibling-untouched").unwrap();
            let vaults = tmp.path().join("vaults");

            // Two well-formed vault roots side by side under `vaults/`.
            let id_a = VaultId::mint();
            let id_b = VaultId::mint();
            let dir_a = vaults.join(id_a.to_string());
            let dir_b = vaults.join(id_b.to_string());
            for dir in [&dir_a, &dir_b] {
                std::fs::create_dir_all(dir.join("notes")).unwrap();
                std::fs::write(dir.join("vault.meta"), b"meta bytes").unwrap();
                std::fs::write(
                    dir.join("notes")
                        .join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                    b"ciphertext",
                )
                .unwrap();
            }

            // Vault A is the active (sole `Unlocked`) vault; vault B stays a
            // sibling with no runtime slot (locked / never opened this session).
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id_a,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            // Delete A by its explicit id, resolving to A's own root.
            let result = vault_delete_with_dir(dir_a.clone(), id_a, &state).await;
            assert!(
                result.is_ok(),
                "targeted delete of the active vault must succeed; got {result:?}"
            );

            // A's directory is gone; A's slot zeroized to Empty.
            assert!(
                !dir_a.exists(),
                "the targeted vaults/<id_a>/ must be removed"
            );
            assert_eq!(
                state.slot_kind(id_a).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "the targeted vault's slot must be Empty (keys zeroized)"
            );

            // The sibling B is COMPLETELY untouched — directory, vault.meta, blob.
            assert!(dir_b.exists(), "the sibling vaults/<id_b>/ must remain");
            assert!(
                dir_b.join("vault.meta").is_file(),
                "the sibling's vault.meta must remain"
            );
            assert!(
                dir_b
                    .join("notes")
                    .join("0193e8d3-1234-7890-abcd-ef0123456789.myn")
                    .is_file(),
                "the sibling's note blob must remain"
            );
        });
    }

    // ---- L2: tracing-test emission verification ---------------------------
    //
    // Each rejection arm emits a `tracing::debug!(stage = ..., error_kind = ...)`
    // event. These tests assert the right error_kind label crosses the
    // tracing boundary without DENY-list values (no paths, no kernel
    // error strings, no key material).

    #[test]
    #[tracing_test::traced_test]
    fn busy_auth_rejection_emits_static_error_kind() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-tr-busy").unwrap();
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().acquire().await.unwrap();
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("error_kind=\"VaultBusyAuth\""),
                "expected VaultBusyAuth error_kind label in tracing"
            );
            assert!(
                logs_contain("stage=\"auth_permits\""),
                "expected stage=auth_permits in tracing"
            );
        });
    }

    /// MYND-108-bis tracing test: Empty + vault.meta-exists emits the
    /// new `slot_arm = "empty_meta_exists"` discriminator at
    /// `stage = "slot_check"` (the dispatch decision), then the same
    /// uniform `event="vault_deleted", stage="complete"` event on
    /// success that the Unlocked/Recovering arms emit. Was previously
    /// the `not_unlocked_rejection_emits_static_error_kind` rejection
    /// test; repurposed for the MYND-108-bis happy path.
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_from_empty_with_meta_exists_emits_vault_deleted_event() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-trace").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"x").unwrap();
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "Empty + vault.meta-exists must succeed; got {result:?}"
            );
            assert!(
                logs_contain("slot_arm=\"empty_meta_exists\""),
                "expected slot_arm=empty_meta_exists discriminator at slot_check stage"
            );
            assert!(
                logs_contain("event=\"vault_deleted\""),
                "expected vault_deleted event on success (uniform with Unlocked/Recovering arms)"
            );
            assert!(
                logs_contain("stage=\"complete\""),
                "expected stage=complete on success"
            );
            // DENY-list: path string must not appear.
            let path_str = tmp.path().to_string_lossy().to_string();
            assert!(
                !logs_contain(&path_str),
                "vault_dir path leaked into tracing payload (DENY-list violation)"
            );
        });
    }

    #[test]
    #[tracing_test::traced_test]
    fn not_found_rejection_emits_static_error_kind() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-tr-not-found").unwrap();
            let state = VaultRuntimeState::default();
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("error_kind=\"VaultNotFound\""),
                "expected VaultNotFound error_kind label in tracing"
            );
        });
    }

    // ---- JSON wire shape -------------------------------------------------
    //
    // IPC contract: each VaultDeleteError variant serializes to the
    // exact tag shape pinned by the PRD §"Implementation Decisions →
    // VaultDeleteError variant set". TS-side parser (lands with
    // MYND-108 frontend feature) consumes these.

    #[test]
    fn vault_busy_auth_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultBusyAuth).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultBusyAuth"}"#);
    }

    #[test]
    fn vault_not_unlocked_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultNotUnlocked).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultNotUnlocked"}"#);
    }

    #[test]
    fn vault_not_found_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultNotFound).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultNotFound"}"#);
    }

    #[test]
    fn partial_delete_serializes_with_kind_tag_and_remaining_count() {
        let json = serde_json::to_string(&VaultDeleteError::PartialDelete { remaining_count: 3 })
            .expect("serialize variant");
        assert_eq!(
            json,
            r#"{"kind":"PartialDelete","detail":{"remaining_count":3}}"#
        );
    }

    #[test]
    fn io_serializes_with_kind_tag_and_io_error_kind() {
        let json = serde_json::to_string(&VaultDeleteError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        })
        .expect("serialize variant");
        assert_eq!(
            json,
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    // ---- Static-string label exhaustive-match drift test -----------------
    //
    // Compile-time exhaustiveness via the helper's match. Each variant
    // is asserted by the test; adding a new variant compile-fails the
    // helper, which compile-fails this test, which surfaces in code
    // review (the reviewer must update both helper and test in the
    // same PR). Same pattern as `note_delete_error_kind` drift test.

    #[test]
    fn vault_delete_error_kind_label_covers_every_variant() {
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultBusyAuth),
            "VaultBusyAuth"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultNotFound),
            "VaultNotFound"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::PartialDelete { remaining_count: 1 }),
            "PartialDelete"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
    }

    // ---- io::Error From impl ---------------------------------------------

    #[test]
    fn from_io_error_maps_permission_denied_to_io_variant() {
        let e: VaultDeleteError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert!(
            matches!(
                e,
                VaultDeleteError::Io {
                    io_error_kind: IoFailureKind::PermissionDenied
                }
            ),
            "PermissionDenied must map to Io{{PermissionDenied}}, got {e:?}"
        );
    }

    #[test]
    fn from_io_error_maps_not_found_to_io_variant() {
        let e: VaultDeleteError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert!(matches!(
            e,
            VaultDeleteError::Io {
                io_error_kind: IoFailureKind::NotFound
            }
        ));
    }
}
