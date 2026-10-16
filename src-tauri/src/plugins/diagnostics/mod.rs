//! `diagnostics` Tauri plugin (myne-md/myne#860): the opt-in device-local
//! diagnostic log and the bug-report surface's host side.
//!
//! Desktop-only by construction. The web build installs no `tracing`
//! subscriber and compiles everything below `warn` out of the bundle
//! (`design-notes/ops/0366`), so there is no log for it to write and no
//! folder for it to reveal; both other clients carry `Unsupported` verdicts in
//! `web/wasm/src/capability.rs`.
//!
//! ## What the plugin owns
//!
//! - `flag.rs`: the device-local `diagnostic-log.json` switch. Not a
//!   `vault.prefs` field, because the sink is installed at process start,
//!   before any vault is unlocked.
//!
//! The file sink, the panic hook and the crash record live one level up in
//! `crate::logging`, because they have to exist before this plugin can be
//! reached; this plugin is the IPC surface over them. Later tasks of this
//! feature add the log state read, the reveal action and the report bundle
//! here rather than in `myne-core`, for the reason `src-tauri/AGENTS.md` gives
//! for `backup`, `importer`, `pdf_export` and `vault_repair`: this flow has no
//! mobile or browser counterpart and every one of its inputs is desktop-only
//! (the platform log directory, the OS file manager, the panel's dialogs).
//!
//! ## Capability ACL
//!
//! `diagnostics:default` is granted to the main window, and each command is
//! also its own `allow-*` identifier in `permissions/diagnostics/default.toml`,
//! so a later task can narrow the bundle without touching `build.rs`. There is
//! no second window for this surface.
//!
//! **No `fs:` scope is added and no `opener` scope is widened.** The reveal
//! action resolves the log directory host-side and calls the opener with the
//! resolved path, which is why `opener:allow-open-path`'s scope list (whose
//! path comes from page context) is left exactly as it is.
//!
//! ## What this plugin must never do
//!
//! Return log bytes to the WebView, or hand the WebView a path. The block the
//! surface renders is assembled in the WebView from fields it already has; the
//! bundle's log files are written host-side to a destination the user picks in
//! an OS dialog, so no path and no log content crosses IPC.

pub mod commands;
pub mod flag;
pub mod report;

use tauri::{plugin::TauriPlugin, Runtime};

/// Register the plugin with the app.
///
/// Every command here is also an identifier granted in
/// `capabilities/default.json`. **Registration is its own edit** and this list
/// is the only place it happens: an ACL entry alone does not wire a command,
/// and a command missing from this list compiles, passes clippy and is dead at
/// runtime (`src-tauri/AGENTS.md`, MYND-441).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("diagnostics")
        .invoke_handler(tauri::generate_handler![
            commands::diagnostic_log_enabled_get,
            commands::diagnostic_log_enabled_set,
            commands::crash_record_state,
            commands::crash_record_clear,
            commands::reveal_logs_folder,
            commands::report_manifest,
            commands::save_report,
        ])
        .build()
}
