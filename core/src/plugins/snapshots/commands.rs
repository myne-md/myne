//! `snapshots` plugin commands (MYND-96, SYNC-9): the read/management surface
//! for encrypted per-note snapshots. The creation hook + prune-on-create +
//! purge-on-delete live in the `notes` plugin (the `note_update`/`note_delete`
//! seam); this plugin owns `snapshot_list` / `snapshot_preview` /
//! `snapshot_restore` / `snapshot_prune` and borrows `VaultRuntimeState`
//! cross-plugin (the `vault_recover`/`notes` precedent), plus `Hooks` on restore.
//!
//! Slot discipline + `spawn_blocking` + DENY-list-clean tracing mirror the
//! `notes` commands. Decode failures collapse to the single non-distinguishing
//! `CannotDecrypt` (`protocol.md` §6.4). See `src-tauri/AGENTS.md`
//! "Secret-handling logging discipline" (the Plaintext-IPC pattern applies to
//! `snapshot_preview`'s returned plaintext).

use super::error::{snapshot_error_kind, SnapshotError};
use crate::host::HostCtx;
use crate::io_failure_kind::from_io_error_kind;
use crate::paths;
use crate::plugins::notes::commands::note_update_with_dir;
use crate::plugins::notes::error::NoteUpdateError;
use crate::plugins::notes::note_id::NoteId;
use crate::plugins::notes::title_extract::resolve_note_title;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use serde::Serialize;
use std::path::PathBuf;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
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
    /// The resolved author of THIS revision (`collab-provenance` task 2/3): the
    /// device that made the change (named, or the short-code fallback), or `Unknown`
    /// for the `MY01` arm and an unmappable actor. Never a Person durably.
    pub resolved_author: crate::plugins::sync::identity_resolver::ResolvedIdentity,
}

/// True if `s` is a valid UUIDv7 string (the snapshot id shape).
fn valid_v7(s: &str) -> bool {
    uuid::Uuid::parse_str(s)
        .map(|u| u.get_version_num() == 7)
        .unwrap_or(false)
}

/// Map a `notes`-plugin `NoteUpdateError` (from the restore's reuse of
/// `note_update_with_dir`) into a `SnapshotError`.
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
        // invariant violations. BaseMismatch is likewise unreachable: restore
        // passes `expected_base_hash = None` (an explicit user overwrite must
        // never be base-guarded), so this arm fires only via a bug.
        NoteUpdateError::PlaintextTooLarge
        | NoteUpdateError::JoinFailure
        | NoteUpdateError::BaseMismatch
        // Unreachable here too: a restore does not go through the live plane.
        | NoteUpdateError::LiveSessionOpen => SnapshotError::JoinFailure,
    }
}

// ---- snapshot_list ------------------------------------------------------

/// The `notes/` sibling of a resolved `snapshots/` directory.
///
/// Both are children of the vault root, so the CRDT arm below can reach the note
/// blob without a second host round-trip — which is what keeps
/// `snapshot_list`/`snapshot_preview`'s IPC signatures unchanged while they gain
/// a second history source.
fn notes_dir_beside(snapshots_dir: &std::path::Path) -> Option<PathBuf> {
    snapshots_dir.parent().map(|vault| vault.join("notes"))
}

