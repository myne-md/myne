// SPDX-License-Identifier: AGPL-3.0
//! `vault_repair` Tauri commands (MYND-159).
//!
//! Two commands:
//! - [`vault_residue_scan`] — the **read-only detection** half. It counts
//!   orphan artefacts left under `<app_data_dir>/vault/` by a partial-fail
//!   `vault_delete` so the Welcome screen can surface a repair banner before
//!   the user enters the create flow. A **pure read**: NO `auth_permits` (a
//!   stale count at worst shows a momentarily-wrong banner, never data loss
//!   — design session "Q2 sharpening #1"), resolving the path via
//!   [`crate::paths::vault_dir_path`] (the non-creating resolver) so probing
//!   a never-created vault has no side effect. The count is the
//!   everything-under-`vault_dir` scope (via
//!   [`crate::vault_sweep::count_residue`]) — exactly what the sweep removes
//!   — so the banner / confirm count never under-reports (the over-capture
//!   safety valve).
//! - [`vault_repair`] — the **destructive sweep**. The exact mirror of
//!   `vault_delete::dispatch_empty_arm`: proceeds only on (slot Empty +
//!   vault.meta byte-absent + residue), `auth_permits`-gated across the
//!   precondition check and the sweep (closed `vault_create` TOCTOU), with
//!   `RootDisposal::KeepRoot` leaving the create-able container behind.
//!   Being that mirror is why it also runs the sealed-label erase
//!   (myne-md/myne#411) once the sweep has run: the sweep is
//!   artefact-agnostic, so it takes `vault.label` off the live filesystem
//!   like any other residue, and a wrap key left alive over ciphertext that
//!   is still recoverable from the medium is the exact combination this
//!   feature argues is not an erase.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use super::error::VaultRepairError;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::vault_sweep::RootDisposal;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

