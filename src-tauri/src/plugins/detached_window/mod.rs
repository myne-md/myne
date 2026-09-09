//! `detached-window` plugin: host-spawned pop-out note windows (myne-md/myne#678,
//! epic #173).
//!
//! One command, `detached_window_open`, granted to the MAIN window by
//! `detached-window:default` in `capabilities/default.json`. It builds a
//! `note-<id>` window carrying the narrow `detached-note` capability (myne#677)
//! and records it in the [`DetachedWindowRegistry`] (SYNC-4). Creation is a host
//! command because page context holds no window-create grant.
//!
//! Security lockstep (the same discipline as the hidden pdf-export window): the
//! detached window is plaintext-bearing, so myne#680 applies content protection in
//! the create->show sequence and myne#679 wires [`teardown_on_lock`] into every
//! lock-teardown site (destroying the windows and clearing the registry) and adds
//! the `check-lock-teardown.mjs` PAIRS row against `DetachedWindowRegistry`.
//!
//! Capability ACL: `detached-window:default`
//! (`permissions/detached-window/default.toml` + the `build.rs InlinedPlugin`
//! arm lock-stepped).

pub mod commands;
pub mod state;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// Construct the `detached-window` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("detached-window")
        .invoke_handler(tauri::generate_handler![
            commands::detached_window_open,
            commands::detached_window_snapshot
        ])
        .setup(|app, _api| {
            app.manage(state::DetachedWindowRegistry::default());
            Ok(())
        })
        .build()
}

/// Lock-teardown hook: hide-then-destroy every open detached (`note-<id>`) window
/// and clear the registry. Reached through `DesktopHooks::detached_windows_
/// teardown_on_lock`, which `myne-core` calls at EVERY lock-teardown site
/// (manual lock, unlock-switch, change-password force-relock, vault-delete) and
/// the desktop auto_lock idle path, alongside the other plaintext-surface
/// teardowns; `scripts/check-lock-teardown.mjs` carries the PAIRS row keyed on
/// [`DetachedWindowRegistry`].
///
/// Sync + infallible. Per SYNC-8 the window is HIDDEN before it is destroyed:
/// `hide()` is a renderer-independent OS-level cover, so the detached window's
/// plaintext pixels vanish at the lock instant even if the destroy is delayed or
/// its WebView is hung. `destroy()` then drops that window's own V8 heap, which
/// is where the detached note's plaintext lives (threat-model A6) and which the
/// main window's teardown cannot reach.
pub fn teardown_on_lock<R: Runtime>(app: &AppHandle<R>) {
    if let Some(registry) = app.try_state::<state::DetachedWindowRegistry>() {
        for label in registry.all_labels() {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.hide(); // SYNC-8: OS cover first, before destroy
                let _ = window.destroy();
            }
        }
        registry.clear();
    }
}
