// SPDX-License-Identifier: AGPL-3.0
//! `vault_export_markdown` — decrypt the whole vault (or one folder
//! subtree) into a plaintext Obsidian-shape markdown tree (MYND-211).
//!
//! The walk itself lives in `myne-format` (`export_walk`) so the
//! `myne-decrypt` CLI runs the same export the desktop app runs. This module
//! keeps the host-coupled half: the slot lifecycle (permit → peek → quiesce),
//! the `AppHandle`-generic `#[tauri::command]` wrappers, the progress
//! forwarder, and the `ExportHooks` (tokio `mpsc` + `AtomicBool`) that
//! implements the walk's `ExportHooks` trait.
//!
//! Concurrency discipline (the backup engine's SYNC-6 sequence):
//! 1. `try_acquire` the capacity-1 `auth_permits` lifecycle permit —
//!    reject-never-queue; held for the WHOLE export.
//! 2. Clone the slot material ONCE (`peek_unlocked_attachment_material`).
//! 3. Take the writer-quiescence guard for the READ pass.
//! 4. Drop the guard; decrypt the immutable blobs; publish via ONE rename.
//!
//! Logging: counts-only; no paths, no titles, no note/attachment ids.

use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_id::VaultId;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

pub use myne_format::export_error::{vault_export_error_kind, VaultExportError};
pub use myne_format::export_walk::VaultExportSummary;

