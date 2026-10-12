// SPDX-License-Identifier: AGPL-3.0
//! The live co-editing session commands (epic live-collab, `collab-editor-bridge`
//! task 3).
//!
//! Three-layer shape like every other plugin core: a host-taking
//! `*_from_host` body, a thin `#[tauri::command]` wrapper gated on `tauri-ipc`
//! and non-wasm, and (for tests) direct calls to the body with a
//! `VaultRuntimeState` under a `ScopedTempDir`.
//!
//! A live session is the SINGLE durable writer for its note while open
//! (`SYNC-33`): [`open`](live_session_open_from_host) loads the durable `NC05`
//! blob into the registry;
//! [`patch_frontmatter`](live_session_patch_frontmatter_from_host) persists a
//! re-derived whole note (a local body edit arrives that way, and the CRDT layer
//! records it as minimal splices, so there is no separate client-side splice
//! entry point); [`close`](live_session_close_from_host) flushes and drops it.
//! `note_update` for the same note is refused with `NoteUpdateError::LiveSessionOpen`
//! meanwhile.
//!
//! The transport (task 4) carries the change bytes; the awareness frame codec and
//! the relay are other layers.

use crate::host::HostCtx;
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::paths;
use crate::plugins::live::{LiveSession, LiveSessionError, LiveSessionRegistry};
use crate::plugins::notes::note_id::NoteId;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use crate::vault_io::{VaultIo, WriteOpts};
use serde::Serialize;
use std::path::PathBuf;

/// A failure opening, applying to, or closing a live session, across the IPC
/// boundary. Closed enum, no `String` field; hand-mirrored on the TS side in
/// `client-core/src/types/live-session-error.ts`.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum LiveSessionCommandError {
    /// The slot is not `Unlocked`.
    #[error("vault not unlocked")]
    VaultNotUnlocked,
    /// `note_id` failed strict parse (`NoteId` bug-canary).
    #[error("invalid note id")]
    InvalidNoteId,
    /// `<vault>/notes/<note_id>.myn` is missing.
    #[error("note not found")]
    NoteNotFound,
    /// The durable blob failed to open (non-distinguishing per `protocol.md` §6.4).
    #[error("note cannot be decrypted")]
    CannotDecrypt,
    /// The decoded document is not a single-`Text` `NC05` document.
    #[error("live session document is malformed")]
    Malformed,
    /// The re-sealed blob would exceed `protocol::MAX_PLAINTEXT_LEN`.
    #[error("plaintext too large")]
    PlaintextTooLarge,
    /// A local edit range fell inside a surrogate pair (not a character boundary).
    #[error("edit range is not on a character boundary")]
    NotOnCharBoundary,
    /// A local edit range was inverted or two ranges overlapped.
    #[error("edit range is out of bounds")]
    OutOfBounds,
    /// No live session is open for this note (apply/close on a closed note).
    #[error("no live session for this note")]
    NotOpen,
    /// The note is a `kind: drawing` note, for which the CM6 live bridge does not
    /// apply (task 9). Storage is unchanged; only the live bridge's applicability
    /// is scoped to text/markdown notes.
    #[error("live sessions do not apply to drawing notes")]
    DrawingNotApplicable,
    /// Entropy unavailable re-sealing the `NC05` blob.
    #[error("csprng unavailable")]
    Csprng,
    /// A filesystem failure on the blob read or the durable write.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },
}

impl From<crate::plugins::live::apply_remote::ApplyRemoteError> for LiveSessionCommandError {
    fn from(_: crate::plugins::live::apply_remote::ApplyRemoteError) -> Self {
        LiveSessionCommandError::Malformed
    }
}

