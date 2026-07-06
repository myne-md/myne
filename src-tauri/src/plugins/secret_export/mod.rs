//! `secret-export` Tauri plugin.
//!
//! Owns the single `save_secret_text` IPC command — the narrow-seam file write
//! backing the recovery-kit / account-number `.txt` save affordance
//! (vault-creation PhraseStep / AccountStep). It exists so the main-window ACL
//! does NOT grant the WebView a broad `fs:allow-write-text-file $HOME/**` scope:
//! the WebView picks the destination via the dialog plugin, the Rust core does
//! the only IO, and the command re-validates the destination as untrusted (TB6),
//! rejecting anything inside the app-data / vault tree. Same least-privilege
//! posture as `export` / `backup` / `importer`.
//!
//! ## Extraction into `myne-core`
//!
//! The platform-agnostic plugin core (`commands` — including the
//! `#[tauri::command]` `save_secret_text` and the pure
//! `validate_secret_destination` guard — and `error`) moved to
//! `myne_core::plugins::secret_export` (shared with the mobile client).
//! Re-exported below so existing `crate::plugins::secret_export::{commands,
//! error}::…` paths keep resolving. This crate keeps only the `tauri::Builder`
//! `init()` wiring.
//!
//! The command is registered via the `myne_core::plugins::secret_export` module
//! path so `generate_handler!` finds its hidden `__cmd__` item (a bare `pub use`
//! of the `#[tauri::command]` fn would drop it).
//!
//! Capability ACL: `secret-export:default` (`permissions/secret-export/default.toml`
//! and `build.rs InlinedPlugin::commands` lock-stepped — adding a command
//! without the matching `commands.allow` entry is a security regression).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

// Platform-agnostic plugin core, re-exported so `crate::plugins::secret_export::…`
// paths keep resolving.
#[allow(unused_imports)]
pub use myne_core::plugins::secret_export::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `secret-export` plugin (binds the single `save_secret_text`
/// command). Holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("secret-export")
        .invoke_handler(tauri::generate_handler![commands::save_secret_text])
        .build()
}