/// Testable core of [`snapshot_list`].
///
/// **Two history sources, chosen by the note's own magic.** A `MY01` note's
/// history is the `snapshots/` store, listed decrypt-free from filenames + stat
/// (SYNC-6). An `NC05` note captures no snapshots at all — by design, since its
/// synced Automerge change-graph IS the version store (`decisions.md`
/// 2026-08-09, ASM-12→B) — so its history is read out of the note itself, which
/// costs one decrypt.
///
/// Dispatching on the BLOB rather than on the vault generation is deliberate: it
/// gives the right answer for every note in a vault regardless of how the vault
/// got there, including a v0.1 note in a migrated vault that abort left behind.
pub(crate) async fn snapshot_list_in(
    snapshots_dir: PathBuf,
    state: &VaultRuntimeState,
    index: &crate::plugins::sync::identity_resolver::IdentityIndex,
    note_id: String,
) -> Result<Vec<SnapshotMeta>, SnapshotError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;

    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            return Err(SnapshotError::VaultNotUnlocked)
        }
    };

    if let Some(notes_dir) = notes_dir_beside(&snapshots_dir) {
        let note_uuid_bytes = *note_id.as_uuid().as_bytes();
        let note_path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        // Cloned into the `'static` blocking closure. The whole index moves, not just the
        // device names: the durable arm is what the closure needs and it is one value.
        let index_for_arm = index.clone();
        let crdt = crate::task::run_blocking(
            move || -> Result<Option<Vec<SnapshotMeta>>, SnapshotError> {
                let blob = match std::fs::read(&note_path) {
                    Ok(b) => b,
                    // An absent note is not this function's error to raise: the
                    // `MY01` path below reports its own empty/not-found shape.
                    Err(_) => return Ok(None),
                };
                if !crate::plugins::notes::crdt::is_nc05_blob(&blob) {
                    return Ok(None);
                }
                let revisions = crate::plugins::notes::crdt::crdt_note_history(
                    &blob,
                    &note_uuid_bytes,
                    &items_key,
                    &items_key_id,
                )
                .map_err(|_| SnapshotError::CannotDecrypt)?;
                // Newest-first, matching the `snapshots/` listing the UI already
                // renders. `get_changes` yields causal order (oldest first).
                Ok(Some(
                    revisions
                        .into_iter()
                        .rev()
                        .map(|r| SnapshotMeta {
                            resolved_author:
                                crate::plugins::sync::identity_resolver::resolve_revision_author(
                                    &index_for_arm,
                                    crate::plugins::sync::identity_resolver::actor_from_hex(
                                        &r.actor_hex,
                                    ),
                                ),
                            snapshot_uuid: r.change_hash_hex,
                            captured_at_ms: r.timestamp_millis.max(0) as u64,
                            size_bytes: r.size_bytes,
                        })
                        .collect(),
                ))
            },
        )
        .await
        .map_err(|_| SnapshotError::JoinFailure)??;
        if let Some(revisions) = crdt {
            drop(slot);
            return Ok(revisions);
        }
    }

    let note_uuid = note_id.as_uuid().to_string();
    let files = crate::task::run_blocking(move || {
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
            // The `MY01` snapshots arm has no Automerge actor to resolve.
            resolved_author: crate::plugins::sync::identity_resolver::ResolvedIdentity::Unknown,
            snapshot_uuid: f.snapshot_uuid,
            captured_at_ms: f.captured_at_ms,
            size_bytes: f.size_bytes,
        })
        .collect())
}

