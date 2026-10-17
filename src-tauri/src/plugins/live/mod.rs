// SPDX-License-Identifier: AGPL-3.0
//! `live` Tauri plugin, the collaborative-editor live-session commands (epic
//! live-collab, `collab-editor-bridge` task 3).
//!
//! Owns `live_session_open` /
//! `live_session_patch_frontmatter` / `live_session_close`. All four borrow the
//! `VaultRuntimeState` singleton (registered by `vault_unlock::init`) and the
//! `LiveSessionRegistry` (managed in `lib.rs`, alongside the awareness signal)
//! via `tauri::State<...>`.
//!
//! ## Capability ACL
//!
//! `live:default` bundles the `allow-live-session-*` permissions,
//! main-window-only.

// The command core moved to `myne-core` (shared with mobile + the web wasm
// entry). Re-exported so `crate::plugins::live::commands::…` paths resolve; the
// `init()` wiring stays desktop-side.
#[allow(unused_imports)]
pub use myne_core::plugins::live::{commands, state};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `live` plugin. Borrows `VaultRuntimeState` + `LiveSessionRegistry`
/// via `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("live")
        .invoke_handler(tauri::generate_handler![
            commands::live_session_open,
            commands::live_session_patch_frontmatter,
            commands::live_session_take_remote_splices,
            commands::live_session_set_presence,
            commands::live_session_close,
        ])
        .build()
}
