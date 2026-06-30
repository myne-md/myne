//! `snapshots` plugin commands (MYND-96, SYNC-9): the read/management surface
//! for encrypted per-note snapshots. The creation hook + prune-on-create +
//! purge-on-delete live in the `notes` plugin (the `note_update`/`note_delete`
//! seam); this plugin owns `snapshot_list` / `snapshot_preview` /
//! `snapshot_restore` / `snapshot_prune` and borrows `VaultRuntimeState`
//! cross-plugin (the `vault_recover`/`notes` precedent).
//!
//! Slot discipline + `spawn_blocking` + DENY-list-clean tracing mirror the
//! `notes` commands. Decode failures collapse to the single non-distinguishing
//! `CannotDecrypt` (`protocol.md` §6.4). See `src-tauri/CLAUDE.md`
//! "Secret-handling logging discipline" (the Plaintext-IPC pattern applies to
//! `snapshot_preview`'s returned plaintext).

use super::error::{snapshot_error_kind, SnapshotError};
use crate::io_failure_kind::from_io_error_kind;
use crate::paths;
use crate::plugins::notes::commands::note_update_with_dir;
use crate::plugins::notes::desktop_commands::note_snapshot_flush_with_dir;
use crate::plugins::notes::error::NoteUpdateError;
use crate::plugins::notes::note_id::NoteId;
use crate::plugins::notes::title_extract::resolve_note_title;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use crate::search::SearchIndexState;
use protocol::{decode_note, DecryptError};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

/// One snapshot's decrypt-free metadata, returned to the UI by
/// [`snapshot_list`] (SYNC-6). All fields are derived from the filename + stat,
/// never by decrypting the blob.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SnapshotMeta {
    pub snapshot_uuid: String,
    pub captured_at_ms: u64,
    pub size_bytes: u64,
}

/// True if `s` is a valid UUIDv7 string (the snapshot id shape).
fn valid_v7(s: &str) -> bool {
    uuid::Uuid::parse_str(s)
        .map(|u| u.get_version_num() == 7)
        .unwrap_or(false)
}

/// Map a `notes`-plugin `NoteUpdateError` (from the restore's reuse of
/// `note_update_with_dir` / `note_snapshot_flush_with_dir`) into a
/// `SnapshotError`.
fn map_note_update_err(e: NoteUpdateError) -> SnapshotError {
    match e {
        NoteUpdateError::VaultNotUnlocked => SnapshotError::VaultNotUnlocked,
        NoteUpdateError::InvalidNoteId => SnapshotError::InvalidNoteId,
        NoteUpdateError::NoteNotFound => SnapshotError::SnapshotNotFound,
        NoteUpdateError::CannotDecrypt => SnapshotError::CannotDecrypt,
        NoteUpdateError::NotesDirNotADirectory => SnapshotError::NotesDirNotADirectory,
        NoteUpdateError::Io { io_error_kind } => SnapshotError::Io { io_error_kind },
        // PlaintextTooLarge is unreachable (the snapshot content was already a
        // valid <=16 MiB note); JoinFailure is the panic-equivalent for v0.1
        // invariant violations.
        NoteUpdateError::PlaintextTooLarge | NoteUpdateError::JoinFailure => {
            SnapshotError::JoinFailure
        }
    }
}

// ---- snapshot_list ------------------------------------------------------

/// Testable core of [`snapshot_list`]. Decrypt-free (SYNC-6).
pub(crate) async fn snapshot_list_in(
    snapshots_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
) -> Result<Vec<SnapshotMeta>, SnapshotError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;

    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } => return Err(SnapshotError::VaultNotUnlocked),
    }

    let note_uuid = note_id.as_uuid().to_string();
    let files = tokio::task::spawn_blocking(move || {
        crate::snapshot_store::list_note_snapshots(&snapshots_dir, &note_uuid)
    })
    .await
    .map_err(|_| SnapshotError::JoinFailure)?
    .map_err(|e| SnapshotError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    })?;
    drop(slot);

    Ok(files
        .into_iter()
        .map(|f| SnapshotMeta {
            snapshot_uuid: f.snapshot_uuid,
            captured_at_ms: f.captured_at_ms,
            size_bytes: f.size_bytes,
        })
        .collect())
}