/// Read-only count of orphan residue under the vault directory.
///
/// Returns the number of filesystem entries (files + directories) under
/// `<app_data_dir>/vault/` — 0 when the directory is absent or empty.
/// Takes no `auth_permits` (pure read). Path resolution failure (rare —
/// `app_data_dir` lookup) surfaces as [`VaultRepairError::Io`].
#[tauri::command]
pub async fn vault_residue_scan<R: Runtime>(app: AppHandle<R>) -> Result<usize, VaultRepairError> {
    let vault_dir = crate::paths::vault_dir_path(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    Ok(vault_residue_scan_with_dir(&vault_dir))
}

/// Testable core of [`vault_residue_scan`]. The Tauri-command wrapper
/// resolves the platform-specific vault directory and delegates here so
/// tests do not need a `tauri::AppHandle`.
pub(crate) fn vault_residue_scan_with_dir(vault_dir: &std::path::Path) -> usize {
    crate::vault_sweep::count_residue(vault_dir)
}

/// One-shot in-app cleanup of orphan vault residue.
///
/// The destructive half of the feature, and the exact **mirror** of
/// `vault_delete::dispatch_empty_arm`. Proceeds ONLY when (slot `Empty`
/// AND `vault.meta` **byte-absent** AND residue present); rejects every
/// other state. On success returns the count of entries removed (the
/// "found N → removed N → 0 left" report); on partial-fail returns
/// [`VaultRepairError::PartialDelete`].
///
/// # Precondition matrix
///
/// | State                                          | Behavior                                      |
/// |------------------------------------------------|-----------------------------------------------|
/// | `auth_permits` taken                          | reject `VaultBusyAuth` (try_acquire, no queue)|
/// | slot non-Empty (Unlocked / Recovering)        | reject `VaultPresent` (live session)          |
/// | `vault.meta` byte-present (incl. corrupt)     | reject `VaultPresent` (vault_delete's gate)   |
/// | Empty + meta-absent + no residue              | reject `NothingToRepair` (no silent no-op)    |
/// | Empty + meta-absent + residue                 | sweep (`KeepRoot`) → `Ok(removed)` / Partial  |
///
/// Once the sweep has run (either arm), this vault's sealed-label wrap key is
/// destroyed as well, mirroring `vault_delete`'s `run_post_delete_teardown`.
/// The rejection arms above return before that point, so a repair that touched
/// nothing destroys nothing.
///
/// The permit is held across the precondition check AND the sweep, so a
/// concurrent `vault_create::commit` (also in the permit per MYND-159)
/// cannot write a fresh vault mid-sweep (closed TOCTOU). `vault.meta`
/// presence is **byte-presence** via `try_exists` (divorced from parse;
/// fail-closed on an indeterminate stat) and is evaluated before the
/// residue count, so a corrupt-meta-only directory is rejected, never
/// swept.
#[tauri::command]
pub async fn vault_repair<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<usize, VaultRepairError> {
    let vault_dir = crate::paths::vault_dir_path(&app).map_err(|_| VaultRepairError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;
    vault_repair_with_dir(
        vault_dir,
        state.inner(),
        &myne_core::vault_io::StdVaultIo,
        myne_core::vault_label::key::platform_keychain(),
    )
    .await
}

/// Testable core of [`vault_repair`]. The Tauri-command wrapper resolves
/// the platform-specific vault directory and delegates here so tests do
/// not need a `tauri::AppHandle`.
pub(crate) async fn vault_repair_with_dir(
    vault_dir: PathBuf,
    state: &VaultRuntimeState,
    io: &dyn myne_core::vault_io::VaultIo,
    keychain: &dyn myne_core::vault_label::key::LabelKeychain,
) -> Result<usize, VaultRepairError> {
    // (1) auth_permits gate — try_acquire (reject, never queue), held
    //     across the precondition check AND the sweep so a concurrent
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

    // (2) Slot must be Empty — a non-Empty slot is an active session,
    //     i.e. a live vault (vault_delete's gated territory).
    if state.slot_kind_active().await != SlotKind::Empty {
        tracing::debug!(
            stage = "slot_check",
            error_kind = "VaultPresent",
            "vault_repair rejected: slot non-Empty (active session = live vault)"
        );
        return Err(VaultRepairError::VaultPresent);
    }

    // (3) vault.meta BYTE-presence first (divorced from parse; fail-closed
    //     on an indeterminate stat). Present → live/lost-creds vault,
    //     vault_delete's typed-DELETE-gated territory. This is the
    //     load-bearing safety property — vault_repair structurally cannot
    //     touch a vault that still has a vault.meta.
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
            // Can't determine presence → fail closed (do NOT sweep).
            let io_error_kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::warn!(
                stage = "meta_check",
                io_failure_kind = ?io_error_kind,
                "vault_repair aborted: indeterminate vault.meta byte-presence (fail-closed)"
            );
            return Err(VaultRepairError::Io { io_error_kind });
        }
    }

    // (4) Residue must be present, else there is nothing to repair (no
    //     silent no-op success — the bug-canary discipline). A single
    //     shallow `read_dir` is the cheap probe — any child means "something
    //     to sweep"; an empty OR absent dir means nothing. The sweep below
    //     does the one real recursive walk, so we don't pay a second one
    //     here just to gate.
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
    //     inside spawn_blocking; map the neutral SweepOutcome to the
    //     plugin's own error vocabulary.
    let vault_dir_for_blocking = vault_dir.clone();
    let outcome = match tokio::task::spawn_blocking(move || {
        crate::vault_sweep::sweep(&vault_dir_for_blocking, RootDisposal::KeepRoot)
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

    // (6) The sweep ran, so `vault.label` is gone from the live filesystem
    //     whether the outcome was complete or partial. Destroy this vault's
    //     sealed-label wrap key too, on exactly the arms `vault_delete`'s
    //     `run_post_delete_teardown` runs on (`Ok` or `PartialDelete`), and at
    //     the same point: after the sweep, last.
    //
    //     Removing the file alone is NOT an erase. `vault_label::store`'s own
    //     header says it: the ciphertext it deletes stays recoverable from the
    //     medium while its key lives (`decisions.md` 2026-05-07 settled that
    //     when it rejected platform-specific secure-delete). Leaving the key
    //     behind here would leave a live key over recoverable ciphertext
    //     carrying a name a person recognises, which is the one thing the
    //     per-`VaultId` erase guarantee is supposed to rule out.
    //
    //     The id comes from the directory name, which is how every other
    //     root-taking caller derives it; a legacy `vault/` root resolves to the
    //     legacy sentinel, the same id its label was sealed under.
    //
    //     Best-effort by construction (`forget_label` returns `()`): a keychain
    //     that is unavailable must not turn a completed repair into a failure.
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
        // notes/ + a.myn + b.myn + vault.meta.tmp = 4.
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

    // ---- sweep command: precondition matrix (Task 4) --------------------

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Seed a single orphan `.myn` under `notes/` (no `vault.meta`) — the
    /// canonical post-partial-fail residue shape.
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
    /// is assertable on a machine that has none (which is what CI runs on, and
    /// what `platform_keychain` answers `KeychainUnavailable` from off Apple
    /// platforms). `myne-core` has one of these already, but it is
    /// `pub(crate)` to that crate; this is the desktop side's smallest
    /// equivalent rather than a reason to widen a core API.
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

    /// The seven precondition tests below care about the sweep, not the label
    /// store, so they get a scratch keychain they never look at. The two that
    /// DO care call `vault_repair_with_dir` directly with their own.
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
    /// out of the directory name exactly as it does in production, plus a
    /// sealed `vault.label` for it and the wrap key that opens it.
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

    /// The erase half of the sweep, and the reason it is not enough to let the
    /// recursive unlink take `vault.label` with the rest of the residue: the
    /// deleted ciphertext stays recoverable from the medium, so a surviving
    /// wrap key reads the repaired vault's name straight back out.
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

    /// The mirror of `vault_delete`'s `a_rejected_delete_does_not_destroy_the_key`:
    /// a repair that swept nothing destroys nothing, so the erase has to sit
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
            // Corrupt / unparseable vault.meta bytes — byte-presence, NOT
            // parseability, is the test. Must reject (vault_delete's gate).
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
            // CRITICAL: the residue must NOT have been swept — meta-first
            // evaluation means a corrupt-meta dir is preserved, never nuked.
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
            // Empty dir, slot Empty, no vault.meta, no residue.
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
            seed_residue(tmp.path());
            // notes/ + the .myn = 2 entries.
            let scanned = vault_residue_scan_with_dir(tmp.path());
            assert_eq!(scanned, 2);

            let state = VaultRuntimeState::default();
            let result = repair(tmp.path(), &state).await;
            assert!(
                matches!(result, Ok(2)),
                "expected Ok(removed=2) matching the scan count, got {result:?}"
            );
            // KeepRoot: the container survives and is create-able again.
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

    /// Meta-present must win over residue-present: even when there IS
    /// residue, a present `vault.meta` rejects (VaultPresent) and the
    /// residue is preserved. The complement of the partition with
    /// `vault_delete`, and the corrupt-meta safety guarantee.
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

    #[cfg(unix)]
    #[test]
    fn vault_repair_partial_fail_returns_partial_delete_and_keeps_dir() {
        use std::os::unix::fs::PermissionsExt;
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vr-partial").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("a.myn"), b"x").unwrap();
            // chmod 0o555 on notes/ blocks the .myn unlink → partial-fail.
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            let state = VaultRuntimeState::default();
            let result = repair(tmp.path(), &state).await;

            // Restore perms for teardown.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            match result {
                Err(VaultRepairError::PartialDelete { remaining_count }) => {
                    assert!(
                        remaining_count >= 1,
                        "expected >=1 failure, got {remaining_count}"
                    );
                }
                other => panic!("expected PartialDelete, got {other:?}"),
            }
            assert!(
                tmp.path().exists(),
                "KeepRoot must leave the container even on partial-fail"
            );
        });
    }

    // ---- wire-shape for the Task 4 variants ------------------------------

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
