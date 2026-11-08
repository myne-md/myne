// SPDX-License-Identifier: AGPL-3.0
//! `backup` plugin — whole-vault backup export (MYND-32; restore joins in
//! MYND-218). Spec: `agent-tooling/docs/spec/protocol.md` §9.11; epic MYND-217.
//!
//! `vault_export_backup` writes a verified `.myne-backup` container at a
//! user-chosen destination. The Rust core does ALL the IO (narrow-seam
//! posture, the importer precedent): the WebView only picks the path via
//! the dialog plugin — no `fs:` scope is granted for backup files.
//!
//! Capability ACL: `backup:default` (`permissions/backup/default.toml` +
//! `build.rs InlinedPlugin::commands` lock-stepped — adding a command
//! without the matching `commands.allow` entry is a security regression).
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod restore;
pub mod schedule;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `backup` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("backup")
        .invoke_handler(tauri::generate_handler![
            commands::vault_export_backup,
            commands::backup_default_filename,
            commands::backup_cancel,
            restore::vault_restore_backup,
            schedule::backup_schedule_read,
            schedule::backup_schedule_write,
            schedule::backup_schedule_record_result,
        ])
        .setup(|app, _api| {
            use tauri::Manager;
            app.manage(commands::BackupRuntime::default());
            Ok(())
        })
        .build()
}