/// List a note's encrypted snapshots, newest-first, decrypt-free.
#[tauri::command]
pub async fn snapshot_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<Vec<SnapshotMeta>, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(&app, state.active_vault_id().await)?;
    snapshot_list_in(snapshots_dir, state.inner(), note_id)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_list",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

// ---- snapshot_preview ---------------------------------------------------

/// Testable core of [`snapshot_preview`]. In-memory decrypt only; never writes
/// plaintext to disk (Plaintext-IPC discipline).
pub(crate) async fn snapshot_preview_in(
    snapshots_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
    snapshot_uuid: String,
) -> Result<String, SnapshotError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;
    if !valid_v7(&snapshot_uuid) {
        return Err(SnapshotError::InvalidSnapshotId);
    }

    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } => return Err(SnapshotError::VaultNotUnlocked),
    };

    let note_uuid_bytes = *note_id.as_uuid().as_bytes();
    let path = snapshots_dir.join(crate::snapshot_store::snapshot_filename(
        &note_id.as_uuid().to_string(),
        &snapshot_uuid,
    ));

    let plaintext = tokio::task::spawn_blocking(move || -> Result<String, SnapshotError> {
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(SnapshotError::SnapshotNotFound)
            }
            Err(e) => {
                return Err(SnapshotError::Io {
                    io_error_kind: from_io_error_kind(e.kind()),
                })
            }
        };
        let decrypted = decode_note(&blob, &note_uuid_bytes, &items_key, &items_key_id)
            .map_err(|_: DecryptError| SnapshotError::CannotDecrypt)?;
        let s = String::from_utf8(decrypted.plaintext().to_vec())
            .map_err(|_| SnapshotError::CannotDecrypt)?;
        drop(decrypted); // minimize the non-Zeroized intermediate's lifetime
        Ok(s)
    })
    .await
    .map_err(|_| SnapshotError::JoinFailure)??;
    drop(slot);

    Ok(plaintext)
}

/// Decrypt a selected snapshot in memory and return its plaintext.
#[tauri::command]
pub async fn snapshot_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
    snapshot_uuid: String,
) -> Result<String, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(&app, state.active_vault_id().await)?;
    snapshot_preview_in(snapshots_dir, state.inner(), note_id, snapshot_uuid)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_preview",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

// ---- snapshot_restore ---------------------------------------------------

