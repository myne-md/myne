// SPDX-License-Identifier: AGPL-3.0-only
//! `vault_repair` Tauri commands (MYND-159) — mobile port.
//!
//! Two commands, identical in logic to the desktop plugin (only the
//! `vault_sweep` path differs — mobile references `myne_core::vault_sweep`
//! directly, desktop via its `crate::vault_sweep` re-export):
//! - [`vault_residue_scan`] — the **read-only detection** half. Reports every
//!   vault root under `<app_data_dir>` that still holds entries (`vaults/<id>/`
//!   and the legacy `vault/`), each classified by whether it carries a
//!   `vault.meta`. A pure read: NO `auth_permits`.
//! - [`vault_repair`] — the **destructive sweep**. Runs the exact mirror of
//!   `vault_delete::dispatch_empty_arm` per repairable root: proceeds only on
//!   (slot Empty + vault.meta byte-absent + residue), `auth_permits`-gated
//!   across each root's precondition check and sweep, `RootDisposal::KeepRoot`. Once the
//!   sweep has run it also destroys this vault's sealed-label wrap key
//!   (myne-md/myne#411), because the sweep is artefact-agnostic and takes
//!   `vault.label` with the rest of the residue: a key left alive over
//!   ciphertext that is still recoverable from the medium is the exact
//!   combination that feature argues is not an erase. It matters on iOS,
//!   where `platform_keychain` has a real backend; on Android it has none,
//!   so there is no key to strand and the call is a no-op that costs
//!   nothing to keep symmetric.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use super::error::VaultRepairError;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use myne_core::vault_sweep::RootDisposal;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

/// One vault root that still holds entries, as the Welcome banner sees it.
///
/// `has_vault_meta` is what keeps the banner honest. A root carrying
/// `vault.meta` is not cleanable by [`vault_repair`] by design (it could be
/// somebody's vault), so offering it the "clean up" button is a button that can
/// only ever answer "couldn't finish cleaning up". The client routes that root
/// to `vault_delete` instead, which is the command that owns a
/// `vault.meta`-gated directory and the one whose typed-DELETE gate makes the
/// act deliberate.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidueRootView {
    /// The id the root is addressable by (the legacy sentinel for `<base>/vault`).
    pub vault_id: String,
    /// Recursive entry count under the root.
    pub entries: usize,
    /// `vault.meta` byte-present here ⇒ `vault_delete`'s territory.
    pub has_vault_meta: bool,
}

