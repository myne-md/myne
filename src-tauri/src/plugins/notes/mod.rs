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

pub mod commands;
pub mod error;
pub(crate) mod export_mtime;
pub mod note_id;
pub mod search_sync;
pub(crate) mod title_extract;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `notes` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("notes")
        .invoke_handler(tauri::generate_handler![
            commands::note_create,
            commands::note_read,
            commands::note_update,
            commands::note_delete,
            commands::note_list,
            commands::note_titles_batch,
            commands::note_search,
            commands::note_snapshot_flush,
            commands::note_export_as_markdown,
            commands::note_export_attachments,
        ])
        .build()
}
