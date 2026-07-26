//! `workspace` Tauri plugin (MYND-561, mobile).
//!
//! Owns `workspace_read` + `workspace_write` — the persistence side of the
//! `vault.workspace` container (`MYW1`, `protocol.md` § 9.7), sealed opaque under
//! `session_state_key = DeriveSubkey(root_key, SessionStateKey)`. Both
//! Slot::Unlocked-gated; both borrow the existing `VaultRuntimeState` singleton
//! (registered by `vault_unlock::init`) via `tauri::State<...>` — this plugin
//! holds NO plugin-private state.
//!
//! Mobile's descriptor is NOT desktop's pane tree: the phone has one note open at
//! a time, so what rides the container here is the sidebar folder-expand set
//! (`expandedFolders`). The container is shared and the frontend treats it as a
//! read-modify-write of a JSON object, preserving keys it did not author — see
//! `src/lib/workspace-persist.ts`.
//!
//! Desktop registers a third command (`workspace_stage`) that parks a descriptor
//! in RAM for the `ExitRequested` flush; mobile has no Cmd+Q equivalent (an OS
//! kill after backgrounding is the normal termination path), so it writes
//! directly at its own exit-analog seams instead. Deliberately not carried over.
//!
//! ## Capability ACL
//!
//! `workspace:default` bundles `allow-workspace-read` + `allow-workspace-write`,
//! main-window-only. Declared as an `InlinedPlugin` in `build.rs` with the
//! permission bodies in `permissions/workspace/default.toml` — without the
//! `InlinedPlugin` declaration the permissions flatten into `__app-acl__` and
//! never match the `plugin:workspace|<cmd>` authorize form.
//!
//! See: main repo `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `workspace` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("workspace")
        .invoke_handler(tauri::generate_handler![
            commands::workspace_read,
            commands::workspace_write,
        ])
        .build()
}
