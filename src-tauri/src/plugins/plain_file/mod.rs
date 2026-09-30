//! `plain_file` Tauri plugin (myne-md/myne#788): the sandboxed editor for the
//! user's own on-disk markdown files.
//!
//! Desktop-only by construction. Web and mobile have no OS file ingress and no
//! handler registration, so the plugin exists only here and both clients carry
//! an `absent` verdict.
//!
//! ## What the plugin owns
//!
//! - `gate.rs` — the device-local `plain-file.json` gate, the single switch
//!   every ingress consults before anything opens.
//! - `commands.rs` — the IPC surface.
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

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `plain_file` plugin. Holds no plugin-private state; the gate
/// is a device-local file read per call, and the handle registry lands as
/// managed state in a later task.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("plain-file")
        .invoke_handler(tauri::generate_handler![
            commands::gate_get,
            commands::gate_set,
        ])
        .build()
}
