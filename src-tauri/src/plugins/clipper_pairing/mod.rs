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
/// Binds the three pairing-dialog commands and initializes the
/// [`state::PairingState`] singleton (pending session + in-memory token
/// registry). The plugin name in the ACL namespace is `clipper-pairing`
/// (kebab-case — matches `permissions/clipper-pairing/default.toml` and the
/// `build.rs` `InlinedPlugin` mirror).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("clipper-pairing")
        .invoke_handler(tauri::generate_handler![
            commands::pairing_pending,
            commands::pairing_accept,
            commands::pairing_reject,
        ])
        .setup(|app, _api| {
            app.manage(state::PairingState::default());
            Ok(())
        })
        .build()
}
