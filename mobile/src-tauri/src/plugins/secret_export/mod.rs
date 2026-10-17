// SPDX-License-Identifier: AGPL-3.0
//! `secret-export` plugin — mobile host.
//!
//! Owns the single `save_secret_text` IPC command — the narrow-seam file write
//! backing the recovery-kit / account-number `.txt` save affordance
//! (vault-creation PhraseStep / AccountStep). The entire plugin core (the
//! `#[tauri::command]` `save_secret_text`, the pure `validate_secret_destination`
//! guard, and the `error` enum) lives in `myne-core`
//! (`myne_core::plugins::secret_export`, shared with the desktop client). Mobile
//! registers exactly the one command the desktop registers.
//!
//! The command exists so the main-window ACL does NOT grant the WebView a broad
//! `fs:` write scope: the WebView picks the destination via the file dialog, the
//! Rust core does the only IO, and the command re-validates the destination as
//! untrusted (TB6), rejecting anything inside the app-data / vault tree. Same
//! least-privilege posture as `export`.
//!
//! The command is registered via the `myne_core::plugins::secret_export` module
//! path so `generate_handler!` finds its hidden `__cmd__` item (a bare `pub use`
//! of the `#[tauri::command]` fn would drop it).
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline".

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::secret_export::{commands, error}` (mirrors the desktop
// re-export surface). `commands` is the symbol `init()` registers.
#[allow(unused_imports)]
pub use myne_core::plugins::secret_export::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `secret-export` plugin (binds the single
/// `save_secret_text` command). Holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("secret-export")
        .invoke_handler(tauri::generate_handler![commands::save_secret_text])
        .build()
}