/// Testable core of [`snapshot_restore`]. Atomic, guaranteed-undoable (SYNC-5):
/// (1) decode the selected snapshot, (2) force-snapshot the current live note
/// (the undo point), (3) overwrite the live note with the snapshot content via
/// `note_update_with_dir` — whose creation hook is coalesced by step 2's flush,
/// so there is no double snapshot. Keeps the live search index correct.
pub(crate) async fn snapshot_restore_in(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
    hooks: &myne_core::hooks::Hooks,
    note_id: String,
    snapshot_uuid: String,
) -> Result<(), SnapshotError> {
    let note_id_parsed = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;
    if !valid_v7(&snapshot_uuid) {
        return Err(SnapshotError::InvalidSnapshotId);
    }
    let snapshots_dir = notes_dir
        .parent()
        .map(|p| p.join("snapshots"))
        .ok_or(SnapshotError::NotesDirNotADirectory)?;

    // Step 1: decode the snapshot → plaintext (in-memory; Zeroizing-bounded).
    let plaintext: Zeroizing<String> = {
        let slot = state.slot_read_active().await;
        let (items_key, items_key_id) = match &*slot {
            Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
            Slot::Empty | Slot::Recovering { .. } => return Err(SnapshotError::VaultNotUnlocked),
        };
        let note_uuid_bytes = *note_id_parsed.as_uuid().as_bytes();
        let path = snapshots_dir.join(crate::snapshot_store::snapshot_filename(
            &note_id_parsed.as_uuid().to_string(),
            &snapshot_uuid,
        ));
        let pt = tokio::task::spawn_blocking(move || -> Result<String, SnapshotError> {
            let blob = match std::fs::read(&path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(SnapshotError::SnapshotNotFound)
                }
                Err(e) => {
                    return Err(SnapshotError::Io {
                        io_error_kind: from_io_error_kind(e.kind()),
                    })
                }
            };
            let decrypted = decode_note(&blob, &note_uuid_bytes, &items_key, &items_key_id)
                .map_err(|_: DecryptError| SnapshotError::CannotDecrypt)?;
            let s = String::from_utf8(decrypted.plaintext().to_vec())
                .map_err(|_| SnapshotError::CannotDecrypt)?;
            drop(decrypted);
            Ok(s)
        })
        .await
        .map_err(|_| SnapshotError::JoinFailure)??;
        drop(slot);
        Zeroizing::new(pt)
    };

    // Step 2: force-snapshot the current live note (the undo point). Ignores the
    // best-effort warning bool — restore's contract is the overwrite.
    note_snapshot_flush_with_dir(notes_dir.clone(), state, note_id.clone())
        .await
        .map_err(map_note_update_err)?;

    // Step 3: overwrite the live note with the snapshot content. The creation
    // hook inside note_update is coalesced (within the window of step 2's
    // flush) → no double snapshot.
    // (Capture vault_dir before note_update_with_dir moves notes_dir — needed
    // for the MYND-328 attachment-text fold below.)
    let vault_dir = notes_dir.parent().map(std::path::Path::to_path_buf);
    note_update_with_dir(
        notes_dir,
        state,
        hooks,
        note_id.clone(),
        (*plaintext).clone(),
    )
    .await
    .map_err(map_note_update_err)?;

    // Step 4: keep the live in-RAM search index correct. MYND-328: fold the
    // restored note's attachment text in (parity with note_create/update/batch)
    // so a restore doesn't drop attachment searchability until the next unlock.
    let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
    let body = match vault_dir {
        Some(ref vd) => {
            crate::plugins::notes::search_sync::fold_note_body_for_index(state, vd, &plaintext)
                .await
        }
        None => (*plaintext).clone(),
    };
    search.upsert(&note_id, &title, &body);

    Ok(())
}

/// Restore a selected snapshot, atomically capturing the current state as the
/// undo point first.
#[tauri::command]
pub async fn snapshot_restore<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    search: State<'_, SearchIndexState>,
    hooks: State<'_, myne_core::hooks::Hooks>,
    note_id: String,
    snapshot_uuid: String,
) -> Result<(), SnapshotError> {
    let notes_dir = resolve_notes_dir(&app, state.active_vault_id().await)?;
    snapshot_restore_in(
        notes_dir,
        state.inner(),
        search.inner(),
        hooks.inner(),
        note_id,
        snapshot_uuid,
    )
    .await
    .inspect_err(|e| {
        tracing::debug!(
            stage = "snapshot_restore",
            error_kind = snapshot_error_kind(e),
            "snapshot command failed"
        )
    })
}

// ---- snapshot_prune -----------------------------------------------------

/// Testable core of [`snapshot_prune`]. Applies the canonical retention policy
/// (SYNC-2) — the same one the eager write-path prune uses. Returns the count
/// removed.
pub(crate) async fn snapshot_prune_in(
    snapshots_dir: PathBuf,
    state: &VaultRuntimeState,
    note_id: String,
) -> Result<u32, SnapshotError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;

    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(_) => {}
        Slot::Empty | Slot::Recovering { .. } => return Err(SnapshotError::VaultNotUnlocked),
    }

    let note_uuid = note_id.as_uuid().to_string();
    let now_ms = crate::snapshot_store::now_unix_ms();
    let removed = tokio::task::spawn_blocking(move || {
        crate::snapshot_store::prune_note_snapshots(
            &snapshots_dir,
            &note_uuid,
            now_ms,
            &crate::snapshot_policy::RetentionPolicy::default(),
        )
    })
    .await
    .map_err(|_| SnapshotError::JoinFailure)?
    .map_err(|e| SnapshotError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    })?;
    drop(slot);

    Ok(removed as u32)
}