/// List a note's encrypted snapshots, newest-first, decrypt-free.
pub async fn snapshot_list_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
    note_id: String,
) -> Result<Vec<SnapshotMeta>, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(host, state.active_vault_id().await)?;
    let vault_dir = snapshots_dir
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| snapshots_dir.clone());
    // `collab-provenance` task 3: the vault's device names resolve each revision's actor
    // to a device label. Read once; an unreadable prefs blob degrades to an empty map
    // (every revision then resolves to the short-code fallback).
    let device_names = crate::plugins::prefs::commands::prefs_read_with_dir(&vault_dir, state, io)
        .await
        .map(|v| v.device_names)
        .unwrap_or_default();
    // `member-devices` task 4: the durable half, from the group-sealed binding, roster and
    // member-name stores. Built here rather than inside the blocking closure because the
    // join awaits IO, and it resolves to an EMPTY index on every failure, so a vault with no
    // group tier (or no bindings) costs one `vault.meta` read and one store read and then
    // resolves every revision to its device label.
    let durable =
        crate::plugins::sync::identity_resolver::durable_attribution_in_dir(io, state, &vault_dir)
            .await;
    let index = crate::plugins::sync::identity_resolver::IdentityIndex::new(device_names, durable);
    snapshot_list_in(snapshots_dir, state, &index, note_id)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_list",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn snapshot_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<Vec<SnapshotMeta>, SnapshotError> {
    snapshot_list_from_host(
        &TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
        note_id,
    )
    .await
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
    // A CRDT revision id is a change hash, not a UUIDv7, so the shape check is
    // per-source rather than up-front: the `MY01` arm keeps it (below), and the
    // CRDT arm validates by looking the hash up in the document — a stricter
    // check than any shape test, since it also rejects a well-formed hash from
    // another note.
    let crdt_candidate = !valid_v7(&snapshot_uuid);

    let slot = state.slot_read_active().await;
    let (items_key, items_key_id) = match &*slot {
        Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            return Err(SnapshotError::VaultNotUnlocked)
        }
    };

    let note_uuid_bytes = *note_id.as_uuid().as_bytes();

    if crdt_candidate {
        let Some(notes_dir) = notes_dir_beside(&snapshots_dir) else {
            return Err(SnapshotError::InvalidSnapshotId);
        };
        let note_path = notes_dir.join(format!("{}.myn", note_id.as_uuid()));
        let revision = snapshot_uuid.clone();
        let key = items_key.clone();
        let text = crate::task::run_blocking(move || -> Result<String, SnapshotError> {
            let blob = std::fs::read(&note_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    SnapshotError::SnapshotNotFound
                } else {
                    SnapshotError::Io {
                        io_error_kind: from_io_error_kind(e.kind()),
                    }
                }
            })?;
            if !crate::plugins::notes::crdt::is_nc05_blob(&blob) {
                // Not a CRDT note and not a UUIDv7 id — there is no source that
                // could serve this request.
                return Err(SnapshotError::InvalidSnapshotId);
            }
            crate::plugins::notes::crdt::crdt_note_text_at(
                &blob,
                &note_uuid_bytes,
                &key,
                &items_key_id,
                &revision,
            )
            .map_err(|e| match e {
                crate::plugins::notes::crdt::CrdtNoteOpError::RevisionNotFound => {
                    SnapshotError::SnapshotNotFound
                }
                _ => SnapshotError::CannotDecrypt,
            })
        })
        .await
        .map_err(|_| SnapshotError::JoinFailure)??;
        drop(slot);
        return Ok(text);
    }
    let path = snapshots_dir.join(crate::snapshot_store::snapshot_filename(
        &note_id.as_uuid().to_string(),
        &snapshot_uuid,
    ));

    let plaintext = crate::task::run_blocking(move || -> Result<String, SnapshotError> {
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
        // Either format (myne-md/myne#432). A snapshot of a note taken BEFORE the
        // migration is still `MY01` under the OLD itemsKey and no magic branch can
        // help it — that is myne-md/myne#435's subject, and separate from this.
        let decrypted = crate::plugins::notes::decode::decode_note_any(
            &blob,
            &note_uuid_bytes,
            &items_key,
            &items_key_id,
        )
        .map_err(|_| SnapshotError::CannotDecrypt)?;
        let s = String::from_utf8(decrypted.to_vec()).map_err(|_| SnapshotError::CannotDecrypt)?;
        drop(decrypted); // minimize the non-Zeroized intermediate's lifetime
        Ok(s)
    })
    .await
    .map_err(|_| SnapshotError::JoinFailure)??;
    drop(slot);

    Ok(plaintext)
}

/// Decrypt a selected snapshot in memory and return its plaintext.
pub async fn snapshot_preview_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    note_id: String,
    snapshot_uuid: String,
) -> Result<String, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(host, state.active_vault_id().await)?;
    snapshot_preview_in(snapshots_dir, state, note_id, snapshot_uuid)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_preview",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn snapshot_preview<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
    snapshot_uuid: String,
) -> Result<String, SnapshotError> {
    snapshot_preview_from_host(&TauriHost::new(app), state.inner(), note_id, snapshot_uuid).await
}

// ---- snapshot_restore ---------------------------------------------------

