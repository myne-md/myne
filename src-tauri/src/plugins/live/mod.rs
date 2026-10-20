// SPDX-License-Identifier: AGPL-3.0
//! `live` Tauri plugin, the collaborative-editor live-session commands (epic
//! live-collab, `collab-editor-bridge` task 3).
//!
//! Owns the six `live_session_*` commands registered below, and they do NOT all
//! borrow the same state, which one sentence can no longer hold (myne-md/myne#849
//! review). Three borrow the `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) AND the `LiveSessionRegistry` (managed in `lib.rs`,
//! alongside the awareness signal) via `tauri::State<...>`:
//! `live_session_open`, `live_session_patch_frontmatter`, `live_session_close`.
//! Three borrow no `VaultRuntimeState` at all: `live_session_take_remote_splices`
//! and `live_session_read` read the registry, and `live_session_set_presence`
//! writes the registry plus the awareness signal's local label.
//! `permissions/live/default.toml` carries the same split, and it is the file to
//! read for what each command's grant reaches.
//!
//! ## Capability ACL
//!
//! `live:default` bundles the `allow-live-session-*` permissions,
//! main-window-only. `build.rs`'s `InlinedPlugin` command list,
//! `permissions/live/default.toml`'s `commands.allow` entries and the
//! `generate_handler!` list below MUST match exactly (all six); a mismatch makes
//! Tauri **fail closed**, and a command absent from any of the three is inert with
//! no build, lint or test saying a word. The mobile shim
//! (`mobile/src-tauri/src/plugins/live/mod.rs`) registers the same six.

// The command core moved to `myne-core` (shared with mobile + the web wasm
// entry). Re-exported so `crate::plugins::live::commands::…` paths resolve; the
// `init()` wiring stays desktop-side.
#[allow(unused_imports)]
pub use myne_core::plugins::live::{commands, state};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `live` plugin. THREE of the six commands borrow
/// `VaultRuntimeState` + `LiveSessionRegistry` via `tauri::State<...>`; the other
/// three borrow the registry only (one also the awareness signal), and the module
/// doc at the top of this file names which is which. Holds no plugin-private state.
/// All six commands, matching the `build.rs` `InlinedPlugin` +
/// `permissions/live/default.toml` lists exactly.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("live")
        .invoke_handler(tauri::generate_handler![
            commands::live_session_open,
            commands::live_session_patch_frontmatter,
            commands::live_session_take_remote_splices,
            commands::live_session_read,
            commands::live_session_set_presence,
            commands::live_session_close,
        ])
        .build()
}