/// Side-channel hooks for the long-running export passes — counts-only
/// progress ticks and cooperative cancellation. Implements the walk's
/// `ExportHooks` trait.
#[derive(Default, Clone)]
pub struct ExportHooks {
    /// Progress sink — `(done, total, phase)` where phase is `"notes"`
    /// or `"attachments"`. Never paths, never ids (DENY list).
    pub progress: Option<tokio::sync::mpsc::UnboundedSender<(u32, u32, &'static str)>>,
    /// Cooperative cancel flag (set by [`vault_export_cancel`]).
    pub cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl ExportHooks {
    /// Throttled progress tick: emit every 25th item, plus the FIRST
    /// item of a phase (`done == 1`) and the final `done == total`.
    fn tick(&self, done: u32, total: u32, phase: &'static str) {
        if done != 1 && done != total && !done.is_multiple_of(25) {
            return;
        }
        if let Some(tx) = &self.progress {
            let _ = tx.send((done, total, phase));
        }
    }

    /// Clear the cancel flag — called only AFTER the lifecycle permit
    /// is ours.
    fn reset_cancel(&self) {
        if let Some(flag) = &self.cancelled {
            flag.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

impl myne_format::export_walk::ExportHooks for ExportHooks {
    fn tick(&self, done: u32, total: u32, phase: &'static str) {
        ExportHooks::tick(self, done, total, phase);
    }

    fn check_cancel(&self) -> Result<(), VaultExportError> {
        match &self.cancelled {
            Some(flag) if flag.load(std::sync::atomic::Ordering::Relaxed) => {
                Err(VaultExportError::Cancelled)
            }
            _ => Ok(()),
        }
    }
}

/// `export://progress` — counts-only payload (DENY-list: no paths, no
/// titles, no ids). Mirrored on the TS side as `VaultExportProgress`.
pub(crate) const EXPORT_PROGRESS_EVENT: &str = "export://progress";

/// Payload for [`EXPORT_PROGRESS_EVENT`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExportProgressPayload {
    pub done: u32,
    pub total: u32,
    pub phase: &'static str,
}

/// Per-app export runtime: the cooperative cancel flag
/// [`vault_export_cancel`] sets.
#[derive(Default)]
pub struct ExportRuntime {
    pub(crate) cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) fn export_runtime<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, ExportRuntime> {
    use tauri::Manager;
    app.state::<ExportRuntime>()
}

/// Cancel the in-flight markdown export, if any. Idempotent.
#[tauri::command]
pub fn vault_export_cancel<R: Runtime>(app: AppHandle<R>) {
    export_runtime(&app)
        .cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(event = "vault_export_cancel_requested");
}

/// Export the vault at `vault_id` (explicit id, else the ACTIVE unlocked
/// vault) as a plaintext markdown tree at `destination`.
#[tauri::command]
pub async fn vault_export_markdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    vault_id: Option<String>,
    destination: String,
    scope: Option<String>,
) -> Result<VaultExportSummary, VaultExportError> {
    let target = match VaultId::parse_optional(vault_id.as_deref()) {
        Some(id) => Some(id),
        None => state.active_vault_id().await,
    };
    let vault_dir = crate::paths::vault_root_for_id_optional(&app, target).map_err(|_| {
        VaultExportError::Io {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    let app_data = crate::paths::app_data_dir(&app).map_err(|_| VaultExportError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    let forbidden_roots = vec![app_data, vault_dir.clone()];

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32, &'static str)>();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        while let Some((done, total, phase)) = rx.recv().await {
            let _ = emitter.emit(
                EXPORT_PROGRESS_EVENT,
                ExportProgressPayload { done, total, phase },
            );
        }
    });
    let runtime = export_runtime(&app);
    let hooks = ExportHooks {
        progress: Some(tx),
        cancelled: Some(runtime.cancel.clone()),
    };

    let result = vault_export_core(
        vault_dir,
        forbidden_roots,
        state.inner(),
        PathBuf::from(destination),
        scope,
        hooks,
    )
    .await;

    match &result {
        Ok(summary) => {
            tracing::info!(
                event = "vault_exported_markdown",
                notes = summary.notes,
                attachments = summary.attachments,
                folders = summary.folders,
                excluded_trashed = summary.excluded_trashed,
                excluded_snapshots = summary.excluded_snapshots,
                "vault markdown export published"
            );
        }
        Err(e) => {
            tracing::warn!(
                stage = "vault_export_markdown",
                error_kind = vault_export_error_kind(e),
                "vault markdown export failed"
            );
        }
    }
    result
}

/// Async core of [`vault_export_markdown`] — testable without an
/// `AppHandle`. Owns the permit → peek → quiesce(stage) → unguarded
/// attachments + publish sequence, delegating the walk to `myne-format`.
pub(crate) async fn vault_export_core(
    vault_dir: PathBuf,
    forbidden_roots: Vec<PathBuf>,
    state: &VaultRuntimeState,
    destination: PathBuf,
    scope: Option<String>,
    hooks: ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| VaultExportError::AuthOperationInProgress)?;
    hooks.reset_cancel();

    let Some((items_key, items_key_id, shared)) = state.peek_unlocked_attachment_material().await
    else {
        tracing::debug!(
            stage = "slot_check",
            outcome = "vault_locked",
            "vault_export rejected: no unlocked vault"
        );
        return Err(VaultExportError::VaultNotUnlocked);
    };

    let scope = myne_format::export_walk::normalize_scope(scope.as_deref());

    let quiesce = state.quiesce_writers().await;
    let version = std::fs::read(vault_dir.join("vault.meta"))
        .ok()
        .and_then(|b| protocol::meta_version_of(&b))
        .unwrap_or(protocol::MetaVersion::V0_1);
    let params = myne_format::export_walk::StageParams {
        vault_dir: vault_dir.clone(),
        forbidden_roots,
        destination: destination.clone(),
        scope,
        items_key: items_key.clone(),
        items_key_id,
        root_key: shared.owner_root_bytes(),
        group_key: shared.group_bytes(),
        version,
        trashed: myne_format::export_walk::TrashedMode::Exclude,
        best_effort: false,
        history: false,
    };
    let stage_hooks = hooks.clone();
    let staged = tokio::task::spawn_blocking(move || {
        myne_format::export_walk::stage_export_tree(params, &stage_hooks)
    })
    .await
    .map_err(|_| {
        if let Some(staging) = myne_format::export_walk::staging_sibling(&destination) {
            let _ = std::fs::remove_dir_all(staging);
        }
        VaultExportError::JoinFailure
    })??;
    drop(quiesce);

    let staging_for_cleanup = staged.staging_path().to_path_buf();
    let finalize_hooks = hooks.clone();
    let summary = tokio::task::spawn_blocking(move || {
        myne_format::export_walk::finalize_export(
            staged,
            &vault_dir,
            items_key,
            items_key_id,
            &finalize_hooks,
        )
    })
    .await
    .map_err(|_| {
        let _ = std::fs::remove_dir_all(&staging_for_cleanup);
        VaultExportError::JoinFailure
    })??;
    Ok(summary)
}

// see: ../../AGENTS.md "Secret-handling logging discipline"

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::attachments::commands::{attachment_import_with_dir, ImportSource};
    use crate::plugins::notes::commands::note_create_with_dir;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;

    const SEED_ROOT: u8 = 0x07;
    const SEED_ITEMS: u8 = 0x09;
    const SEED_ITEMS_ID: u8 = 0x01;

    /// Sniffable PNG payloads with distinct tails (distinct
    /// content-addressed ids) — the notes-plugin export fixture bytes.
    const ATT_PNG_A: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xA1, 0xA2];
    const ATT_PNG_B: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xB1, 0xB2];

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Seed a parse-passing `vault.meta` (the prefs/catalog AAD identity
    /// source) — mirror of the notes plugin's export seeder.
    fn seed_vault_meta(vault_root: &Path) {
        let meta = protocol::VaultMeta {
            account_number_hash: [0x33; protocol::VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
            person_binding: None,
        };
        fs::write(
            vault_root.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    /// Scratch vault (`<scratch>/vault/` with vault.meta + notes/) plus
    /// an unlocked runtime state keyed to the fixture material.
    async fn vault_fixture(slug: &str) -> (ScopedTempDir, PathBuf, VaultRuntimeState) {
        let scratch = ScopedTempDir::new(slug).unwrap();
        let vault_dir = scratch.path().join("vault");
        fs::create_dir_all(&vault_dir).unwrap();
        crate::paths::notes_dir_under(&vault_dir).unwrap();
        seed_vault_meta(&vault_dir);
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(SEED_ROOT, SEED_ITEMS, SEED_ITEMS_ID),
            )
            .await;
        (scratch, vault_dir, state)
    }

    async fn add_note(vault_dir: &Path, state: &VaultRuntimeState, plaintext: &str) -> String {
        note_create_with_dir(
            vault_dir.join("notes"),
            state,
            plaintext.to_string(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("fixture note create must succeed")
    }

    async fn import_att(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        bytes: &[u8],
        filename: &str,
    ) -> String {
        attachment_import_with_dir(
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new("/nonexistent-export-test-host"),
            vault_dir,
            state,
            ImportSource::Bytes {
                bytes: bytes.to_vec(),
                filename: Some(filename.to_string()),
            },
            crate::plugins::attachments::commands::scope_for_wire(None),
        )
        .await
        .expect("fixture attachment import must succeed")
        .id
    }

    async fn export(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        dest: &Path,
        scope: Option<&str>,
    ) -> Result<VaultExportSummary, VaultExportError> {
        vault_export_core(
            vault_dir.to_path_buf(),
            vec![vault_dir.to_path_buf()],
            state,
            dest.to_path_buf(),
            scope.map(str::to_string),
            ExportHooks::default(),
        )
        .await
    }

    /// No `*.staging-*` sibling may remain next to `dest` — the
    /// discard-on-every-path contract.
    fn assert_no_staging_residue(dest: &Path) {
        let parent = dest.parent().unwrap();
        let residue: Vec<String> = fs::read_dir(parent)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".staging-"))
            .collect();
        assert!(residue.is_empty(), "staging residue left: {residue:?}");
    }

    /// Relative paths of every file under `root`, sorted.
    fn tree_files(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, "", &mut out);
        out.sort();
        out
    }

    const UPDATED_EPOCH: u64 = 1_781_172_000; // 2026-06-11T10:00:00Z

    // ---- tree-shape golden ------------------------------------------------

    #[test]
    fn whole_vault_tree_shape_golden() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-golden").await;

            let alpha_body = "---\ntitle: Alpha\nfolder: Projects/\nupdated: 2026-06-11T10:00:00Z\n---\n\n# Alpha\n\nbody with trailing spaces   \nno trailing newline";
            add_note(&vault_dir, &state, alpha_body).await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody one",
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody two",
            )
            .await;
            add_note(&vault_dir, &state, "no frontmatter, root note").await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Tpl\ntemplate: true\n---\ntemplate body",
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Gone\ntrashed: 2026-06-01T00:00:00Z\n---\ntrashed body",
            )
            .await;
            // Snapshots are never enumerated — counted from the listing.
            fs::create_dir_all(vault_dir.join("snapshots")).unwrap();
            fs::write(vault_dir.join("snapshots/a.myn"), b"snap-a").unwrap();
            fs::write(vault_dir.join("snapshots/b.myn"), b"snap-b").unwrap();
            fs::write(vault_dir.join("snapshots/.DS_Store"), b"junk").unwrap();
            // Deliberate empty folders from prefs (one nested, one that
            // already exists through a note's folder — no double count).
            crate::plugins::prefs::commands::set_deliberate_folders_with_dir(
                &vault_dir,
                &state,
                &(std::sync::Arc::new(crate::hooks::NoopHooks) as crate::hooks::Hooks),
                crate::plugins::prefs::set_mutation::SetMutation::adding_all(vec!["Empty/Nested/".to_string(), "Projects/".to_string()]),
            &crate::vault_io::StdVaultIo, &crate::host::NoopHost,)
            .await
            .expect("deliberate folders write");