/// Testable core of [`snapshot_restore`]. Atomic, guaranteed-undoable (SYNC-5):
/// (1) decode the selected snapshot, (2) force-snapshot the current live note
/// (the undo point) through the `hooks::VaultLifecycleHooks::capture_snapshot`
/// seam — **aborting before any overwrite if that undo-point cannot be written**,
/// so the undoability guarantee never silently degrades into data-loss,
/// (3) overwrite the live note with the snapshot content via `note_update_with_dir`
/// — whose creation hook is coalesced by step 2's forced capture, so there is no
/// double snapshot. Keeps the live search + AI indices correct via the hooks
/// seam. Desktop's `DesktopHooks` and mobile's `MobileHooks` both capture through
/// the shared `myne-core` snapshot store; a client whose hooks no-op capture
/// (`NoopHooks`) simply has no undo point to fail on.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn snapshot_restore_in(
    notes_dir: PathBuf,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    snapshot_uuid: String,
    // Threaded in with MYND-574 task 13: `note_update_with_dir` now takes both
    // seams. Snapshots themselves are not ported to web yet (task 31) — this
    // parameter exists so the shared call site compiles, and the desktop caller
    // passes its real host so the metric it feeds stays honest.
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
    registry: Option<&crate::plugins::live::LiveSessionRegistry>,
) -> Result<(), SnapshotError> {
    let note_id_parsed = NoteId::parse(&note_id).map_err(|_| SnapshotError::InvalidNoteId)?;
    // Single-writer refusal (`SYNC-33`): while a live session owns this note it IS
    // the only durable writer, so restoring would write behind it and the session's
    // next flush (or the pane's next save) would silently discard the restore.
    // `None` means the caller has NO registry in hand (the agent undo on a host that
    // does not manage one), which skips the check: the type says so rather than a
    // throwaway registry hiding it.
    if registry.is_some_and(|r| r.is_note_open(&note_id_parsed.to_string())) {
        return Err(SnapshotError::LiveSessionOpen);
    }
    // A CRDT revision id is a change hash rather than a UUIDv7 — same per-source
    // shape rule as `snapshot_preview_in`.
    let crdt_candidate = !valid_v7(&snapshot_uuid);
    let snapshots_dir = notes_dir
        .parent()
        .map(|p| p.join("snapshots"))
        .ok_or(SnapshotError::NotesDirNotADirectory)?;

    // Step 1: decode the requested revision → plaintext (in-memory;
    // Zeroizing-bounded). For a CRDT note the source is the note's own change
    // graph; for a v0.1 note it is the `snapshots/` blob.
    let plaintext: Zeroizing<String> = if crdt_candidate {
        let slot = state.slot_read_active().await;
        let (items_key, items_key_id) = match &*slot {
            Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
            Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
                return Err(SnapshotError::VaultNotUnlocked)
            }
        };
        let note_uuid_bytes = *note_id_parsed.as_uuid().as_bytes();
        let live_path = notes_dir.join(format!("{}.myn", note_id_parsed.as_uuid()));
        let revision = snapshot_uuid.clone();
        let pt = crate::task::run_blocking(move || -> Result<String, SnapshotError> {
            let blob = std::fs::read(&live_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    SnapshotError::SnapshotNotFound
                } else {
                    SnapshotError::Io {
                        io_error_kind: from_io_error_kind(e.kind()),
                    }
                }
            })?;
            if !crate::plugins::notes::crdt::is_nc05_blob(&blob) {
                return Err(SnapshotError::InvalidSnapshotId);
            }
            crate::plugins::notes::crdt::crdt_note_text_at(
                &blob,
                &note_uuid_bytes,
                &items_key,
                &items_key_id,
                &revision,
            )
            .map_err(|e| match e {
                crate::plugins::notes::crdt::CrdtNoteOpError::RevisionNotFound => {
                    SnapshotError::SnapshotNotFound
                }
                _ => SnapshotError::CannotDecrypt,
            })
        })
        .await
        .map_err(|_| SnapshotError::JoinFailure)??;
        drop(slot);
        Zeroizing::new(pt)
    } else {
        let slot = state.slot_read_active().await;
        let (items_key, items_key_id) = match &*slot {
            Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
            Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
                return Err(SnapshotError::VaultNotUnlocked)
            }
        };
        let note_uuid_bytes = *note_id_parsed.as_uuid().as_bytes();
        let path = snapshots_dir.join(crate::snapshot_store::snapshot_filename(
            &note_id_parsed.as_uuid().to_string(),
            &snapshot_uuid,
        ));
        let pt = crate::task::run_blocking(move || -> Result<String, SnapshotError> {
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
            // Either format (myne-md/myne#432). A snapshot of a note taken BEFORE the
            // migration is still `MY01` under the OLD itemsKey and no magic branch can
            // help it — that is myne-md/myne#435's subject, and separate from this.
            let decrypted = crate::plugins::notes::decode::decode_note_any(
                &blob,
                &note_uuid_bytes,
                &items_key,
                &items_key_id,
            )
            .map_err(|_| SnapshotError::CannotDecrypt)?;
            let s =
                String::from_utf8(decrypted.to_vec()).map_err(|_| SnapshotError::CannotDecrypt)?;
            drop(decrypted);
            Ok(s)
        })
        .await
        .map_err(|_| SnapshotError::JoinFailure)??;
        drop(slot);
        Zeroizing::new(pt)
    };

    // Step 2: force-snapshot the current live note (the undo point, SYNC-5)
    // through the hooks seam (`capture_snapshot`, force=true), bypassing the
    // coalescing window. `capture_snapshot` returns `true` ONLY on a real
    // dir-create/write failure (`false` on success or a coalesced skip — and
    // force=true precludes the latter). If the live note EXISTS but its undo
    // point cannot be written, ABORT before overwriting: the guaranteed-undoable
    // contract (SYNC-5) must never degrade into silent data-loss. A missing live
    // blob is a fresh note — nothing to undo, proceed. File IO runs on a blocking
    // thread; mirrors how `note_update` routes its pre-overwrite snapshot.
    //
    // **Skipped entirely for a CRDT note, and the SYNC-5 contract is stronger
    // rather than weaker there.** Restoring a revision of an `NC05` note is an
    // ordinary edit: it appends a change and the pre-restore state stays in the
    // document's own history, so the undo point is the previous revision — which
    // is already in the list the user just picked from. Writing a `snapshots/`
    // entry here would be a v0.1 artefact in a v0.2 vault (the hybrid this
    // change set exists to prevent), and `note_update` captures none for these
    // notes either.
    if !crdt_candidate {
        if let Some(vault_root) = notes_dir.parent().map(std::path::Path::to_path_buf) {
            let note_uuid_str = note_id_parsed.as_uuid().to_string();
            let live_path = notes_dir.join(format!("{note_uuid_str}.myn"));
            let hooks_owned: crate::hooks::Hooks = hooks.clone();
            let undo_failed = crate::task::run_blocking(move || match std::fs::read(&live_path) {
                Ok(old_blob) => {
                    let now_ms = crate::snapshot_store::now_unix_ms();
                    hooks_owned.capture_snapshot(
                        &vault_root,
                        &note_uuid_str,
                        &old_blob,
                        now_ms,
                        /* force = */ true,
                    )
                }
                Err(_) => false, // no live blob → nothing to undo
            })
            .await
            .map_err(|_| SnapshotError::JoinFailure)?;
            if undo_failed {
                return Err(SnapshotError::Io {
                    io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                });
            }
        }
    }

    // Step 3: overwrite the live note with the snapshot content. The creation
    // hook inside note_update is coalesced (within the window of step 2's forced
    // capture) → no double snapshot.
    note_update_with_dir(
        notes_dir,
        state,
        hooks,
        note_id.clone(),
        (*plaintext).clone(),
        // Restore is an explicit user overwrite — never base-guarded.
        None,
        io,
        host,
    )
    .await
    .map_err(map_note_update_err)?;

    // Step 4: keep the live in-RAM search + AI indices correct through the hooks
    // seam. MYND-448a: re-index the restored note body UNFOLDED and re-derive its
    // separate attachment docs (parity with note_create/update/batch) so a
    // restore doesn't drop attachment searchability until the next unlock.
    // Mobile's `MobileHooks` no-ops these search/AI hooks (its index is fed
    // TS-side), so `index_note_attachments` indexes nothing there.
    let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
    // MYND-448a: re-index the restored note body UNFOLDED + separate attachment docs.
    // SF5 (MYND-502): a restored `kind: drawing` note must index its projected
    // scene text, not the raw ```excalidraw JSON (SYNC-4 body-only) and no
    // attachment docs — parity with note_create/update/batch, else a restore
    // repollutes the index.
    if crate::plugins::notes::drawing_text::is_drawing(plaintext.as_bytes()) {
        let body = crate::plugins::notes::drawing_text::project_drawing_text(plaintext.as_bytes())
            .unwrap_or_default();
        hooks.search_upsert(&note_id, &title, &body);
    } else {
        hooks.search_upsert(&note_id, &title, &plaintext);
        hooks
            .index_note_attachments(state, &note_id, &title, &plaintext)
            .await;
    }
    // MYND-453: keep the live AI embedding index correct too — `note_update`
    // does not fire the re-index hooks itself (its callers do), and this restore
    // path re-indexed search directly above but left the AI vectors stale
    // (pre-restore content). Re-embed the restored note over its prose (parity
    // with the create/update path — 448a); feature/ai-gated + detached, no-op
    // when AI is off.
    hooks.ai_note_changed(&note_id, &plaintext);

    Ok(())
}

