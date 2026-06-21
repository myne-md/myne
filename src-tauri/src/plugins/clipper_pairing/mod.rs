//! `clipper-pairing` Tauri plugin (TB10, `ext-foundation-handoff` task 4).
//!
//! Owns the WebView side of the browser-extension **pairing handshake**: the
//! `pairing_pending` / `pairing_accept` / `pairing_reject` IPC commands the
//! in-app pairing dialog drives, plus the [`state::PairingState`] singleton
//! (the pending session + the authoritative token registry).
//!
//! ## Two ingresses, two trust boundaries
//!
//! - The **stdio native-messaging host** (`crate::clipper`) is an EXTERNAL
//!   process the browser launches; TB6 (the capability ACL) does NOT govern
//!   it — it carries its own untrusted-input discipline.
//! - **This plugin** is ordinary WebView→Rust IPC; TB6 DOES govern it. Each
//!   command therefore has a NARROW named permission entry in
//!   `permissions/clipper-pairing/default.toml`, surfaced as
//!   `clipper-pairing:default` in `capabilities/default.json`. No
//!   `core:default` widening. (PRD "Trust-boundary impact": the accept/reject
//!   commands the pairing dialog relies on still need narrow named entries.)
//!
//! The two halves meet at [`crate::clipper::token::TokenRegistry`]: the
//! WebView mints tokens here; the host validates them via
//! [`crate::clipper::token::RegistryGate`]. In task 4 the registry is
//! **in memory** in this plugin's managed state; **task 7** persists it to
//! the encrypted prefs-family blob so the host process (a separate OS
//! process) and the app process observe the same record across restarts.
//!
//! ## Plugin-private state
//!
//! This plugin OWNS [`state::PairingState`] (it does not borrow
//! `VaultRuntimeState`) — registered in [`init`]'s `.setup` via
//! `app.manage`, the `vault-creation` precedent.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod state;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `clipper-pairing` plugin.
///
/// Binds the pairing-dialog commands plus `clip_dispatch_complete` (the
/// WebView→Rust reply seam for the host↔relay clip-assembly handoff) and
/// `pairing_dispatch_complete` (the WebView→Rust reply seam for the host↔relay
/// PAIRING handshake — Accept/Reject + the minted token) — both live on this
/// plugin to minimize ACL churn, since both are the same browser-extension
/// surface. Initializes the [`state::PairingState`] singleton (pending session +
/// in-memory token registry), the
/// [`crate::clipper::relay_app::ClipDispatchRegistry`] (the in-flight
/// clip-dispatch reply channels the relay thread blocks on), and the
/// [`crate::clipper::relay_app::PairingDispatchRegistry`] (the in-flight
/// pairing-dispatch reply channels). The plugin name in the ACL namespace is
/// `clipper-pairing` (kebab-case — matches
/// `permissions/clipper-pairing/default.toml` and the `build.rs` `InlinedPlugin`
/// mirror).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("clipper-pairing")
        .invoke_handler(tauri::generate_handler![
            commands::pairing_pending,
            commands::pairing_accept,
            commands::pairing_reject,
            commands::pairing_revoke,
            commands::pairing_list_paired,
            crate::clipper::relay_app::clip_dispatch_complete,
            crate::clipper::relay_app::pairing_dispatch_complete,
        ])
        .setup(|app, _api| {
            app.manage(state::PairingState::default());
            // The relay thread (`clipper::relay_app::spawn_relay_listener`)
            // inserts an in-flight dispatch under a fresh request id and blocks
            // on it; `clip_dispatch_complete` delivers the WebView's outcome.
            app.manage(crate::clipper::relay_app::ClipDispatchRegistry::default());
            // The same relay thread inserts an in-flight PAIRING dispatch under a
            // fresh request id and blocks on it; `pairing_dispatch_complete`
            // delivers the WebView pairing dialog's Accept/Reject outcome.
            app.manage(crate::clipper::relay_app::PairingDispatchRegistry::default());
            Ok(())
        })
        .build()
}