impl From<crate::plugins::live::apply_local::ApplyLocalError> for LiveSessionCommandError {
    fn from(e: crate::plugins::live::apply_local::ApplyLocalError) -> Self {
        use crate::plugins::live::apply_local::ApplyLocalError;
        match e {
            ApplyLocalError::NotOnCharBoundary => LiveSessionCommandError::NotOnCharBoundary,
            ApplyLocalError::OutOfBounds => LiveSessionCommandError::OutOfBounds,
            ApplyLocalError::Malformed => LiveSessionCommandError::Malformed,
        }
    }
}

impl From<LiveSessionError> for LiveSessionCommandError {
    fn from(e: LiveSessionError) -> Self {
        match e {
            LiveSessionError::CannotDecrypt => LiveSessionCommandError::CannotDecrypt,
            LiveSessionError::Malformed => LiveSessionCommandError::Malformed,
            LiveSessionError::TooLarge => LiveSessionCommandError::PlaintextTooLarge,
            LiveSessionError::Csprng => LiveSessionCommandError::Csprng,
            LiveSessionError::Io => LiveSessionCommandError::Io {
                io_error_kind: IoFailureKind::Other,
            },
        }
    }
}

/// Resolved command inputs: `(notes_dir, vault_root, items_key, items_key_id)`.
type Resolved = (PathBuf, PathBuf, zeroize::Zeroizing<[u8; 32]>, [u8; 16]);

/// Resolve `notes/`, its vault root, and the unlocked slot's keys, the shared
/// preamble of the three commands.
async fn resolve(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<Resolved, LiveSessionCommandError> {
    let notes_dir = paths::notes_dir_for_host_io(host, io, state.active_vault_id().await)
        .await
        .map_err(|e| LiveSessionCommandError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        })?;
    let vault_root = notes_dir
        .parent()
        .ok_or(LiveSessionCommandError::Io {
            io_error_kind: IoFailureKind::Other,
        })?
        .to_path_buf();
    let (items_key, items_key_id) = {
        let slot = state.slot_read_active().await;
        match &*slot {
            Slot::Unlocked(uv) => (uv.items_key.clone(), uv.items_key_id),
            _ => return Err(LiveSessionCommandError::VaultNotUnlocked),
        }
    };
    Ok((notes_dir, vault_root, items_key, items_key_id))
}

/// Open a live session for `note_id`: load the durable `NC05` blob under this
/// device's actor and register it. IDEMPOTENT, a second open for the same note
/// attaches to the existing session rather than opening a second (`SYNC-34`).
pub async fn live_session_open_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    registry: &LiveSessionRegistry,
    io: &dyn VaultIo,
    note_id: String,
) -> Result<(), LiveSessionCommandError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| LiveSessionCommandError::InvalidNoteId)?;
    let note_id_str = note_id.to_string();
    if registry.is_note_open(&note_id_str) {
        return Ok(()); // attach
    }
    let vault_id = state
        .active_vault_id()
        .await
        .map(|v| v.to_string())
        .ok_or(LiveSessionCommandError::VaultNotUnlocked)?;
    let (notes_dir, vault_root, items_key, items_key_id) = resolve(host, state, io).await?;

    let note_uuid = *note_id.as_uuid().as_bytes();
    let blob = io
        .read(&notes_dir.join(format!("{note_id_str}.myn")))
        .await
        .map_err(|k| match k {
            IoFailureKind::NotFound => LiveSessionCommandError::NoteNotFound,
            other => LiveSessionCommandError::Io {
                io_error_kind: other,
            },
        })?;
    let actor = crate::plugins::sync::state::read_device_actor(io, &vault_root).await;
    let session = LiveSession::open_from_blob(
        &blob,
        vault_id,
        note_id_str,
        note_uuid,
        actor,
        &items_key,
        &items_key_id,
    )?;
    // A `kind: drawing` note has no CM6 live buffer (task 9): refuse with the typed
    // result BEFORE registering, so no session exists for it.
    live_session_applies(&session)?;
    registry.insert(session);
    Ok(())
}

