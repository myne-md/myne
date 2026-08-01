//! `importer` plugin — the narrow external-directory read seam (MYND-53, SYNC-1).
//!
//! Two Tauri commands, `import_read_dir` + `import_read_file`, are the ONLY path
//! by which the WebView reads an external (Obsidian vault) directory. No general
//! `fs:allow-read-text-file` / `fs:read-dir` / read `fs:scope` is granted —
//! this path-validating seam replaces them (least-privilege, TB6; the rationale
//! is recorded in `docs/decisions.md`). The commands hold no state and touch no
//! vault crypto; the TS engine assembles plaintext and calls the slot-gated
//! `note_create` for ingest.
//!
//! Capability ACL: `importer:default` (`permissions/importer/default.toml` +
//! `build.rs InlinedPlugin::commands` lock-stepped — adding a command without
//! the matching `commands.allow` entry is a security regression).

pub mod commands;
pub mod error;
pub mod hold;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `importer` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("importer")
        .invoke_handler(tauri::generate_handler![
            commands::import_read_dir,
            commands::import_read_file,
            hold::import_set_hold,
        ])
        .setup(|app, _api| {
            // The auto-lock lease a running import takes (myne-md/myne#223).
            // Managed here rather than in `lib.rs` so it stays scoped to the
            // one plugin allowed to take it.
            app.manage(hold::ImportHold::default());
            Ok(())
        })
        .build()
}
