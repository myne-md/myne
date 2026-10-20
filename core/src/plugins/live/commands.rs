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

use crate::hooks::Hooks;
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

/// A bounded, content-free tag for a live-session refusal (myne-md/myne#894).
///
/// The agent's live-session write arm used to flatten its error to
/// `AgentError::WriteFailed` with no trace, so the one flow the live partition
/// exists for (approve an edit on the note you are reading) produced no line at
/// all. A closed match rather than `Display`, for the same reason
/// `note_batch_error_kind` is: the log may be sent to a maintainer, so it carries
/// a label and never a path, an id or a message.
pub fn live_session_error_kind(e: &LiveSessionCommandError) -> &'static str {
    match e {
        LiveSessionCommandError::VaultNotUnlocked => "vault_not_unlocked",
        LiveSessionCommandError::InvalidNoteId => "invalid_note_id",
        LiveSessionCommandError::NoteNotFound => "note_not_found",
        LiveSessionCommandError::CannotDecrypt => "cannot_decrypt",
        LiveSessionCommandError::Malformed => "malformed",
        LiveSessionCommandError::PlaintextTooLarge => "plaintext_too_large",
        LiveSessionCommandError::NotOnCharBoundary => "not_on_char_boundary",
        LiveSessionCommandError::OutOfBounds => "out_of_bounds",
        LiveSessionCommandError::NotOpen => "not_open",
        LiveSessionCommandError::DrawingNotApplicable => "drawing_not_applicable",
        LiveSessionCommandError::Csprng => "csprng",
        LiveSessionCommandError::Io { .. } => "io",
    }
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
    hooks: &Hooks,
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
    // The flush owns the indexing (myne-md/myne#867): a live-owned note's save
    // owes the same live-index side effects a stateless `note_update` performs,
    // and `flush_live_session_to_dir` fires them for EVERY caller, so the editor
    // save, the close and the sync cycle's post-pull merge are one mechanism
    // rather than three copies.
    flush_session(host, state, registry, hooks, io, &note_id_str).await?;
    Ok(())
}

/// Feed a live-owned note's saved body into the live indexes: the same side
/// effects a stateless `note_update` performs (search body doc, per-attachment
/// docs, AI re-embed, and a REMOVAL for a tombstone), because a live-owned note
/// never takes that path (`SYNC-33`).
///
/// Called from [`flush_live_session_to_dir`], which is the single durable writer's
/// one exit, so every caller of the flush is covered by construction: the editor's
/// whole-markdown save, the close, and the sync cycle's post-pull merge. The
/// failure this closes is that the whole editor path bypassed the search index, so
/// content typed in a live-owned note was unfindable for the rest of the session,
/// and the lock-time persist then sealed that stale index against an on-disk
/// manifest that already matched, so the next unlock's hydrate skipped the note and
/// the staleness survived the relock.
///
/// Every call that ADDS plaintext to an index goes through [`while_unlocked`] for
/// the session's own vault, and the reason is the lock path's ordering rather than
/// anything here (myne-md/myne#867 review). A flush that is already past its disk
/// write when the vault locks still reaches this function, and "the session is
/// still in the registry" says nothing about the vault: on the manual lock the
/// slot is dropped and the search index wiped BEFORE the live sessions are
/// cleared, so a session-only check let the note's title and body back into the
/// index the lock had just zeroized. The attachment await widens that window, so
/// the state is checked again after it.
async fn index_live_note(
    hooks: &Hooks,
    state: &VaultRuntimeState,
    vault_id: &str,
    note_id: &str,
    markdown: &str,
) {
    use crate::plugins::notes::daily_match::fm_deleted_value_strict;
    use crate::plugins::notes::drawing_text::{is_drawing, project_drawing_text};
    use crate::plugins::notes::title_extract::{extract_title_slices, resolve_note_title};
    let title = resolve_note_title(markdown.as_bytes()).unwrap_or_default();
    // A tombstone is a removal from the index, not a re-index of it (test-audit
    // #20, mirrored from `note_update`). With sync configured a permanent delete
    // is a `deleted:` frontmatter stamp written through `noteUpdate`, and for a
    // note open in a live session that write is routed into the session
    // (`live_session_patch_frontmatter`) and reaches the index here. Upserting it
    // put the purged note's full body back into the live search index, which the
    // lock then sealed into `vault.search`.
    let fm_bytes = extract_title_slices(markdown.as_bytes()).frontmatter_bytes;
    if fm_bytes.and_then(fm_deleted_value_strict).is_some() {
        // A removal carries no plaintext, so it is not gated: dropping a doc from
        // an index the lock already wiped is a no-op, never a leak.
        hooks.search_remove(note_id);
        return;
    }
    // The same drawing fold as the stateless writers (SF5 / SYNC-4): a drawing
    // body is scene JSON, so its doc is the projected text and it gets no
    // attachment docs. A live session is refused for a drawing today
    // (`live_session_applies`), so this arm is parity rather than a live case.
    if is_drawing(markdown.as_bytes()) {
        let body = project_drawing_text(markdown.as_bytes()).unwrap_or_default();
        let _ = while_unlocked(state, vault_id, || {
            hooks.search_upsert(note_id, &title, &body)
        })
        .await;
        return;
    }
    if !while_unlocked(state, vault_id, || {
        hooks.search_upsert(note_id, &title, markdown)
    })
    .await
    {
        return;
    }
    // Not run under the slot guard: the hook resolves the vault through
    // `state` itself, and a nested read on a tokio `RwLock` with a lock's
    // write queued behind the outer guard deadlocks. It refuses a locked
    // vault on its own key peek.
    hooks
        .index_note_attachments(state, note_id, &title, markdown)
        .await;
}

