//! `attachments` reconcile IPC command set (MYND-169 / MYND-170, SYNC-6).
//!
//! The IPC surface over the in-RAM attachment reference graph
//! ([`super::reconcile::AttachmentRefsState`]) — the *wiring* deferred by
//! `reconcile.rs`'s `TODO(attachments reconcile)`. Mirrors the
//! `vault_indices` Build-B pattern EXACTLY: dialect extraction is TS-side
//! (the single shared tokenizer per SYNC-6), so these commands receive
//! already-extracted attachment-ids — they never parse markdown — and
//! delegate to the managed state.
//!
//! - [`attachment_refs_apply`] — `Slot::Unlocked`-gated replace-on-apply
//!   of a note's referenced attachment-ids. TS calls this per note during
//!   the rebuild-on-unlock sweep and on every live note-lifecycle op
//!   (save / create / rename-move), piggybacking the existing
//!   VaultIndices reindex calls (`extractAttachmentIds` of the body).
//! - [`attachment_refs_remove`] — `Slot::Unlocked`-gated removal of a
//!   hard-deleted note from the graph.
//! - [`attachment_refs_referencing`] — `Slot::Unlocked`-gated query of the
//!   note-ids referencing one attachment-id (the library's "used in N
//!   notes" count + the delete-warning's note list).
//!
//! All three are gated on `Slot::Unlocked` because the graph is
//! plaintext-derived RAM that only exists while a vault is open — the same
//! posture as `vault_indices`. The slot-gate reject reuses
//! [`super::error::AttachmentRefsError`].
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::AttachmentRefsError;
use super::reconcile::AttachmentRefsState;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::State;

/// Replace the set of attachment-ids a note references (replace-on-apply).
///
/// Build-B: the ids arrive already extracted TS-side (the shared
/// `extractAttachmentIds` tokenizer — the twin of the Rust
/// `extract_att_ids`, SYNC-6), so this command never parses markdown.
/// Re-applying a note id fully overwrites its prior id set, so an edit
/// that removes an embed drops the stale reference. Rejected with
/// [`AttachmentRefsError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn attachment_refs_apply_from_host(
    note_id: String,
    attachment_ids: Vec<String>,
    runtime: &VaultRuntimeState,
    refs: &AttachmentRefsState,
) -> Result<(), AttachmentRefsError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(AttachmentRefsError::SlotNotUnlocked);
    }
    refs.apply(&note_id, attachment_ids);
    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_refs_apply(
    note_id: String,
    attachment_ids: Vec<String>,
    runtime: State<'_, VaultRuntimeState>,
    refs: State<'_, AttachmentRefsState>,
) -> Result<(), AttachmentRefsError> {
    attachment_refs_apply_from_host(note_id, attachment_ids, runtime.inner(), refs.inner()).await
}

/// Remove a hard-deleted note from the reference graph (no-op if absent).
///
/// Trash does NOT route here — a trashed note's references stay in the
/// graph and are filtered TS-side via the live id-set, mirroring the
/// `vault_indices` trash posture. Only hard-delete / empty-trash removes.
/// Rejected with [`AttachmentRefsError::SlotNotUnlocked`] when no vault is
/// unlocked.
pub async fn attachment_refs_remove_from_host(
    note_id: String,
    runtime: &VaultRuntimeState,
    refs: &AttachmentRefsState,
) -> Result<(), AttachmentRefsError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(AttachmentRefsError::SlotNotUnlocked);
    }
    refs.remove(&note_id);
    Ok(())
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_refs_remove(
    note_id: String,
    runtime: State<'_, VaultRuntimeState>,
    refs: State<'_, AttachmentRefsState>,
) -> Result<(), AttachmentRefsError> {
    attachment_refs_remove_from_host(note_id, runtime.inner(), refs.inner()).await
}

/// The note-ids referencing `attachment_id`, sorted for determinism.
///
/// The library renders this as the "used in N notes" count (`.length`)
/// plus the clickable referencing-note list; the delete-warning names them
/// (SYNC-6 amended — exposes ids, not just a count). Empty when the
/// attachment is unreferenced. Rejected with
/// [`AttachmentRefsError::SlotNotUnlocked`] when no vault is unlocked.
pub async fn attachment_refs_referencing_from_host(
    attachment_id: String,
    runtime: &VaultRuntimeState,
    refs: &AttachmentRefsState,
) -> Result<Vec<String>, AttachmentRefsError> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Err(AttachmentRefsError::SlotNotUnlocked);
    }
    Ok(refs.referencing_notes(&attachment_id))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_refs_referencing(
    attachment_id: String,
    runtime: State<'_, VaultRuntimeState>,
    refs: State<'_, AttachmentRefsState>,
) -> Result<Vec<String>, AttachmentRefsError> {
    attachment_refs_referencing_from_host(attachment_id, runtime.inner(), refs.inner()).await
}
