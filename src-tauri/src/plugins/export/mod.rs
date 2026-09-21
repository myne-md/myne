//! `export` plugin — whole-vault plaintext markdown tree export
//! (MYND-211, epic export-suite; the importer's mirror).
//!
//! ## Extraction into `myne-core`
//!
//! The platform-agnostic plugin core (`commands` — including both
//! `#[tauri::command]`s `vault_export_markdown` + `vault_export_cancel`, the
//! app-managed `ExportRuntime` cancel flag, the `export://progress` emitter, and
//! the pure `vault_export_core` — and `error`) moved to
//! `myne_core::plugins::export` (shared with the mobile client). Re-exported
//! below so existing `crate::plugins::export::{commands, error}::…` paths keep
//! resolving. This crate keeps only the `tauri::Builder` `init()` wiring.
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
//! complete.
//!
//! The two commands are registered via the `myne_core::plugins::export` module
//! path so `generate_handler!` finds each command's hidden `__cmd__` items (a
//! bare `pub use` of the `#[tauri::command]` fns would drop them).
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
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline" — counts-only events, no paths/titles/ids.

// Platform-agnostic plugin core, re-exported so `crate::plugins::export::…`
// paths keep resolving.
#[allow(unused_imports)]
pub use myne_core::plugins::export::{commands, error};

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