/// Whether a live session may be opened for `session` (`collab-editor-bridge` task
/// 9). A `kind: drawing` note is refused with [`LiveSessionCommandError::DrawingNotApplicable`]
/// before it is registered, so no live session exists for it.
pub(crate) fn live_session_applies(session: &LiveSession) -> Result<(), LiveSessionCommandError> {
    if session.is_drawing() {
        return Err(LiveSessionCommandError::DrawingNotApplicable);
    }
    Ok(())
}

/// The durable frontmatter entry point (task 3): persist a full re-derived note
/// (frontmatter patched + body) through the session. Semantically an apply; task 6
/// adds the reserved-region clamp, task 7 funnels the rename/move/delete writers
/// here so exactly one change graph writes the note.
pub async fn live_session_patch_frontmatter_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    registry: &LiveSessionRegistry,
    io: &dyn VaultIo,
    note_id: String,
    markdown: String,
) -> Result<(), LiveSessionCommandError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| LiveSessionCommandError::InvalidNoteId)?;
    let note_id_str = note_id.to_string();
    let now = host.now_unix_millis();
    // A durable frontmatter patch replaces the whole note text (the caller has
    // already re-derived the managed region, task 6), so it goes through the
    // whole-text update rather than the body-splice path.
    match registry.with_note_mut(&note_id_str, |s| s.apply_body_markdown(&markdown, now)) {
        None => return Err(LiveSessionCommandError::NotOpen),
        Some(Ok(())) => {}
        Some(Err(e)) => return Err(e.into()),
    }
    flush_session(host, state, registry, io, &note_id_str).await
}

/// Close a live session: flush the pending durable write, then drop it. Returns
/// [`LiveSessionCommandError::NotOpen`] if no session is open.
pub async fn live_session_close_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    registry: &LiveSessionRegistry,
    io: &dyn VaultIo,
    note_id: String,
) -> Result<(), LiveSessionCommandError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| LiveSessionCommandError::InvalidNoteId)?;
    let note_id_str = note_id.to_string();
    // Report `NotOpen` BEFORE touching the vault: a close on a note with no
    // session is a caller error, not a vault-state error, so it must not surface
    // `VaultNotUnlocked` from the flush's preamble.
    if !registry.is_note_open(&note_id_str) {
        return Err(LiveSessionCommandError::NotOpen);
    }
    flush_session(host, state, registry, io, &note_id_str).await?;
    registry
        .remove_note(&note_id_str)
        .ok_or(LiveSessionCommandError::NotOpen)?;
    Ok(())
}

/// Seal the session's document under the registry lock, write it OUTSIDE the
/// lock, then mark the heads durable. No-op if nothing is dirty.
async fn flush_session(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    registry: &LiveSessionRegistry,
    io: &dyn VaultIo,
    note_id_str: &str,
) -> Result<(), LiveSessionCommandError> {
    let (notes_dir, _vault_root, items_key, items_key_id) = resolve(host, state, io).await?;
    flush_live_session_to_dir(
        io,
        &notes_dir,
        registry,
        &items_key,
        &items_key_id,
        note_id_str,
    )
    .await
}

/// Drain the body splices a sync pull merged into this note's open session
/// (`collab-editor-bridge` task 7). The pane dispatches them as ONE `ChangeSet`, so
/// its buffer catches up with the merged document without a reload. Empty when no
/// pull merged while the session was open.
pub fn live_session_take_remote_splices_from_host(
    registry: &LiveSessionRegistry,
    note_id: String,
) -> Result<Vec<crate::plugins::live::apply_local::LocalSplice>, LiveSessionCommandError> {
    let note_id = NoteId::parse(&note_id).map_err(|_| LiveSessionCommandError::InvalidNoteId)?;
    Ok(registry.take_pending_splices(&note_id.to_string()))
}