/// Run `index` only if `vault_id` is still `Unlocked`, HOLDING that slot's read
/// guard across the call, and report whether it ran (myne-md/myne#867 review).
///
/// The guard is what makes this a gate rather than a hint. A bare "is it unlocked"
/// probe followed by the hook leaves the lock free to land between the two, and
/// every lock path drops the slot under its WRITE guard before it wipes the search
/// index (`lock_with_state` and the switch's `set_unlocked_locking_others` on the
/// manual paths, the idle take on auto-lock). Holding the read guard therefore
/// orders the hook strictly before the wipe or strictly after the slot left,
/// which is the case refused here. `index` must stay synchronous and must not
/// touch `state`: a nested read behind a queued writer deadlocks.
async fn while_unlocked(state: &VaultRuntimeState, vault_id: &str, index: impl FnOnce()) -> bool {
    // A session keyed by an id that does not parse belongs to no slot, so it has
    // no unlocked vault to index into.
    let Ok(id) = crate::vault_id::VaultId::parse(vault_id) else {
        return false;
    };
    let slot = state.slot_read(id).await;
    if !matches!(&*slot, Slot::Unlocked(_)) {
        return false;
    }
    index();
    true
}

/// Close a live session: flush the pending durable write, then drop it. Returns
/// [`LiveSessionCommandError::NotOpen`] if no session is open.
pub async fn live_session_close_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    registry: &LiveSessionRegistry,
    hooks: &Hooks,
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
    // The close flushes through the same exit as a save, so a session made dirty
    // by the live channel (`apply_remote_change`, which does not itself persist) is
    // indexed on the way out rather than written to disk with a stale index.
    flush_session(host, state, registry, hooks, io, &note_id_str).await?;
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
    hooks: &Hooks,
    io: &dyn VaultIo,
    note_id_str: &str,
) -> Result<(), LiveSessionCommandError> {
    let (notes_dir, _vault_root, items_key, items_key_id) = resolve(host, state, io).await?;
    flush_live_session_to_dir(
        io,
        &notes_dir,
        registry,
        LiveIndexCtx { state, hooks },
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

/// The live-index context a flush needs after its durable write: the runtime
/// state (which the attachment hook resolves the vault from) and the hooks seam.
/// Bundled rather than passed as two more positional arguments so
/// [`flush_live_session_to_dir`] stays inside clippy's argument budget without an
/// `allow`; both callers already hold the two values.
pub(crate) struct LiveIndexCtx<'a> {
    pub state: &'a VaultRuntimeState,
    pub hooks: &'a Hooks,
}

/// Seal a session's document under the registry lock, write it OUTSIDE the lock
/// (serialized with the sync pull's note write under `notes_write_mutex`, the §11.3
/// linearizability point), then mark the heads durable and feed the live indexes.
/// No-op if nothing is dirty.
///
/// Shared by the command path (which resolves the dir from host+state) and the sync
/// cycle's post-pull merge (`collab-editor-bridge` task 7), which already holds the
/// notes dir + keys. It is the ONE exit through which a live-owned note reaches
/// disk (`SYNC-33`), so the index side effects live here rather than at either
/// caller: a fix on the editor-save path alone left a remote merge followed by a
/// close with a stale index, which the lock-time persist then sealed.
pub(crate) async fn flush_live_session_to_dir(
    io: &dyn VaultIo,
    notes_dir: &std::path::Path,
    registry: &LiveSessionRegistry,
    index: LiveIndexCtx<'_>,
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
    // The body text arrives WITH the blob, captured under the same acquisition as
    // the seal (see `SealedFlush`), so the index below describes the document that
    // reached disk rather than whatever the session holds a disk-write later. A
    // body that could not be read at the seal arrives as `None`: the blob is
    // still written (it is the user's edit), and the note's search doc is
    // removed rather than left describing an older body.
    let Some((blob, heads, markdown)) = sealed else {
        return Ok(());
    };
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
    // Mark the heads durable, then index OUTSIDE the lock: the attachment hook
    // awaits IO, and the registry mutex must never be held across an await.
    //
    // The mark also answers whether the session is still open, and indexing is
    // skipped when it is not, so a close or a delete that removed the session is
    // not followed by a re-index that resurrects a search doc it just dropped.
    // That check does NOT cover a lock: the lock path wipes the search index
    // before it clears the sessions, so a session can still be registered for a
    // vault that is already locked. The lock is answered by vault state inside
    // `index_live_note`, which re-checks the session's own vault before every
    // hook that adds plaintext (myne-md/myne#867 review).
    let open_in = registry.with_note_mut(note_id_str, |s| {
        s.mark_flushed(heads);
        s.key().0.clone()
    });
    if let Some(vault_id) = open_in {
        match markdown {
            Some(markdown) => {
                index_live_note(index.hooks, index.state, &vault_id, note_id_str, &markdown).await;
            }
            None => {
                // No `note_id` FIELD. It is on `src-tauri/AGENTS.md`'s DENY list
                // (a per-note vault-stable correlation tag), and this level
                // reaches the desktop's opt-in log file, which the user is
                // invited to attach to a public issue. The message already says
                // what happened, which is the actionable half a report needs
                // (myne#892 review).
                tracing::warn!(
                    event = "live_flush_body_unreadable",
                    "live flush wrote a document whose body could not be read; search doc removed"
                );
                index.hooks.search_remove(note_id_str);
            }
        }
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
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    note_id: String,
    markdown: String,
) -> Result<(), LiveSessionCommandError> {
    live_session_patch_frontmatter_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        registry.inner(),
        hooks.inner(),
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
    hooks: tauri::State<'_, crate::hooks::Hooks>,
    note_id: String,
) -> Result<(), LiveSessionCommandError> {
    live_session_close_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        registry.inner(),
        hooks.inner(),
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