/// Restore a selected snapshot, atomically capturing the current state as the
/// undo point first.
pub async fn snapshot_restore_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    note_id: String,
    snapshot_uuid: String,
    // Takes the seam rather than naming `StdVaultIo` internally: this function
    // is NOT gated off wasm32, and `StdVaultIo` is — so hardcoding the native
    // arm here broke the wasm build of a crate that otherwise compiles fine.
    // Threading it keeps the choice at the edge, where the host already is.
    io: &dyn crate::vault_io::VaultIo,
    registry: Option<&crate::plugins::live::LiveSessionRegistry>,
) -> Result<(), SnapshotError> {
    let notes_dir = resolve_notes_dir(host, io, state.active_vault_id().await).await?;
    snapshot_restore_in(
        notes_dir,
        state,
        hooks,
        note_id,
        snapshot_uuid,
        io,
        host,
        registry,
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

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn snapshot_restore<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    registry: State<'_, crate::plugins::live::LiveSessionRegistry>,
    note_id: String,
    snapshot_uuid: String,
) -> Result<(), SnapshotError> {
    snapshot_restore_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        note_id,
        snapshot_uuid,
        &crate::vault_io::StdVaultIo,
        Some(registry.inner()),
    )
    .await
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
        Slot::Empty | Slot::Recovering { .. } | Slot::ImportSource { .. } => {
            return Err(SnapshotError::VaultNotUnlocked)
        }
    }

    let note_uuid = note_id.as_uuid().to_string();
    let now_ms = crate::snapshot_store::now_unix_ms();
    let removed = crate::task::run_blocking(move || {
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
pub async fn snapshot_prune_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    note_id: String,
) -> Result<u32, SnapshotError> {
    let snapshots_dir = resolve_snapshots_dir(host, state.active_vault_id().await)?;
    snapshot_prune_in(snapshots_dir, state, note_id)
        .await
        .inspect_err(|e| {
            tracing::debug!(
                stage = "snapshot_prune",
                error_kind = snapshot_error_kind(e),
                "snapshot command failed"
            )
        })
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn snapshot_prune<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    note_id: String,
) -> Result<u32, SnapshotError> {
    snapshot_prune_from_host(&TauriHost::new(app), state.inner(), note_id).await
}

// ---- path resolution ----------------------------------------------------

fn resolve_snapshots_dir(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, SnapshotError> {
    paths::snapshots_dir_for_host(host, active_id).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotADirectory | std::io::ErrorKind::AlreadyExists => {
            SnapshotError::NotesDirNotADirectory
        }
        other => SnapshotError::Io {
            io_error_kind: from_io_error_kind(other),
        },
    })
}