/// Seal a session's document under the registry lock, write it OUTSIDE the lock
/// (serialized with the sync pull's note write under `notes_write_mutex`, the §11.3
/// linearizability point), then mark the heads durable. No-op if nothing is dirty.
///
/// Shared by the command path (which resolves the dir from host+state) and the sync
/// cycle's post-pull merge (`collab-editor-bridge` task 7), which already holds the
/// notes dir + keys.
pub(crate) async fn flush_live_session_to_dir(
    io: &dyn VaultIo,
    notes_dir: &std::path::Path,
    registry: &LiveSessionRegistry,
    items_key: &[u8; 32],
    items_key_id: &[u8; 16],
    note_id_str: &str,
) -> Result<(), LiveSessionCommandError> {
    let sealed =
        match registry.with_note_mut(note_id_str, |s| s.seal_for_flush(items_key, items_key_id)) {
            None => return Err(LiveSessionCommandError::NotOpen),
            Some(Ok(v)) => v,
            Some(Err(e)) => return Err(e.into()),
        };
    if let Some((blob, heads)) = sealed {
        let path = notes_dir.join(format!("{note_id_str}.myn"));
        // The guard is released before `mark_flushed` so the registry lock is not
        // held across it (and the two mutexes never nest).
        {
            let _notes_guard = crate::plugins::notes::commands::notes_write_mutex()
                .lock()
                .await;
            io.write(&path, &blob, WriteOpts::default())
                .await
                .map_err(|io_error_kind| LiveSessionCommandError::Io { io_error_kind })?;
        }
        registry.with_note_mut(note_id_str, |s| s.mark_flushed(heads));
    }
    Ok(())
}

// ── IPC wrappers (Tauri hosts only) ─────────────────────────────────────────
//
// Declared at the module top level, not nested in an inner `mod`: `#[tauri::command]`
// emits hidden `__cmd__<name>` items beside the fn, and `generate_handler!`
// resolves those as `commands::__cmd__<name>`. A nested module would leave them at
// `commands::ipc::__cmd__<name>` and the handler macro would not find them.

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn live_session_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    registry: tauri::State<'_, LiveSessionRegistry>,
    note_id: String,
) -> Result<(), LiveSessionCommandError> {
    live_session_open_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        registry.inner(),
        &crate::vault_io::StdVaultIo,
        note_id,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn live_session_patch_frontmatter<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    registry: tauri::State<'_, LiveSessionRegistry>,
    note_id: String,
    markdown: String,
) -> Result<(), LiveSessionCommandError> {
    live_session_patch_frontmatter_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        registry.inner(),
        &crate::vault_io::StdVaultIo,
        note_id,
        markdown,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn live_session_close<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, VaultRuntimeState>,
    registry: tauri::State<'_, LiveSessionRegistry>,
    note_id: String,
) -> Result<(), LiveSessionCommandError> {
    live_session_close_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        registry.inner(),
        &crate::vault_io::StdVaultIo,
        note_id,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub fn live_session_take_remote_splices(
    registry: tauri::State<'_, LiveSessionRegistry>,
    note_id: String,
) -> Result<Vec<crate::plugins::live::apply_local::LocalSplice>, LiveSessionCommandError> {
    live_session_take_remote_splices_from_host(registry.inner(), note_id)
}

/// Record this device's local caret/selection for an open note so peers render its
/// cursor (`collab-presence-ui`), and set the participant label this device
/// advertises. Best-effort: a note with no open session is a no-op (the editor may
/// report a selection before the session opens or after it closes), and the label is
/// stored once per device on the awareness signal. Infallible by design, presence is
/// cosmetics and must never surface an error on a keystroke path.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub fn live_session_set_presence(
    registry: tauri::State<'_, LiveSessionRegistry>,
    signal: tauri::State<'_, crate::plugins::sync::awareness_listener::AwarenessSignal>,
    note_id: String,
    cursor: Option<u32>,
    selection: Option<(u32, u32)>,
    label: Option<String>,
) {
    signal.set_local_label(label);
    let _ = registry.with_note_mut(&note_id, |s| s.set_local_presence(cursor, selection));
}
