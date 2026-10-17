// SPDX-License-Identifier: AGPL-3.0
//! `export` plugin — mobile host (MYND-211, epic export-suite).
//!
//! Owns the whole-vault plaintext markdown-tree export for the open vault. The
//! entire plugin core (both `#[tauri::command]`s — `vault_export_markdown` +
//! `vault_export_cancel` — the app-managed `ExportRuntime` cancel flag, the
//! `export://progress` emitter, and the pure `vault_export_core`, plus the
//! `error` enum) lives in `myne-core` (`myne_core::plugins::export`, shared with
//! the desktop client). Mobile registers exactly the two commands the desktop
//! registers:
//!
//! - `vault_export_markdown` — decrypt the unlocked vault (or one folder
//!   subtree) into an Obsidian-shape plaintext markdown tree at a user-chosen
//!   destination, staged then atomically published (nothing appears at the
//!   destination unless complete).
//! - `vault_export_cancel` — cooperatively cancel the in-flight export.
//!
//! `ExportRuntime` (the cancel flag) is managed in this plugin's own `.setup()`
//! (like desktop). The export engine peeks the slot material, reads notes,
//! decrypts, and writes the tree with no desktop-only side-effect, so it needs
//! no `hooks::VaultLifecycleHooks` seam (mobile installs `NoopHooks` globally
//! in `lib.rs`).
//!
//! Commands are registered via the `myne_core::plugins::export` module path so
//! `generate_handler!` finds each command's hidden `__cmd__` items (a bare
//! `pub use` of the `#[tauri::command]` fns would drop them).
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline".

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::export::{commands, error}` (mirrors the desktop re-export
// surface). `commands` is the symbol `init()` registers.
#[allow(unused_imports)]
pub use myne_core::plugins::export::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `export` plugin. The `VaultRuntimeState` it borrows is
/// registered by the `vault-unlock` plugin; its own `ExportRuntime` cancel flag
/// is managed in this plugin's `.setup()` (like desktop).
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