/// Through the IO seam, not `std::fs` (myne#299). This function is not gated
/// off wasm32, and the `std::fs` sibling's `Path::is_dir` root check is the
/// unsupported-platform stub there — always false. Snapshots are a port still
/// owed on web, so this was latent rather than live; routing it through the seam
/// now means it will not be the next thing to ship dead.
async fn resolve_notes_dir(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    active_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, SnapshotError> {
    paths::notes_dir_for_host_io(host, io, active_id)
        .await
        .map_err(|e| match e.kind() {
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

    /// A `Hooks` whose snapshot-capture / -purge methods do the REAL snapshot
    /// write/purge via the `myne-core` `snapshot_store` / `snapshot_policy` /
    /// `paths` primitives (a faithful inline of the desktop
    /// `capture_snapshot_best_effort`), with every other hook a no-op. These
    /// tests assert that `note_update_with_dir` and `snapshot_restore_in`
    /// actually write / purge snapshots, so the capture path must be live; the
    /// index/sync side-effects are irrelevant here. Avoids needing an
    /// `AppHandle` / `tauri::test` harness (TB9 Cargo.lock discipline) — the
    /// `ClampHooks` precedent in `prefs/mod.rs`.
    struct SnapshotHooks;
    impl crate::hooks::VaultLifecycleHooks for SnapshotHooks {
        fn hydrate_attachment_refs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(&'a self, _: &'a VaultRuntimeState) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_ai_vectors<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn index_note_attachments<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> crate::hooks::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn agent_teardown_on_lock(&self) {}
        fn detached_windows_teardown_on_lock(&self) {}
        fn live_session_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn ai_note_changed(&self, _: &str, _: &str) {}
        fn ai_note_deleted(&self, _: &str) {}
        fn ai_policy_changed(&self, _: bool, _: &[String]) {}
        fn bump_local_change(&self) {}
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn emit_notes_deleted(&self, _: &str) {}
        // `effective_auto_lock_secs` deliberately not overridden: the trait's
        // default clamps (myne-md/myne#479). This body used to be the unclamped
        // `unwrap_or`, which is the exact shape that change removed from two
        // production clients, so a fixture carrying it handed the next author
        // the defect as the copyable example.
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn preempt_inflight_backup<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> crate::hooks::BoxFuture<'a> {
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
            // Faithful inline of the desktop `capture_snapshot_best_effort`,
            // built on the `myne-core` snapshot_store / snapshot_policy / paths
            // primitives so these tests exercise real snapshot writes without
            // the desktop crate. Best-effort: a dir-create / write failure
            // returns `true` (the warning bool), a coalesced skip returns
            // `false`, and a prune failure is swallowed (the snapshot landed).
            let Ok(sdir) = crate::paths::snapshots_dir_under(vault_root) else {
                return true;
            };
            let existing =
                crate::snapshot_store::list_note_snapshots(&sdir, note_uuid).unwrap_or_default();
            let last = existing.first().map(|s| s.captured_at_ms);
            if !crate::snapshot_policy::should_snapshot(last, now_ms, force) {
                return false;
            }
            let snap_uuid = crate::snapshot_store::new_snapshot_uuid().to_string();
            if crate::snapshot_store::write_snapshot_blob(&sdir, note_uuid, &snap_uuid, old_blob)
                .is_err()
            {
                return true;
            }
            let _ = crate::snapshot_store::prune_note_snapshots(
                &sdir,
                note_uuid,
                now_ms,
                &crate::snapshot_policy::RetentionPolicy::default(),
            );
            false
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

    fn noop_hooks() -> crate::hooks::Hooks {
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

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // No snapshot yet (create doesn't snapshot).
            assert!(snapshot_list_in(
                sdir.clone(),
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id.clone()
            )
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
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();

            let list = snapshot_list_in(
                sdir,
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id,
            )
            .await
            .unwrap();
            assert_eq!(list.len(), 1);
            assert!(list[0].size_bytes > 0);
        });
    }

    /// Mark `vault_root` as a v0.2 vault so the `notes` plugin writes `NC05`.
    ///
    /// Only the magic is read (`meta_version_of`), so the rest is filler — but
    /// it is a REAL `NTV5` serialization rather than four hand-written bytes, so
    /// the fixture cannot drift from the format it claims to be.
    fn mark_vault_v0_2(vault_root: &std::path::Path) {
        let meta = protocol::VaultMeta {
            account_number_hash: [0x2b; 16],
            kdf_params: crate::test_support::FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [FIXTURE_ITEMS_ID_BYTE; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
            person_binding: None,
        };
        std::fs::write(
            vault_root.join("vault.meta"),
            protocol::serialize_vault_meta_v0_2(&meta),
        )
        .expect("write NTV5 vault.meta");
    }

    /// A CRDT note's version history comes from its own change graph.
    ///
    /// This is the read side of the snapshots retirement: `NC05` notes capture
    /// no `snapshots/` entries at all, so before this arm existed the history
    /// panel of every note in a v0.2 vault was permanently empty — a feature
    /// that silently disappeared for anyone whose vault was migrated, and (once
    /// v0.2 became the birth format) for every new user. The list must be
    /// non-empty, newest-first, and each id must preview to the text as it stood
    /// at that revision.
    #[test]
    fn a_crdt_notes_history_comes_from_its_change_graph() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-crdt-history").unwrap();
            mark_vault_v0_2(scratch.path());
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;

            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# v1\nfirst".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // The note really is NC05 — otherwise this test would pass through
            // the `snapshots/` arm and assert nothing about the CRDT path.
            let blob = std::fs::read(notes_dir.join(format!("{id}.myn"))).unwrap();
            assert!(crate::plugins::notes::crdt::is_nc05_blob(&blob));

            for body in ["# v2\nsecond", "# v3\nthird"] {
                note_update_with_dir(
                    notes_dir.clone(),
                    &state,
                    &noop_hooks(),
                    id.clone(),
                    body.to_string(),
                    None,
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost,
                )
                .await
                .unwrap();
            }

            // `snapshots/` holds nothing for this note, by design.
            assert!(!sdir.join(&id).exists());

            let list = snapshot_list_in(
                sdir.clone(),
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id.clone(),
            )
            .await
            .unwrap();
            assert_eq!(list.len(), 3, "one revision per committed edit");
            assert!(
                list[0].captured_at_ms >= list[list.len() - 1].captured_at_ms,
                "newest-first"
            );
            // The size the UI renders is the revision's real encoded size, not a
            // placeholder — a "0 B" row beside every entry is the shape this
            // assertion exists to keep out.
            assert!(list.iter().all(|r| r.size_bytes > 0), "real revision sizes");

            // The OLDEST revision previews as the original text.
            let oldest = list.last().unwrap().snapshot_uuid.clone();
            let preview = snapshot_preview_in(sdir.clone(), &state, id.clone(), oldest.clone())
                .await
                .unwrap();
            assert_eq!(preview, "# v1\nfirst");

            // …and restoring it puts that text back on the live note, without
            // writing a `snapshots/` entry (the undo point is the revision list).
            snapshot_restore_in(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                oldest,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                None,
            )
            .await
            .unwrap();
            let after = std::fs::read(notes_dir.join(format!("{id}.myn"))).unwrap();
            let text = crate::plugins::notes::crdt::decode_note_blob(
                &after,
                id.parse::<uuid::Uuid>().unwrap().as_bytes(),
                &[FIXTURE_ITEMS_BYTE; 32],
                &[FIXTURE_ITEMS_ID_BYTE; 16],
            )
            .unwrap();
            assert_eq!(text, "# v1\nfirst");
            assert!(!sdir.join(&id).exists(), "no v0.1 snapshot artefact");

            // The restore itself is a revision, so history GREW rather than
            // rewound — which is what makes it undoable.
            let after_list = snapshot_list_in(
                sdir,
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id,
            )
            .await
            .unwrap();
            assert_eq!(after_list.len(), 4);
        });
    }

    /// A revision id the note does not carry is `SnapshotNotFound`, not an empty
    /// preview — a stale list must not silently render a blank note.
    #[test]
    fn a_crdt_preview_rejects_an_unknown_revision() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("snap-crdt-unknown").unwrap();
            mark_vault_v0_2(scratch.path());
            let notes_dir = notes_dir_under(scratch.path()).unwrap();
            let sdir = snapshots_dir_under(scratch.path()).unwrap();
            let state = unlocked().await;

            let id = note_create_with_dir(
                notes_dir,
                &state,
                "body".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            let bogus = "0".repeat(64);
            assert_eq!(
                snapshot_preview_in(sdir, &state, id, bogus).await,
                Err(SnapshotError::SnapshotNotFound)
            );
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
                snapshot_list_in(
                    sdir,
                    &state,
                    &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                    phantom
                )
                .await,
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
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                v1.to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "# v2".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();

            let snap_uuid = snapshot_list_in(
                sdir.clone(),
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id.clone(),
            )
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
            let id = note_create_with_dir(
                notes_dir,
                &state,
                "v1".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
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
            let id = note_create_with_dir(
                notes_dir,
                &state,
                "v1".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
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

            let v1 = "# v1\noriginal body";
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                v1.to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                "# v2\nedited".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();

            // One snapshot exists: S1 = v1. Live note = v2.
            let s1 = snapshot_list_in(
                sdir.clone(),
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id.clone(),
            )
            .await
            .unwrap()[0]
                .snapshot_uuid
                .clone();

            // Restore S1 (v1).
            snapshot_restore_in(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id.clone(),
                s1,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                None,
            )
            .await
            .unwrap();

            // Live note is now v1 again.
            let note_id = NoteId::parse(&id).unwrap();
            let items_key = [FIXTURE_ITEMS_BYTE; 32];
            let items_key_id = [FIXTURE_ITEMS_ID_BYTE; 16];
            let live = std::fs::read(notes_dir.join(format!("{}.myn", note_id.as_uuid()))).unwrap();
            let dec = protocol::decode_note(
                &live,
                note_id.as_uuid().as_bytes(),
                &items_key,
                &items_key_id,
            )
            .unwrap();
            assert_eq!(dec.plaintext(), v1.as_bytes());

            // Two snapshots now: S1 (v1) + the undo point (pre-restore = v2).
            let list = snapshot_list_in(
                sdir,
                &state,
                &crate::plugins::sync::identity_resolver::IdentityIndex::default(),
                id,
            )
            .await
            .unwrap();
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
            let id = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "v1".to_string(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            note_update_with_dir(
                notes_dir,
                &state,
                &noop_hooks(),
                id.clone(),
                "v2".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .unwrap();
            // The lone snapshot is recent → retention keeps it.
            assert_eq!(snapshot_prune_in(sdir, &state, id).await.unwrap(), 0);
        });
    }
}