/// Apply the retention policy to a note's snapshots now (manual "clear old
/// history"; the eager write-path prune already runs on every create).
#[tauri::command]
pub async fn snapshot_prune<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<u32, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(&app, state.active_vault_id().await)?;
    snapshot_prune_in(snapshots_dir, state.inner(), note_id)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_prune",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

// ---- path resolution ----------------------------------------------------

fn resolve_snapshots_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, SnapshotError> {
    paths::snapshots_dir_for(app, active_id).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
            SnapshotError::NotesDirNotADirectory
        }
        other => SnapshotError::Io {
            io_error_kind: from_io_error_kind(other),
        },
    })
}

fn resolve_notes_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, SnapshotError> {
    paths::notes_dir_for(app, active_id).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
            SnapshotError::NotesDirNotADirectory
        }
        other => SnapshotError::Io {
            io_error_kind: from_io_error_kind(other),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{notes_dir_under, snapshots_dir_under};
    use crate::plugins::notes::commands::{note_create_with_dir, note_update_with_dir};
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;

    const FIXTURE_ROOT_BYTE: u8 = 0x07;
    const FIXTURE_ITEMS_BYTE: u8 = 0x09;
    const FIXTURE_ITEMS_ID_BYTE: u8 = 0x01;

    /// A `Hooks` whose snapshot-capture / -purge methods delegate to the REAL
    /// desktop snapshot store (exactly what `DesktopHooks` does), with every
    /// other hook a no-op. These tests assert that `note_update_with_dir`
    /// actually writes / purges snapshots, so the snapshot pair must be live;
    /// the index/sync side-effects are irrelevant here. Avoids needing an
    /// `AppHandle` / `tauri::test` harness (TB9 Cargo.lock discipline) — the
    /// `ClampHooks` precedent in `prefs/mod.rs`.
    struct SnapshotHooks;
    impl myne_core::hooks::VaultLifecycleHooks for SnapshotHooks {
        fn hydrate_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn fold_attachment_text_for_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            note_body: &'a str,
        ) -> myne_core::hooks::BoxFuture<'a, String> {
            let body = note_body.to_string();
            Box::pin(std::future::ready(body))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn bump_local_change(&self) {}
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32 {
            prefs_value.unwrap_or(myne_core::DEFAULT_AUTO_LOCK_SECS)
        }
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn preempt_inflight_backup<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> myne_core::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn invalidate_quick_unlock(&self, _: &std::path::Path) {}
        fn capture_snapshot(
            &self,
            vault_root: &std::path::Path,
            note_uuid: &str,
            old_blob: &[u8],
            now_ms: u64,
            force: bool,
        ) -> bool {
            crate::plugins::notes::desktop_commands::capture_snapshot_best_effort(
                vault_root, note_uuid, old_blob, now_ms, force,
            )
        }
        fn purge_note_snapshots(
            &self,
            vault_root: &std::path::Path,
            note_uuid: &str,
        ) -> std::io::Result<usize> {
            crate::snapshot_store::remove_all_note_snapshots(
                &vault_root.join("snapshots"),
                note_uuid,
            )
        }
    }

    fn noop_hooks() -> myne_core::hooks::Hooks {
        std::sync::Arc::new(SnapshotHooks)
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    async fn unlocked() -> VaultRuntimeState {
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(
                    FIXTURE_ROOT_BYTE,
                    FIXTURE_ITEMS_BYTE,
                    FIXTURE_ITEMS_ID_BYTE,
                ),
            )
            .await;
        state
    }

    #[test]
    fn list_returns_created_snapshots_newest_first() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-list-cmd").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;

            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            // No snapshot yet (create doesn't snapshot).
            assert!(snapshot_list_in(sdir.clone(), &state, id.clone())
                .await
                .unwrap()
                .is_empty());
            // First update → one snapshot (of v1).
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
            )
            .await
            .unwrap();

            let list = snapshot_list_in(sdir, &state, id).await.unwrap();
            assert_eq!(list.len(), 1);
            assert!(list[0].size_bytes > 0);
        });
    }

    #[test]
    fn list_rejects_when_locked() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-list-locked").unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = VaultRuntimeState::default(); // Empty
            let phantom = "01970e83-4f2f-7000-8000-000000000000".to_string();
            assert_eq!(
                snapshot_list_in(sdir, &state, phantom).await,
                Err(SnapshotError::VaultNotUnlocked)
            );
        });
    }

    #[test]
    fn preview_returns_the_pre_edit_content() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-preview").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;

            let v1 = "# v1\noriginal";
            let id = note_create_with_dir(notes_dir.clone(), &state, v1.to_string())
                .await
                .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "# v2".to_string(),
            )
            .await
            .unwrap();

            let snap_uuid = snapshot_list_in(sdir.clone(), &state, id.clone())
                .await
                .unwrap()[0]
                .snapshot_uuid
                .clone();
            let body = snapshot_preview_in(sdir, &state, id, snap_uuid)
                .await
                .unwrap();
            assert_eq!(
                body, v1,
                "preview must return the snapshot's (pre-edit) content"
            );
        });
    }

    #[test]
    fn preview_missing_snapshot_is_not_found() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-preview-missing").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(notes_dir, &state, "v1".to_string())
                .await
                .unwrap();
            // A syntactically-valid but absent snapshot id.
            let absent = "01970e83-4f2f-7000-8000-000000000000".to_string();
            assert_eq!(
                snapshot_preview_in(sdir, &state, id, absent).await,
                Err(SnapshotError::SnapshotNotFound)
            );
        });
    }

    #[test]
    fn preview_rejects_non_v7_snapshot_id() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-preview-badid").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(notes_dir, &state, "v1".to_string())
                .await
                .unwrap();
            assert_eq!(
                snapshot_preview_in(sdir, &state, id, "not-a-uuid".to_string()).await,
                Err(SnapshotError::InvalidSnapshotId)
            );
        });
    }

    #[test]
    fn restore_overwrites_live_and_captures_undo_point() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-restore").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;
            let search = SearchIndexState::default();

            let v1 = "# v1\noriginal body";
            let id = note_create_with_dir(notes_dir.clone(), &state, v1.to_string())
                .await
                .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "# v2\nedited".to_string(),
            )
            .await
            .unwrap();

            // One snapshot exists: S1 = v1. Live note = v2.
            let s1 = snapshot_list_in(sdir.clone(), &state, id.clone())
                .await
                .unwrap()[0]
                .snapshot_uuid
                .clone();

            // Restore S1 (v1).
            snapshot_restore_in(
                notes_dir.clone(),
                &state,
                &search,
                &noop_hooks(),
                id.clone(),
                s1,
            )
            .await
            .unwrap();

            // Live note is now v1 again.
            let note_id = NoteId::parse(&id).unwrap();
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let live = std::fs::read(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();
            let dec = decode_note(
                &live,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .unwrap();
            assert_eq!(dec.plaintext(), v1.as_bytes());

            // Two snapshots now: S1 (v1) + the undo point (pre-restore = v2).
            let list = snapshot_list_in(sdir, &state, id).await.unwrap();
            assert_eq!(
                list.len(),
                2,
                "restore must capture the pre-restore state as an undo point"
            );
        });
    }

    #[test]
    fn prune_in_window_removes_nothing() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-prune-cmd").unwrap();
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;
            let id = note_create_with_dir(notes_dir.clone(), &state, "v1".to_string())
                .await
                .unwrap();
            note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
            )
            .await
            .unwrap();
            // The lone snapshot is recent → retention keeps it.
            assert_eq!(snapshot_prune_in(sdir, &state, id).await.unwrap(), 0);
        });
    }
}
