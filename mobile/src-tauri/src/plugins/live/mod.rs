// SPDX-License-Identifier: AGPL-3.0-only
//! `live` plugin: mobile shim over the shared [`myne_core::plugins::live`] core.
//!
//! The collaborative-editor live-session commands (epic live-collab,
//! `collab-editor-bridge` task 3) live in the shared `myne-core` crate, the same
//! split `notes`/`prefs`/`sync` use. This mobile crate keeps only the per-client
//! wiring: [`init()`] + `generate_handler!` + the `live:default` capability entry
//! (`capabilities/default.json`). The command bodies are the identical compiled
//! code the desktop runs, so this client has no second live implementation to
//! audit.
//!
//! ## Why the client needs it at all
//!
//! While a live session owns a note it is the SINGLE durable writer (`SYNC-33`):
//! the backend refuses a stateless `note_update` for that note with
//! `NoteUpdateError::LiveSessionOpen`. The refusals live in the shared core, so
//! they apply to this client the moment a session is open here. What was missing
//! on mobile was purely reachability: `lib.rs` already managed the
//! `LiveSessionRegistry` and spawned the awareness supervisor, but the plugin
//! itself was never registered, so `plugin:live|*` could not be invoked from the
//! mobile WebView at all and a peer's presence reached no surface.
//!
//! ## Capability ACL (deny-by-default)
//!
//! `live:default` bundles all six commands into ONE narrow, main-window-only
//! grant. **Which gate each of the six carries is stated per command**, because
//! one sentence cannot hold it (myne-md/myne#849 review). The three that touch
//! vault content on disk (`live_session_open`, `live_session_patch_frontmatter`,
//! `live_session_close`) are `Slot::Unlocked`-gated inside the shared core, so an
//! invoke on a locked vault is refused there. The other three
//! (`live_session_take_remote_splices`, `live_session_read`,
//! `live_session_set_presence`) hold NO vault authority and take no slot at all.
//! `take_remote_splices` and `read` read the in-RAM `LiveSessionRegistry` and
//! return note text (queued insert text, and the session's whole markdown
//! respectively); `set_presence` writes that registry AND the awareness signal's
//! local label. What keeps all three safe on a locked vault is the teardown hook
//! (`live_session_teardown_on_lock`, which `scripts/check-lock-teardown.mjs`
//! holds), which CLEARS the registry and resets that label to `None`, so after a
//! lock there is no session to read and no label left to publish. So the ACL
//! widens reachability, and for those three it is the teardown hook rather than
//! the slot that bounds them. `build.rs`'s `InlinedPlugin` command list,
//! `permissions/live/default.toml`'s `commands.allow` entries and the
//! `generate_handler!` list below MUST match exactly (all six); a mismatch makes
//! Tauri **fail closed**, and a command absent from any of the three is inert with
//! no build, lint or test saying a word.
//!
//! The desktop shim (`src-tauri/src/plugins/live/mod.rs`) registers the same six,
//! `live_session_read` included.
//!
//! See the main repo's `src-tauri/AGENTS.md` "Secret-handling logging discipline"
//! for the DENY-list this wrapper (and the shared core) follow.

// Re-export the whole core live surface so existing paths
// (`crate::plugins::live::commands::…`) keep resolving, the desktop shim's
// re-export pattern mirrored here.
#[allow(unused_imports)]
pub use myne_core::plugins::live::{commands, state};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `live` plugin. THREE of the six commands borrow
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
