//! `notes` plugin — host-side per-note CRUD + listing.
//!
//! Five Tauri commands: `note_create`, `note_read`, `note_update`,
//! `note_delete`, `note_list` (the last added in MYND-28). Each
//! command pattern-matches `Slot::Unlocked(_) => ...` only;
//! `Slot::Recovering` is rejected at compile time per
//! `recovery-flow.md` §4.1. The plugin holds no own state and borrows
//! `VaultRuntimeState` cross-plugin (`vault_recover` precedent;
//! `decisions.md` 2026-05-02 "Slot state machine + auth_permits
//! generalization").
//!
//! `note_list` is metadata-only — no AEAD, no slot-side `items_key`
//! clone — and joins the uniform `spawn_blocking` pattern even though
//! the inner `read_dir` is theoretically cheap (Q4e of the MYND-28
//! grilling: NFS / FUSE / AV-overlay topology violates the
//! laboratuvar "ucuz" assumption). It is the cheap half of the
//! two-tier sidebar virtualization design (MYND-28 grill Q1); the
//! companion `note_titles_batch` (MYND-134) lazily decrypts the
//! viewport-visible titles.
//!
//! Capability ACL `notes:default` declares all five `allow-note-<verb>`
//! permissions; `permissions/notes/default.toml` + `build.rs
//! InlinedPlugin::commands` lock-stepped per `decisions.md` 2026-05-07
//! "notes plugin scaffold + cross-plugin VaultRuntimeState borrow".

// The platform-agnostic CRUD command core (`commands`), the `NoteId` identifier
// (`note_id`), the title-extraction helpers (`title_extract`), and the error
// enums (`error`) moved to `myne-core` (shared with the mobile client).
// Re-exported so existing `crate::plugins::notes::{commands,error,note_id,
// title_extract}::…` paths keep resolving.
pub use myne_core::plugins::notes::{commands, error, note_id, title_extract};

// Desktop-only note commands: export, full-text search, snapshot flush, and the
// attachment-reference scan — they reach into desktop-only subsystems (search
// index, snapshot store, attachments) and stay in this crate.
pub mod desktop_commands;
pub(crate) mod export_mtime;
pub mod search_sync;

// Surfaced at the `notes` module root so the desktop `hooks::DesktopHooks`
// can reach the snapshot-capture free-fn and the snapshot-write-failed event
// name without depending on whichever module currently owns them. The capture
// free-fn now lives desktop-side (`desktop_commands`); the event-name const
// stays in the core CRUD module (`note_update` emits it via the hook seam).
pub(crate) use desktop_commands::capture_snapshot_best_effort;
pub(crate) use myne_core::plugins::notes::commands::SNAPSHOT_WRITE_FAILED_EVENT;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `notes` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("notes")
        .invoke_handler(tauri::generate_handler![
            commands::note_create,
            commands::note_read,
            commands::note_update,
            commands::note_write_batch_transactional,
            commands::note_delete,
            commands::note_list,
            commands::note_titles_batch,
            desktop_commands::note_search,
            desktop_commands::note_snapshot_flush,
            desktop_commands::note_export_as_markdown,
            desktop_commands::note_export_attachments,
            desktop_commands::note_export_html,
            desktop_commands::note_export_html_attachments,
        ])
        .build()
}