            let dest = scratch.path().join("export-tree");
            let summary = export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");

            assert_eq!(summary.notes, 5);
            assert_eq!(summary.attachments, 0);
            assert_eq!(summary.excluded_trashed, 1);
            assert_eq!(summary.excluded_snapshots, 2);
            // Projects, Projects/Sub, Empty, Empty/Nested.
            assert_eq!(summary.folders, 4);

            // Tree shape: dup pair suffixed deterministically; template
            // included like any note; trashed + snapshots absent.
            let files = tree_files(&dest);
            assert_eq!(
                files,
                vec![
                    "Projects/Alpha.md".to_string(),
                    "Projects/Sub/Dup (1).md".to_string(),
                    "Projects/Sub/Dup.md".to_string(),
                    "Tpl.md".to_string(),
                    "Untitled.md".to_string(),
                ]
            );
            assert!(dest.join("Empty/Nested").is_dir());

            // Byte-verbatim body (frontmatter included, no trailing
            // newline normalization).
            assert_eq!(
                fs::read(dest.join("Projects/Alpha.md")).unwrap(),
                alpha_body.as_bytes()
            );
            // Both dup bodies present (creation-order assignment of the
            // suffix is UUIDv7-sort-dependent within one millisecond, so
            // assert the set).
            let dup_bodies: std::collections::BTreeSet<Vec<u8>> = [
                fs::read(dest.join("Projects/Sub/Dup.md")).unwrap(),
                fs::read(dest.join("Projects/Sub/Dup (1).md")).unwrap(),
            ]
            .into_iter()
            .collect();
            let expected: std::collections::BTreeSet<Vec<u8>> = [
                b"---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody one".to_vec(),
                b"---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody two".to_vec(),
            ]
            .into_iter()
            .collect();
            assert_eq!(dup_bodies, expected);

