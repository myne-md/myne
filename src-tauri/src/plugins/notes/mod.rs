//! `notes` plugin — host-side per-note CRUD.
//!
//! Four Tauri commands: `note_create`, `note_read`, `note_update`,
//! `note_delete` (`note_list` deferred to MYND-28). Each command
//! pattern-matches `Slot::Unlocked(uv) => ...` only; `Slot::Recovering`
//! is rejected at compile time per `recovery-flow.md` §4.1. The plugin
//! holds no own state and borrows `VaultRuntimeState` cross-plugin
//! (`vault_recover` precedent; `decisions.md` 2026-05-02 "Slot state
//! machine + auth_permits generalization").
//!
//! Capability ACL `notes:default` declares all four `allow-note-<verb>`
//! permissions; `permissions/notes/default.toml` + `build.rs
//! InlinedPlugin::commands` lock-stepped per `decisions.md` 2026-05-07
//! "notes plugin scaffold + cross-plugin VaultRuntimeState borrow".

pub mod commands;
pub mod error;
pub mod note_id;

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
        ])
        .build()
}
