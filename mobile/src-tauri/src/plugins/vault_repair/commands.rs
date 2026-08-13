//! `vault_repair` Tauri commands (MYND-159) — mobile port.
//!
//! Two commands, identical in logic to the desktop plugin (only the
//! `vault_sweep` path differs — mobile references `myne_core::vault_sweep`
//! directly, desktop via its `crate::vault_sweep` re-export):
//! - [`vault_residue_scan`] — the **read-only detection** half. Counts orphan
//!   artefacts left under `<app_data_dir>/vault/` by a partial-fail
//!   `vault_delete` so the Welcome screen can surface a repair banner. A pure
//!   read: NO `auth_permits`.
//! - [`vault_repair`] — the **destructive sweep**. The exact mirror of
//!   `vault_delete::dispatch_empty_arm`: proceeds only on (slot Empty +
//!   vault.meta byte-absent + residue), `auth_permits`-gated across the
//!   precondition check and the sweep, `RootDisposal::KeepRoot`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::VaultRepairError;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use myne_core::vault_sweep::RootDisposal;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

/// Read-only count of orphan residue under the vault directory.
#[tauri::command]
pub async fn vault_residue_scan<R: Runtime>(app: AppHandle<R>) -> Result<usize, VaultRepairError> {
    let vault_dir = crate::paths::vault_dir_path(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    Ok(vault_residue_scan_with_dir(&vault_dir))
}

/// Testable core of [`vault_residue_scan`].
pub(crate) fn vault_residue_scan_with_dir(vault_dir: &std::path::Path) -> usize {
    myne_core::vault_sweep::count_residue(vault_dir)
}

/// One-shot in-app cleanup of orphan vault residue.
#[tauri::command]
pub async fn vault_repair<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<usize, VaultRepairError> {
    let vault_dir = crate::paths::vault_dir_path(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    vault_repair_with_dir(vault_dir, state.inner()).await
}

/// Testable core of [`vault_repair`].
pub(crate) async fn vault_repair_with_dir(
    vault_dir: PathBuf,
    state: &VaultRuntimeState,
) -> Result<usize, VaultRepairError> {
    // (1) auth_permits gate — try_acquire (reject, never queue), held across
    //     the precondition check AND the sweep so a concurrent
    //     vault_create::commit cannot write a fresh vault mid-sweep.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "vault_repair rejected: another vault.meta-lifecycle op in flight"
            );
            return Err(VaultRepairError::VaultBusyAuth);
        }
    };

    // (2) Slot must be Empty — a non-Empty slot is an active session.
    if state.slot_kind_active().await != SlotKind::Empty {
        tracing::debug!(
            stage = "slot_check",
            error_kind = "VaultPresent",
            "vault_repair rejected: slot non-Empty (active session = live vault)"
        );
        return Err(VaultRepairError::VaultPresent);
    }

    // (3) vault.meta BYTE-presence first (divorced from parse; fail-closed on
    //     an indeterminate stat). Present → vault_delete's gated territory.
    match vault_dir.join("vault.meta").try_exists() {
        Ok(true) => {
            tracing::debug!(
                stage = "meta_check",
                error_kind = "VaultPresent",
                "vault_repair rejected: vault.meta present (vault_delete's gated territory)"
            );
            return Err(VaultRepairError::VaultPresent);
        }
        Ok(false) => {}
        Err(e) => {
            let io_error_kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::warn!(
                stage = "meta_check",
                io_failure_kind = ?io_error_kind,
                "vault_repair aborted: indeterminate vault.meta byte-presence (fail-closed)"
            );
            return Err(VaultRepairError::Io { io_error_kind });
        }
    }

    // (4) Residue must be present, else there is nothing to repair.
    let has_residue = std::fs::read_dir(&vault_dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if !has_residue {
        tracing::debug!(
            stage = "residue_check",
            error_kind = "NothingToRepair",
            "vault_repair rejected: slot Empty, no vault.meta, no residue"
        );
        return Err(VaultRepairError::NothingToRepair);
    }

    // (5) Sweep the residue (KeepRoot — leave the create-able container)
    //     inside spawn_blocking.
    let vault_dir_for_blocking = vault_dir.clone();
    let outcome = match tokio::task::spawn_blocking(move || {
        myne_core::vault_sweep::sweep(&vault_dir_for_blocking, RootDisposal::KeepRoot)
    })
    .await
    {
        Ok(o) => o,
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "Io",
                "vault_repair spawn_blocking join failure"
            );
            return Err(VaultRepairError::Io {
                io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
            });
        }
    };

    if outcome.is_complete() {
        tracing::info!(
            event = "vault_repaired",
            removed = outcome.removed,
            "vault_repair complete"
        );
        Ok(outcome.removed)
    } else {
        let remaining_count = outcome.remaining_count();
        tracing::warn!(
            event = "vault_repair_partial",
            remaining_count = remaining_count,
            "vault_repair completed with partial-fail"
        );
        Err(VaultRepairError::PartialDelete { remaining_count })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::test_vault_id;
    use crate::test_support::ScopedTempDir;

    #[test]
    fn scan_returns_zero_on_empty_or_missing_dir() {
        let tmp = ScopedTempDir::new("vr-scan-empty").unwrap();
        assert_eq!(vault_residue_scan_with_dir(tmp.path()), 0);
        assert_eq!(
            vault_residue_scan_with_dir(&tmp.path().join("nope")),
            0,
            "missing dir scans 0, no error"
        );
    }

    #[test]
    fn scan_counts_every_entry_under_vault_dir() {
        let tmp = ScopedTempDir::new("vr-scan-count").unwrap();
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(notes.join("a.myn"), b"x").unwrap();
        std::fs::write(notes.join("b.myn"), b"y").unwrap();
        std::fs::write(tmp.path().join("vault.meta.tmp"), b"orphan").unwrap();
        assert_eq!(vault_residue_scan_with_dir(tmp.path()), 4);
    }

    #[test]
    fn vault_repair_io_serializes_with_kind_tag() {
        let json = serde_json::to_string(&VaultRepairError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })
        .expect("serialize variant");
        assert_eq!(json, r#"{"kind":"Io","detail":{"io_error_kind":"Other"}}"#);
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn seed_residue(dir: &std::path::Path) {
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::write(
            notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
            b"junk",
        )
        .unwrap();
    }

    #[test]
    fn vault_repair_returns_busy_auth_when_permit_held() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-busy").unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().acquire().await.unwrap();
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Err(VaultRepairError::VaultBusyAuth)),
                "expected VaultBusyAuth when permit held, got {result:?}"
            );
        });
    }

    #[test]
    fn vault_repair_rejects_when_slot_non_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-slot").unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Err(VaultRepairError::VaultPresent)),
                "non-Empty slot (active session) must reject VaultPresent, got {result:?}"
            );
        });
    }

    #[test]
    fn vault_repair_rejects_when_vault_meta_present_even_if_corrupt() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-meta").unwrap();
            std::fs::write(
                tmp.path().join("vault.meta"),
                b"\x00\x01 not a real vault.meta",
            )
            .unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Err(VaultRepairError::VaultPresent)),
                "vault.meta byte-present (even corrupt) must reject VaultPresent, got {result:?}"
            );
            assert!(
                tmp.path().join("notes").exists(),
                "meta-present rejection must NOT sweep the residue"
            );
        });
    }

    #[test]
    fn vault_repair_rejects_nothing_to_repair_on_clean_empty_dir() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-nothing").unwrap();
            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Err(VaultRepairError::NothingToRepair)),
                "clean empty dir must reject NothingToRepair (no silent no-op), got {result:?}"
            );
        });
    }

    #[test]
    fn vault_repair_succeeds_leaves_dir_and_returns_removed_count() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-ok").unwrap();
            seed_residue(tmp.path());
            let scanned = vault_residue_scan_with_dir(tmp.path());
            assert_eq!(scanned, 2);

            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Ok(2)),
                "expected Ok(removed=2) matching the scan count, got {result:?}"
            );
            assert!(
                tmp.path().exists() && tmp.path().is_dir(),
                "vault_dir must be left in place (KeepRoot)"
            );
            assert_eq!(
                vault_residue_scan_with_dir(tmp.path()),
                0,
                "no residue must remain after a successful repair"
            );
        });
    }

    #[test]
    fn vault_repair_meta_present_wins_over_residue() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-meta-wins").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"present").unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(tmp.path().to_path_buf(), &state).await;
            assert!(matches!(result, Err(VaultRepairError::VaultPresent)));
            assert!(tmp.path().join("vault.meta").exists(), "meta preserved");
            assert!(tmp.path().join("notes").exists(), "residue preserved");
        });
    }

    #[test]
    fn vault_present_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&VaultRepairError::VaultPresent).unwrap(),
            r#"{"kind":"VaultPresent"}"#
        );
    }

    #[test]
    fn nothing_to_repair_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&VaultRepairError::NothingToRepair).unwrap(),
            r#"{"kind":"NothingToRepair"}"#
        );
    }

    #[test]
    fn vault_busy_auth_serializes_with_kind_tag() {
        assert_eq!(
            serde_json::to_string(&VaultRepairError::VaultBusyAuth).unwrap(),
            r#"{"kind":"VaultBusyAuth"}"#
        );
    }

    #[test]
    fn partial_delete_serializes_with_kind_tag_and_remaining_count() {
        assert_eq!(
            serde_json::to_string(&VaultRepairError::PartialDelete { remaining_count: 3 }).unwrap(),
            r#"{"kind":"PartialDelete","detail":{"remaining_count":3}}"#
        );
    }
}