            // mtime mapped from `updated:` (SYNC-13).
            let mtime = fs::metadata(dest.join("Projects/Alpha.md"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            assert_eq!(mtime, UPDATED_EPOCH);

            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- gates ------------------------------------------------------------

    #[test]
    fn locked_vault_is_rejected_with_nothing_written() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("ve-locked").unwrap();
            let vault_dir = scratch.path().join("vault");
            fs::create_dir_all(&vault_dir).unwrap();
            crate::paths::notes_dir_under(&vault_dir).unwrap();
            seed_vault_meta(&vault_dir);
            let state = VaultRuntimeState::default(); // nothing unlocked
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::VaultNotUnlocked)
            ));
            assert!(!dest.exists());
            assert_no_staging_residue(&dest);
        });
    }

    #[test]
    fn export_rejects_while_auth_permit_is_held() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-permit").await;
            let dest = scratch.path().join("export-tree");
            let held = state.auth_permits().try_acquire().expect("permit");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::AuthOperationInProgress)
            ));
            drop(held);
            export(&vault_dir, &state, &dest, None)
                .await
                .expect("export proceeds once the permit is free");
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn missing_vault_meta_is_vault_not_found() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-nometa").await;
            fs::remove_file(vault_dir.join("vault.meta")).unwrap();
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::VaultNotFound)
            ));
            assert!(!dest.exists());
        });
    }

    // ---- destination validation -------------------------------------------

    #[test]
    fn destination_with_missing_parent_is_invalid() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-noparent").await;
            let dest = scratch.path().join("no-such-dir").join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::InvalidDestination)
            ));
        });
    }

    #[test]
    fn existing_destination_is_rejected_never_merged() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-exists").await;
            let dest = scratch.path().join("export-tree");
            fs::create_dir_all(&dest).unwrap();
            fs::write(dest.join("keep.txt"), b"pre-existing").unwrap();
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::DestinationAlreadyExists)
            ));
            // The existing directory is untouched.
            assert_eq!(fs::read(dest.join("keep.txt")).unwrap(), b"pre-existing");
            assert_no_staging_residue(&dest);
        });
    }

    /// 115-F1 at the destination parent: a pre-existing USER directory
    /// that happens to carry the `<dest>.staging-<pid>` name fails the
    /// export closed (`create_dir` create-new semantics) instead of
    /// being `remove_dir_all`'d — the user's directory and its contents
    /// survive intact.
    #[test]
    fn preexisting_dir_at_staging_name_fails_closed_and_survives() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-staging-clash").await;
            add_note(&vault_dir, &state, "---\ntitle: Fine\n---\nbody").await;
            let dest = scratch.path().join("export-tree");
            let clash = myne_format::export_walk::staging_sibling(&dest).expect("staging name");
            fs::create_dir_all(&clash).unwrap();
            fs::write(clash.join("precious.txt"), b"user data, not residue").unwrap();

            let result = export(&vault_dir, &state, &dest, None).await;
            assert!(
                matches!(result, Err(VaultExportError::Io { .. })),
                "a name clash at the staging sibling must fail closed, got {result:?}"
            );
            assert!(!dest.exists(), "nothing may appear at the destination");
            // The user's directory is byte-intact — never reclaimed.
            assert_eq!(
                fs::read(clash.join("precious.txt")).unwrap(),
                b"user data, not residue"
            );
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn destination_inside_forbidden_roots_is_rejected() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-forbidden").await;
            // Inside the vault root itself.
            let inside_vault = vault_dir.join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &inside_vault, None).await,
                Err(VaultExportError::DestinationNotAllowed)
            ));
            // Inside a simulated app data dir passed as forbidden root.
            let app_data = scratch.path().join("appdata");
            fs::create_dir_all(app_data.join("somewhere")).unwrap();
            let result = vault_export_core(
                vault_dir.clone(),
                vec![app_data.clone(), vault_dir.clone()],
                &state,
                app_data.join("somewhere").join("export-tree"),
                None,
                ExportHooks::default(),
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultExportError::DestinationNotAllowed)
            ));
        });
    }

    // ---- failure + cancel discard staging ----------------------------------

    #[test]
    fn injected_decrypt_failure_leaves_nothing_at_destination() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-fail").await;
            add_note(&vault_dir, &state, "---\ntitle: Fine\n---\nok body").await;
            // A forged garbage blob under a valid UUIDv7 name fails the
            // AEAD honestly mid-loop.
            let forged = crate::plugins::notes::note_id::NoteId::new_v7();
            fs::write(
                vault_dir
                    .join("notes")
                    .join(format!("{}.myn", forged.as_uuid())),
                b"not a real MY01 blob",
            )
            .unwrap();

            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::CannotDecrypt)
            ));
            assert!(!dest.exists(), "failure must leave nothing at destination");
            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn cancelled_export_discards_staging_and_publishes_nothing() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-cancel").await;
            for i in 0..12 {
                add_note(
                    &vault_dir,
                    &state,
                    &format!("---\ntitle: Note {i}\n---\nbody {i}"),
                )
                .await;
            }
            let dest = scratch.path().join("export-tree");
            // Cancel via the first progress tick (a pre-set flag would be
            // wiped by the post-permit reset — the backup discipline).
            let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (tx, mut prx) = tokio::sync::mpsc::unbounded_channel();
            let canceller = flag.clone();
            tokio::spawn(async move {
                if prx.recv().await.is_some() {
                    canceller.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            });
            let hooks = ExportHooks {
                progress: Some(tx),
                cancelled: Some(flag),
            };
            let result = vault_export_core(
                vault_dir.clone(),
                vec![vault_dir.clone()],
                &state,
                dest.clone(),
                None,
                hooks,
            )
            .await;
            assert!(matches!(result, Err(VaultExportError::Cancelled)));
            assert!(!dest.exists(), "cancel must publish nothing");
            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- attachments: dedup-once + embed rewrite ----------------------------

    #[test]
    fn attachments_export_once_with_dedup_and_embed_rewrite() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att").await;
            // Two DISTINCT blobs sharing one catalog display name → the
            // tree-level suffix dedup; one blob referenced by TWO notes
            // → exported once.
            let id_a = import_att(&vault_dir, &state, ATT_PNG_A, "photo.png").await;
            let id_b = import_att(&vault_dir, &state, ATT_PNG_B, "photo.png").await;

            add_note(
                &vault_dir,
                &state,
                &format!(
                    "---\ntitle: First\n---\nsee ![[att:{id_a}|photo.png]] and ![[att:{id_b}]] end"
                ),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Second\n---\nagain ![[att:{id_a}]]"),
            )
            .await;
            let verbatim = "---\ntitle: Plain\n---\nno embeds at all";
            add_note(&vault_dir, &state, verbatim).await;

            let dest = scratch.path().join("export-tree");
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let hooks = ExportHooks {
                progress: Some(tx),
                cancelled: None,
            };
            let summary = vault_export_core(
                vault_dir.clone(),
                vec![vault_dir.clone()],
                &state,
                dest.clone(),
                None,
                hooks,
            )
            .await
            .expect("attachment export must publish");

            assert_eq!(summary.notes, 3);
            assert_eq!(
                summary.attachments, 2,
                "one blob, one file — even when referenced twice"
            );

            // Deterministic first-reference naming: id_a (first embed of
            // the first note) keeps the bare name; id_b suffixes.
            assert_eq!(
                fs::read(dest.join("attachments/photo.png")).unwrap(),
                ATT_PNG_A
            );
            assert_eq!(
                fs::read(dest.join("attachments/photo (1).png")).unwrap(),
                ATT_PNG_B
            );

            // Embeds rewritten to the final names; everything else
            // byte-preserved.
            assert_eq!(
                fs::read(dest.join("First.md")).unwrap(),
                b"---\ntitle: First\n---\nsee ![[photo.png]] and ![[photo (1).png]] end"
            );
            assert_eq!(
                fs::read(dest.join("Second.md")).unwrap(),
                b"---\ntitle: Second\n---\nagain ![[photo.png]]"
            );
            // A note without embeds stays byte-verbatim.
            assert_eq!(
                fs::read(dest.join("Plain.md")).unwrap(),
                verbatim.as_bytes()
            );

            // Progress: notes phase then attachments phase, counts-only,
            // ending with the full attachments count.
            let mut events: Vec<(u32, u32, &'static str)> = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
            assert!(events.iter().any(|(_, _, p)| *p == "notes"));
            assert_eq!(events.last().copied(), Some((2, 2, "attachments")));
        });
    }

    /// 115-F1 variant 2 inside the staging tree: an attachment whose
    /// FINAL name is `x.png.tmp`, written before its `x.png` sibling,
    /// used to be destroyed by the later write's fixed-name temp —
    /// leaving the published tree with a dangling embed. Both files
    /// must land intact.
    #[test]
    fn attachment_with_tmp_shaped_final_name_survives_its_sibling() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att-tmpname").await;
            // First reference order writes "x.png.tmp" FIRST.
            let id_tmpish = import_att(&vault_dir, &state, ATT_PNG_A, "x.png.tmp").await;
            let id_plain = import_att(&vault_dir, &state, ATT_PNG_B, "x.png").await;
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: N\n---\na ![[att:{id_tmpish}]] b ![[att:{id_plain}]] c"),
            )
            .await;

            let dest = scratch.path().join("export-tree");
            let summary = export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");
            assert_eq!(summary.attachments, 2);

            assert_eq!(
                fs::read(dest.join("attachments/x.png.tmp")).unwrap(),
                ATT_PNG_A
            );
            assert_eq!(fs::read(dest.join("attachments/x.png")).unwrap(), ATT_PNG_B);
            assert_eq!(
                fs::read(dest.join("N.md")).unwrap(),
                b"---\ntitle: N\n---\na ![[x.png.tmp]] b ![[x.png]] c"
            );
        });
    }

    #[test]
    fn missing_referenced_attachment_fails_the_whole_export() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att-missing").await;
            let ghost = "ab".repeat(32); // valid shape, never imported
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Ghost\n---\n![[att:{ghost}]]"),
            )
            .await;
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::AttachmentMissing)
            ));
            assert!(
                !dest.exists(),
                "skip-nothing-silently: missing attachment fails closed"
            );
            assert_no_staging_residue(&dest);
        });
    }

    // ---- subtree scope -------------------------------------------------------

    #[test]
    fn subtree_scope_exports_exactly_the_subtree_and_its_attachments() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-scope").await;
            let id_in = import_att(&vault_dir, &state, ATT_PNG_A, "in.png").await;
            let id_out = import_att(&vault_dir, &state, ATT_PNG_B, "out.png").await;

            // In scope "A/": the scope root itself + a nested child.
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: AtRoot\nfolder: A/\n---\nref ![[att:{id_in}]] plus an out-of-scope wikilink [[C/Other]] kept verbatim"),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Nested\nfolder: A/B/\n---\nnested body",
            )
            .await;
            // Out of scope: sibling folder, lookalike prefix, root note.
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Other\nfolder: C/\n---\n![[att:{id_out}]]"),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Lookalike\nfolder: AB/\n---\nnot under A/",
            )
            .await;
            add_note(&vault_dir, &state, "---\ntitle: Root\n---\nroot body").await;
            // Deliberate folders: one under scope, one outside.
            crate::plugins::prefs::commands::set_deliberate_folders_with_dir(
                &vault_dir,
                &state,
                &(std::sync::Arc::new(crate::hooks::NoopHooks) as crate::hooks::Hooks),
                crate::plugins::prefs::set_mutation::SetMutation::adding_all(vec!["A/Empty/".to_string(), "C/Empty/".to_string()]),
            &crate::vault_io::StdVaultIo, &crate::host::NoopHost,)
            .await
            .expect("deliberate folders write");

            let dest = scratch.path().join("subtree-tree");
            let summary = export(&vault_dir, &state, &dest, Some("A/"))
                .await
                .expect("subtree export must publish");

            assert_eq!(summary.notes, 2);
            assert_eq!(summary.attachments, 1, "only attachments referenced by included notes");
            // B (note folder) + Empty (deliberate) — relativized.
            assert_eq!(summary.folders, 2);

            let files = tree_files(&dest);
            assert_eq!(
                files,
                vec![
                    "AtRoot.md".to_string(),
                    "B/Nested.md".to_string(),
                    "attachments/in.png".to_string(),
                ]
            );
            assert!(dest.join("Empty").is_dir());
            // Out-of-scope wikilink untouched; in-scope embed rewritten.
            assert_eq!(
                fs::read(dest.join("AtRoot.md")).unwrap(),
                b"---\ntitle: AtRoot\nfolder: A/\n---\nref ![[in.png]] plus an out-of-scope wikilink [[C/Other]] kept verbatim"
            );
        });
    }

    // ---- round-trip approximation (importer-inversion invariants) ------------

    #[test]
    fn round_trip_invariants_hold_over_the_exported_tree() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-roundtrip").await;
            let id = import_att(&vault_dir, &state, ATT_PNG_A, "photo.png").await;

            let originals: Vec<&str> = vec![
                "---\ntitle: Root Note\nupdated: 2026-06-11T10:00:00Z\n---\nroot body",
                "---\ntitle: Inner\nfolder: A/B/\n---\ninner body, no trailing newline",
                "---\ntitle: report.md\nfolder: A/\n---\ndotted title round-trips via strip-one-.md",
            ];
            for p in &originals {
                add_note(&vault_dir, &state, p).await;
            }
            let embedded =
                format!("---\ntitle: Embedded\nfolder: A/\n---\nsee ![[att:{id}|photo.png]] end");
            add_note(&vault_dir, &state, &embedded).await;

            let dest = scratch.path().join("export-tree");
            export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");

            let mut seen = 0;
            for rel in tree_files(&dest) {
                if rel.starts_with("attachments/") {
                    continue;
                }
                seen += 1;
                let bytes = fs::read(dest.join(&rel)).unwrap();

                // (1) Tree location == FM `folder:` — the equality the
                // importer's SYNC-8 preexistingFolder guard suppresses on
                // (quiet re-import).
                let slices = myne_format::notes::title_extract::extract_title_slices(&bytes);
                let fm_dir = slices
                    .frontmatter_bytes
                    .and_then(myne_format::notes::title_extract::fm_folder);
                let tree_dir = rel.rfind('/').map(|cut| format!("{}/", &rel[..cut]));
                assert_eq!(fm_dir, tree_dir, "folder/location mismatch for {rel}");

                // (2) Filename strips exactly one `.md` back to the FM
                // title (the importer's deriveImportTitle inversion).
                let filename = rel.rsplit('/').next().unwrap();
                let derived_title = filename.strip_suffix(".md").unwrap();
                let fm_t = slices
                    .frontmatter_bytes
                    .and_then(myne_format::notes::title_extract::fm_title)
                    .unwrap_or_else(|| "Untitled".to_string());
                assert_eq!(derived_title, fm_t, "title inversion failed for {rel}");

                // (3) Bodies byte-faithful modulo the documented embed
                // rewrite.
                let text = String::from_utf8(bytes.clone()).unwrap();
                if text.contains("Embedded") {
                    assert_eq!(
                        text,
                        "---\ntitle: Embedded\nfolder: A/\n---\nsee ![[photo.png]] end"
                    );
                } else {
                    assert!(
                        originals.iter().any(|o| o.as_bytes() == bytes.as_slice()),
                        "non-embed note must be byte-verbatim: {rel}"
                    );
                }
            }
            assert_eq!(seen, 4);
        });
    }

    // ---- helpers ---------------------------------------------------------

    #[test]
    fn scope_normalization_and_prefix_matching() {
        use myne_format::export_walk::{normalize_scope, strip_scope_prefix};
        assert_eq!(normalize_scope(None), None);
        assert_eq!(normalize_scope(Some("")), None);
        assert_eq!(normalize_scope(Some("/")), None);
        assert_eq!(
            normalize_scope(Some("A/B/")),
            Some(vec!["A".to_string(), "B".to_string()])
        );
        // Trailing-slashless input normalizes identically.
        assert_eq!(normalize_scope(Some("A/B")), normalize_scope(Some("A/B/")));

        let prefix = vec!["A".to_string()];
        let inside = vec!["A", "B"];
        assert_eq!(strip_scope_prefix(&inside, &prefix), Some(&["B"][..]));
        let exact = vec!["A"];
        assert_eq!(strip_scope_prefix(&exact, &prefix), Some(&[][..]));
        let lookalike = vec!["AB"];
        assert_eq!(strip_scope_prefix(&lookalike, &prefix), None);
        let root: Vec<&str> = vec![];
        assert_eq!(strip_scope_prefix(&root, &prefix), None);
    }

    #[test]
    fn pick_deduped_suffixes_deterministically() {
        use myne_format::export_naming::export_dedup_key as dedup_key;
        use myne_format::export_walk::pick_deduped;
        let mut names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup.md");
        names.insert(dedup_key("Dup.md"));
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup (1).md");
        names.insert(dedup_key("Dup (1).md"));
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup (2).md");
    }

    // ── myne#311: the volume is case-insensitive; the oracle was not ───────

    #[test]
    fn the_dedup_oracle_folds_case_so_a_case_differing_pair_is_suffixed() {
        use myne_format::export_naming::export_dedup_key as dedup_key;
        use myne_format::export_walk::pick_deduped;
        let mut names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "README.md").unwrap(), "README.md");
        names.insert(dedup_key("README.md"));

        // The pair that used to abort the export.
        assert_eq!(pick_deduped(&names, "readme.md").unwrap(), "readme (1).md");
        assert_eq!(pick_deduped(&names, "ReadMe.md").unwrap(), "ReadMe (1).md");
        // …and the suffixed form is checked case-insensitively too, so a third
        // spelling does not collide with the second.
        names.insert(dedup_key("readme (1).md"));
        assert_eq!(pick_deduped(&names, "ReadMe.md").unwrap(), "ReadMe (2).md");
    }

    #[test]
    fn the_emitted_name_keeps_its_original_case() {
        use myne_format::export_walk::pick_deduped;
        let names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "MyNotes.md").unwrap(), "MyNotes.md");
        assert_eq!(pick_deduped(&names, "Photo.PNG").unwrap(), "Photo.PNG");
    }

    #[test]
    fn a_folded_directory_key_is_one_namespace() {
        use myne_format::export_naming::export_dedup_key as dedup_key;
        // `Work/` and `work/` are the same directory on the volume, so they
        // must share one assigned set — otherwise two same-named notes in
        // case-differing folders both write into it and the second aborts.
        assert_eq!(dedup_key("Work/Notes"), dedup_key("work/notes"));
        assert_ne!(dedup_key("Work/Notes"), dedup_key("Work/Other"));
    }
}
