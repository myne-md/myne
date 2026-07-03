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
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `secret-export` plugin (binds the single `save_secret_text`
/// command). Holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("secret-export")
        .invoke_handler(tauri::generate_handler![commands::save_secret_text])
        .build()
}
