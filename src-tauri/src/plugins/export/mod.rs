//! `export` plugin — whole-vault plaintext markdown tree export
//! (MYND-211, epic export-suite; the importer's mirror).
//!
//! `vault_export_markdown` decrypts the vault's live notes into an
//! Obsidian-shape folder tree at a user-chosen destination: folder
//! hierarchy from each note's FM `folder:`, filenames from FM `title:`
//! (+ one `.md`, tree-level `" (1)"` dedup), deliberate empty folders
//! recreated from prefs, referenced attachments decrypted once into
//! `attachments/` with embeds rewritten (the markdown-dialect §6
//! sanctioned export transform), per-file mtimes from FM `updated:`.
//! The whole tree stages in a sibling directory and publishes via one
//! same-filesystem rename — a tree exists at the destination only when
//! complete (SYNC of the backup engine's "success = verified" posture).
//!
//! Lives as its OWN plugin (rather than inside `notes`): the engine is
//! a vault-lifecycle operation (capacity-1 auth permit + writer
//! quiescence, the backup plugin's exact concurrency discipline), not a
//! per-note CRUD verb — the backup plugin is the precedent it mirrors,
//! and `VaultRuntimeState` is borrowed cross-plugin the same way. The
//! per-note machinery (decrypt, sanitize, suffix-dedup, embed rewrite,
//! mtime) is shared with the notes plugin via `pub(crate)` helpers, not
//! duplicated.
//!
//! TB3 egress: deliberate, user-initiated plaintext leaving the vault —
//! covered by the SYNC-4 spec package landed with MYND-115 (threat-model
//! TB3 row, glossary "export", dialect §6 export transform).
//!
//! Capability ACL: `export:default` (`permissions/export/default.toml`
//! and `build.rs InlinedPlugin::commands` lock-stepped — adding a
//! command without the matching `commands.allow` entry is a security
//! regression).
//!
//! Logging: see `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline" — counts-only events, no paths/titles/ids.

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `export` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("export")
        .invoke_handler(tauri::generate_handler![
            commands::vault_export_markdown,
            commands::vault_export_cancel,
        ])
        .setup(|app, _api| {
            use tauri::Manager;
            app.manage(commands::ExportRuntime::default());
            Ok(())
        })
        .build()
}
