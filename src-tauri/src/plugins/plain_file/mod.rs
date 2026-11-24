// SPDX-License-Identifier: AGPL-3.0-only
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
//! - `handles.rs`: the handle registry, the read/CAS write IO and the shared
//!   path validation (`resolve_openable`).
//! - `commands.rs`: the IPC surface, including the in-app open dialog, the
//!   conflict banner's save-copy dialog and the two deep-link commands.
//! - `ingest.rs`: the funnel every externally-named path walks (argv, macOS
//!   open event, dialog, CLI, confirmed deep link). The drag ingress is
//!   deliberately absent; `ingest.rs`'s module docs carry the reason.
//!
//! ## Capability ACL
//!
//! `plain-file:default` is granted to the main window. There is no second
//! window: the plain surface renders in the main webview in every vault state,
//! so the capability set does not multiply.
//!
//! ## OS-level traces (task 6's checklist; re-checked 2026-10-01)
//!
//! The surface leaves no OS-level record of which files were opened. Registering
//! the app as a macOS/Windows handler for `md`/`markdown`
//! (`bundle.fileAssociations`, added 2026-10-01) makes the app an editor OF the
//! type; it does not itself feed a per-file list, and the three candidates
//! below were re-checked with the registration in place:
//!
//! - **macOS Recent Documents**: nothing in this repository calls
//!   `noteNewRecentDocumentURL` / `addRecentDocument`
//!   (`rg -ni "noteNewRecentDocumentURL|addRecentDocument|NSRecentDocuments"` is
//   empty over the tree), and the pinned dialog backend contains no
//!   recent-document API either (`tauri-plugin-dialog 2.7.1`, `rfd 0.16.0`):
//!   the native panels do not feed `NSRecentDocuments` by themselves.
//! - **Windows jump list**: nothing writes it
//!   (`rg -ni "SetJumpList|JumpList|ICustomDestinationList|AddUserTasks"` over
//!   the tree is empty, and neither `tauri` 2.11.2 nor `muda` 0.19.2 mentions
//!   it).
//! - **Window-state restoration**: the app does not use Tauri's window-state
//!   plugin (`rg -n "window-state"` over `src-tauri/Cargo.toml`,
//!   `src-tauri/tauri.conf.json` and `Cargo.lock` is empty), so no window
//!   geometry or open-file state is restored at launch.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod gate;
pub mod handles;
pub mod ingest;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Menu id of the app menu's File → Open File… item (`lib.rs`).
///
/// The item is the discoverable entry point for the surface: the in-surface
/// Open button renders only once a file is already open, so without a menu (or
/// an OS ingress) there is no way to open the FIRST file. The menu is built
/// host-side in `lib.rs`, so no `core:menu` capability is involved.
pub const OPEN_FILE_MENU_ID: &str = "plain-file-open";

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
            commands::plain_file_save_copy,
            commands::plain_file_close,
            commands::plain_file_take_unclaimed,
            commands::plain_file_open_dialog,
            commands::plain_file_resolve_path,
            commands::plain_file_open_confirmed,
        ])
        .build()
}