/// Read-only report of every vault root that still holds entries.
#[tauri::command]
pub async fn vault_residue_scan<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<ResidueRootView>, VaultRepairError> {
    let base = crate::paths::app_data_dir(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    Ok(vault_residue_scan_from_base(&base))
}

/// Testable core of [`vault_residue_scan`].
///
/// Enumerates `<base>/vaults/<id>/` and the legacy `<base>/vault/`, rather than
/// asking the transitional sole-vault resolver where "the" vault is: that
/// resolver answers with a LIVE vault the moment one vault remains, so its count
/// reports a healthy vault's files as leftovers and the sweep is then refused
/// as `VaultPresent` for good. There is one residue root per vault directory, so
/// there is one row per vault directory.
pub(crate) fn vault_residue_scan_from_base(base: &std::path::Path) -> Vec<ResidueRootView> {
    myne_core::vault_sweep::scan_residue_roots(base)
        .into_iter()
        .map(|root| ResidueRootView {
            vault_id: root.vault_id.to_string(),
            entries: root.entries,
            has_vault_meta: root.has_vault_meta,
        })
        .collect()
}

/// One-shot in-app cleanup of orphan vault residue.
///
/// Sweeps every residue root that is genuinely repairable (no `vault.meta`) and
/// resolves to the total number of entries removed. A root that still carries
/// `vault.meta` is never swept here; when that is ALL that is left, this rejects
/// with [`VaultRepairError::VaultPresent`] so the caller can route it to
/// `vault_delete` rather than showing a button that cannot work.
#[tauri::command]
pub async fn vault_repair<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<usize, VaultRepairError> {
    let base = crate::paths::app_data_dir(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    vault_repair_from_base(
        &base,
        state.inner(),
        &myne_core::vault_io::StdVaultIo,
        myne_core::vault_label::key::platform_keychain(),
    )
    .await
}

/// Testable core of [`vault_repair`]: pick the repairable roots out of the
/// residue report, sweep each one through [`vault_repair_with_dir`] (which keeps
/// every precondition per root), and aggregate.
///
/// Per root rather than per device on purpose: the gates in
/// `vault_repair_with_dir` are the load-bearing half (slot Empty, `vault.meta`
/// byte-absent), and running them once per root means a vault that appeared
/// between the scan and the sweep is refused rather than swept.
pub(crate) async fn vault_repair_from_base(
    base: &std::path::Path,
    state: &VaultRuntimeState,
    io: &dyn myne_core::vault_io::VaultIo,
    keychain: &dyn myne_core::vault_label::key::LabelKeychain,
) -> Result<usize, VaultRepairError> {
    let roots = myne_core::vault_sweep::scan_residue_roots(base);
    let repairable: Vec<_> = roots
        .iter()
        .filter(|root| !root.has_vault_meta)
        .map(|root| root.root.clone())
        .collect();

    if repairable.is_empty() {
        return Err(if roots.is_empty() {
            VaultRepairError::NothingToRepair
        } else {
            // What is left is a `vault.meta`-bearing root (or several): that is
            // `vault_delete`'s typed-DELETE-gated territory, so the honest
            // answer to a gate-free sweep is the same refusal as ever.
            VaultRepairError::VaultPresent
        });
    }

    let mut removed = 0usize;
    let mut remaining = 0usize;
    for dir in repairable {
        match vault_repair_with_dir(dir, state, io, keychain).await {
            Ok(n) => removed += n,
            // A race that put a `vault.meta` back between the scan and this root
            // refuses that root only; the others are still residue.
            Err(VaultRepairError::VaultPresent) => {}
            Err(VaultRepairError::PartialDelete { remaining_count }) => {
                remaining += remaining_count;
            }
            Err(e) => return Err(e),
        }
    }

    if remaining == 0 {
        Ok(removed)
    } else {
        Err(VaultRepairError::PartialDelete {
            remaining_count: remaining,
        })
    }
}

/// Testable core of [`vault_repair`].
pub(crate) async fn vault_repair_with_dir(
    vault_dir: PathBuf,
    state: &VaultRuntimeState,
    io: &dyn myne_core::vault_io::VaultIo,
    keychain: &dyn myne_core::vault_label::key::LabelKeychain,
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

    // (6) The sweep ran, so `vault.label` is off the live filesystem on either
    //     arm. Destroy the wrap key too, on exactly the arms `vault_delete`'s
    //     `run_post_delete_teardown` runs on and at the same point: after the
    //     sweep, last. Removing the file alone is not an erase, because the
    //     deleted ciphertext stays recoverable from the medium while its key
    //     lives (`decisions.md` 2026-05-07, which rejected platform-specific
    //     secure-delete). The rejection arms above returned before this line,
    //     so a repair that swept nothing destroys nothing. Best-effort by
    //     construction (`forget_label` returns `()`).
    myne_core::vault_label::writeback::forget_label(
        io,
        &vault_dir,
        crate::paths::vault_id_from_root(&vault_dir),
        keychain,
    )
    .await;

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
    fn scan_reports_nothing_on_a_clean_base() {
        let tmp = ScopedTempDir::new("vr-scan-empty").unwrap();
        assert!(vault_residue_scan_from_base(tmp.path()).is_empty());
        assert!(
            vault_residue_scan_from_base(&tmp.path().join("nope")).is_empty(),
            "a missing base scans empty, no error"
        );
    }

    #[test]
    fn scan_reports_one_row_per_root_and_says_which_carry_a_vault_meta() {
        let tmp = ScopedTempDir::new("vr-scan-count").unwrap();

        // A repairable root: residue, no vault.meta.
        let repairable = myne_core::vault_id::VaultId::mint();
        let repairable_root = tmp.path().join("vaults").join(repairable.to_string());
        std::fs::create_dir_all(repairable_root.join("notes")).unwrap();
        std::fs::write(repairable_root.join("notes").join("a.myn"), b"x").unwrap();

        // A root the gate-free sweep must NOT touch.
        let gated = myne_core::vault_id::VaultId::mint();
        let gated_root = tmp.path().join("vaults").join(gated.to_string());
        std::fs::create_dir_all(&gated_root).unwrap();
        std::fs::write(gated_root.join("vault.meta"), b"present").unwrap();

        let rows = vault_residue_scan_from_base(tmp.path());
        assert_eq!(rows.len(), 2, "one row per root, got {rows:?}");

        let repairable_row = rows
            .iter()
            .find(|r| r.vault_id == repairable.to_string())
            .expect("repairable row");
        assert_eq!(repairable_row.entries, 2, "notes/ + notes/a.myn");
        assert!(!repairable_row.has_vault_meta);

        let gated_row = rows
            .iter()
            .find(|r| r.vault_id == gated.to_string())
            .expect("gated row");
        assert_eq!(gated_row.entries, 1);
        assert!(
            gated_row.has_vault_meta,
            "the banner has to be able to say `this one is not cleanable`"
        );
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

    /// An account -> secret map standing in for the OS keychain, so the erase
    /// is assertable where `platform_keychain` has no backend at all (Android,
    /// and the Linux CI runner these tests actually execute on).
    /// `myne-core` has one of these already, but it is `pub(crate)` to that
    /// crate; this is the mobile side's smallest equivalent rather than a
    /// reason to widen a core API. Twin of the desktop plugin's.
    struct ScratchKeychain {
        items: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl ScratchKeychain {
        fn empty() -> Self {
            Self {
                items: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn read(&self, account: &str) -> Option<Vec<u8>> {
            self.items
                .lock()
                .expect("scratch keychain lock")
                .iter()
                .find(|(a, _)| a == account)
                .map(|(_, s)| s.clone())
        }
    }

    impl myne_core::vault_label::key::LabelKeychain for ScratchKeychain {
        fn get(
            &self,
            account: &str,
        ) -> Result<
            Option<zeroize::Zeroizing<Vec<u8>>>,
            myne_core::vault_label::error::VaultLabelError,
        > {
            Ok(self.read(account).map(zeroize::Zeroizing::new))
        }

        fn store(
            &self,
            account: &str,
            secret: &[u8],
        ) -> Result<(), myne_core::vault_label::error::VaultLabelError> {
            let mut items = self.items.lock().expect("scratch keychain lock");
            items.retain(|(a, _)| a != account);
            items.push((account.to_string(), secret.to_vec()));
            Ok(())
        }

        fn delete(
            &self,
            account: &str,
        ) -> Result<(), myne_core::vault_label::error::VaultLabelError> {
            self.items
                .lock()
                .expect("scratch keychain lock")
                .retain(|(a, _)| a != account);
            Ok(())
        }
    }

    /// The precondition tests below care about the sweep, not the label store,
    /// so they get a scratch keychain they never look at. The two that DO care
    /// call `vault_repair_with_dir` directly with their own.
    async fn repair(
        dir: &std::path::Path,
        state: &VaultRuntimeState,
    ) -> Result<usize, VaultRepairError> {
        vault_repair_with_dir(
            dir.to_path_buf(),
            state,
            &myne_core::vault_io::StdVaultIo,
            &ScratchKeychain::empty(),
        )
        .await
    }

    /// A `<base>/vaults/<id>/` root, so `vault_id_from_root` parses a real id
    /// out of the directory name exactly as it does on a device, plus a sealed
    /// `vault.label` for it and the wrap key that opens it.
    async fn seeded_vault_with_label(
        base: &std::path::Path,
        keychain: &ScratchKeychain,
    ) -> (std::path::PathBuf, myne_core::vault_id::VaultId) {
        let id = myne_core::vault_id::VaultId::mint();
        let dir = base.join("vaults").join(id.to_string());
        std::fs::create_dir_all(&dir).expect("vault root");
        myne_core::vault_label::store::write_label(
            &myne_core::vault_io::StdVaultIo,
            &dir,
            id,
            "Work",
            keychain,
        )
        .await
        .expect("seed the cached name");
        assert!(
            keychain.read(&id.to_string()).is_some(),
            "the wrap key must be seeded for this test to mean anything"
        );
        (dir, id)
    }

    /// The erase half of the sweep, and the reason letting the recursive unlink
    /// take `vault.label` with the rest of the residue is not enough: the
    /// deleted ciphertext stays recoverable from the medium, so a surviving
    /// wrap key reads the repaired vault's name straight back out. Twin of the
    /// desktop plugin's test of the same name.
    #[test]
    fn repairing_a_vault_destroys_its_sealed_label_key_and_not_only_its_file() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-label-erase").unwrap();
            let keychain = ScratchKeychain::empty();
            let (dir, id) = seeded_vault_with_label(tmp.path(), &keychain).await;
            seed_residue(&dir);

            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(
                dir.clone(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &keychain,
            )
            .await;
            assert!(
                matches!(result, Ok(n) if n >= 3),
                "expected a completed sweep over vault.label + notes/ + the .myn, got {result:?}"
            );

            assert!(
                !myne_core::vault_label::store::label_path(&dir).exists(),
                "the sweep must have taken the sealed file"
            );
            assert!(
                keychain.read(&id.to_string()).is_none(),
                "the sealed-label wrap key survived the repair. The sweep removed \
                 the ciphertext from the live filesystem and nothing else: those \
                 bytes stay recoverable from the medium, and a live key over them \
                 reads out the name of the vault this repair was supposed to erase."
            );
        });
    }

    /// A repair that swept nothing destroys nothing, so the erase has to sit
    /// after the precondition gates rather than beside them.
    #[test]
    fn a_rejected_repair_does_not_destroy_the_key() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-label-rejected").unwrap();
            let keychain = ScratchKeychain::empty();
            let (dir, id) = seeded_vault_with_label(tmp.path(), &keychain).await;
            seed_residue(&dir);
            // vault.meta byte-present: vault_delete's gated territory, so the
            // repair must reject before the sweep.
            std::fs::write(dir.join("vault.meta"), b"present").unwrap();

            let state = VaultRuntimeState::default();
            let result = vault_repair_with_dir(
                dir.clone(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &keychain,
            )
            .await;
            assert!(
                matches!(result, Err(VaultRepairError::VaultPresent)),
                "the repair must be rejected for this test to mean anything, got {result:?}"
            );

            assert!(
                keychain.read(&id.to_string()).is_some(),
                "a rejected repair left the vault standing, so destroying its key \
                 would blank a live vault's picker row until its next unlock"
            );
            assert!(
                myne_core::vault_label::store::label_path(&dir).exists(),
                "and the sealed file survives with it"
            );
        });
    }

    #[test]
    fn vault_repair_returns_busy_auth_when_permit_held() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-busy").unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().acquire().await.unwrap();
            let result = repair(tmp.path(), &state).await;
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
            let result = repair(tmp.path(), &state).await;
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
            let result = repair(tmp.path(), &state).await;
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
            let result = repair(tmp.path(), &state).await;
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
            // A real `vaults/<id>/` root, because the base-level sweep reads
            // roots off the disk rather than trusting a caller-supplied path.
            let id = myne_core::vault_id::VaultId::mint();
            let root = tmp.path().join("vaults").join(id.to_string());
            std::fs::create_dir_all(&root).unwrap();
            seed_residue(&root);
            assert_eq!(vault_residue_scan_from_base(tmp.path()).len(), 1);
            assert_eq!(vault_residue_scan_from_base(tmp.path())[0].entries, 2);

            let state = VaultRuntimeState::default();
            let result = vault_repair_from_base(
                tmp.path(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &ScratchKeychain::empty(),
            )
            .await;
            assert!(
                matches!(result, Ok(2)),
                "expected Ok(removed=2) matching the scan count, got {result:?}"
            );
            assert!(
                root.exists() && root.is_dir(),
                "the root must be left in place (KeepRoot)"
            );
            assert!(
                vault_residue_scan_from_base(tmp.path()).is_empty(),
                "no residue must remain after a successful repair"
            );
        });
    }

    /// The regression this whole change exists for. Before the per-root scan the
    /// sweep resolved ONE directory through the transitional sole-vault
    /// heuristic, so with a live vault and a pyre root on disk it either swept
    /// the wrong tree or answered `VaultPresent` forever (a banner whose button
    /// can never succeed). Both halves are asserted here: the residue goes, and
    /// the live vault is byte-identical afterwards.
    #[test]
    fn vault_repair_sweeps_the_residue_and_never_touches_a_live_vault_beside_it() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-beside-live").unwrap();

            let live = tmp
                .path()
                .join("vaults")
                .join(myne_core::vault_id::VaultId::mint().to_string());
            std::fs::create_dir_all(live.join("notes")).unwrap();
            std::fs::write(live.join("vault.meta"), b"a real vault.meta").unwrap();
            std::fs::write(live.join("notes").join("keep.myn"), b"precious").unwrap();

            let pyre = tmp
                .path()
                .join("vaults")
                .join(myne_core::vault_id::VaultId::mint().to_string());
            std::fs::create_dir_all(&pyre).unwrap();
            std::fs::write(pyre.join("orphan.myn"), b"junk").unwrap();

            let state = VaultRuntimeState::default();
            let result = vault_repair_from_base(
                tmp.path(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &ScratchKeychain::empty(),
            )
            .await;
            assert!(
                matches!(result, Ok(1)),
                "only the orphan goes, got {result:?}"
            );
            assert!(
                !pyre.join("orphan.myn").exists(),
                "the repairable root's contents are swept"
            );
            assert!(
                pyre.is_dir(),
                "KeepRoot leaves the (now empty) create destination in place"
            );
            assert_eq!(
                std::fs::read(live.join("notes").join("keep.myn")).unwrap(),
                b"precious",
                "a live vault's bytes must be untouched by a gate-free sweep"
            );
            assert!(live.join("vault.meta").exists());
        });
    }

    /// A leftover `vault.meta` is `vault_delete`'s territory, and the sweep has to
    /// SAY so rather than reporting success over nothing: the caller routes it to
    /// the typed-DELETE path on this error code.
    #[test]
    fn vault_repair_rejects_vault_present_when_only_a_meta_bearing_root_is_left() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-only-meta").unwrap();
            let root = tmp
                .path()
                .join("vaults")
                .join(myne_core::vault_id::VaultId::mint().to_string());
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("vault.meta"), b"present").unwrap();
            std::fs::write(root.join("vault.prefs"), b"prefs").unwrap();

            let state = VaultRuntimeState::default();
            let result = vault_repair_from_base(
                tmp.path(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &ScratchKeychain::empty(),
            )
            .await;
            assert!(
                matches!(result, Err(VaultRepairError::VaultPresent)),
                "expected VaultPresent so the UI routes to vault_delete, got {result:?}"
            );
            assert!(root.join("vault.meta").exists(), "the gate held");
        });
    }

    /// The legacy `<base>/vault/` directory is a root too. It is the one a
    /// `vaults/*` walk cannot see, and on a pre-migration install it is the only
    /// place residue can live.
    #[test]
    fn vault_repair_sweeps_the_legacy_root() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-legacy").unwrap();
            let legacy = tmp.path().join("vault");
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join("orphan.myn"), b"junk").unwrap();

            let rows = vault_residue_scan_from_base(tmp.path());
            assert_eq!(rows.len(), 1, "got {rows:?}");
            assert_eq!(
                rows[0].vault_id,
                crate::paths::legacy_vault_id().to_string()
            );

            let state = VaultRuntimeState::default();
            let result = vault_repair_from_base(
                tmp.path(),
                &state,
                &myne_core::vault_io::StdVaultIo,
                &ScratchKeychain::empty(),
            )
            .await;
            assert!(matches!(result, Ok(1)), "got {result:?}");
            assert!(vault_residue_scan_from_base(tmp.path()).is_empty());
        });
    }

    #[test]
    fn vault_repair_meta_present_wins_over_residue() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-meta-wins").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"present").unwrap();
            seed_residue(tmp.path());
            let state = VaultRuntimeState::default();
            let result = repair(tmp.path(), &state).await;
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
