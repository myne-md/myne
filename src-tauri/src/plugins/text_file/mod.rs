// SPDX-License-Identifier: AGPL-3.0-only
//! `text_file` plugin: one plaintext file in, one plaintext file out.
//!
//! The calendar's `.ics` exchange needs a way to write text the WebView produced
//! to a path the user named, and to read a file the user picked as bounded UTF-8
//! text. Neither existed (`plain_file` is a Markdown-filtered editor ingress that
//! mints handles and opens tabs), so they are here, with their reasoning in
//! [`commands`].
//!
//! **Why a plugin of its own.** It could have lived in `export`, and that was the
//! first shape. `export` is a desktop/mobile twin, and `check-twin-drift-ratchet`
//! refused the new difference with a reason worth keeping: two files answering the
//! same product question may not start answering it differently, because both
//! trees compile and both suites pass while they diverge. A capability one client
//! has and the other does not belongs in a plugin, not in a twin (`plain_file`,
//! `pdf_export`, `mcp` are the precedent), so this is a plugin.
//!
//! ## Capability ACL
//!
//! `text_file:default` (`permissions/text_file/default.toml` and the `build.rs`
//! `InlinedPlugin::commands` list are lock-stepped: adding a command without the
//! matching `commands.allow` entry is a security regression).
//!
//! ## Logging
//!
//! A closed error kind and a byte count, never a path and never content
//! (`src-tauri/AGENTS.md`, "Secret-handling logging discipline").

pub mod commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `text_file` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("text-file")
        .invoke_handler(tauri::generate_handler![
            commands::export_text_file,
            commands::import_text_file,
        ])
        .build()
}
