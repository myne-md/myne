//! `plain_file` Tauri plugin (myne-md/myne#788): the sandboxed editor for the
//! user's own on-disk markdown files.
//!
//! Desktop-only by construction. Web and mobile have no OS file ingress and no
//! handler registration, so the plugin exists only here and both clients carry
//! an `absent` verdict.
//!
//! ## What the plugin owns
//!
//! - `gate.rs`: the device-local `plain-file.json` gate, the single switch
//!   every ingress consults before anything opens.
//! - `commands.rs`: the IPC surface.
//! - Later tasks add the handle registry, the read/CAS write commands and the
//!   ingress (argv, OS open event, drag, dialog, CLI, deep link).
//!
//! ## Capability ACL
//!
//! `plain-file:default` is granted to the main window. There is no second
//! window: the plain surface renders in the main webview in every vault state,
//! so the capability set does not multiply.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod gate;
pub mod handles;
pub mod ingest;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `plain_file` plugin.
///
/// Owns the handle registry (`commands::SharedRegistry`): a map from opaque
/// handle ids to canonical paths, in memory only and never persisted (a
/// restart restores no plain tab, by decision). The gate itself is a
/// device-local file read per call, never cached, so a settings change takes
/// effect on the next open in the same session.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("plain-file")
        .setup(|app, _api| {
            app.manage(commands::SharedRegistry::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::gate_get,
            commands::gate_set,
            commands::plain_file_read,
            commands::plain_file_write,
            commands::plain_file_close,
            commands::plain_file_take_unclaimed,
        ])
        .build()
}
