//! `notes` plugin — host-side per-note CRUD + listing (mobile).
//!
//! Seven Tauri commands: `note_create`, `note_read`, `note_update`,
//! `note_write_batch_transactional`, `note_delete`, `note_list`,
//! `note_titles_batch`. Each command pattern-matches `Slot::Unlocked(_) => ...`
//! only; `Slot::Recovering` is rejected at compile time per
//! `recovery-flow.md` §4.1. The plugin holds no own state and borrows
//! `VaultRuntimeState` cross-plugin.
//!
//! The desktop-only search / snapshot / export / attachment-reconcile signals
//! are not carried over on mobile (search runs TS-side); the `.myn`
//! encrypt/write/read/update/delete cores are verbatim from desktop.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" in the main repo.

pub mod commands;
pub mod error;
pub mod note_id;
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
            commands::note_write_batch_transactional,
            commands::note_delete,
            commands::note_list,
            commands::note_titles_batch,
        ])
        .build()
}
