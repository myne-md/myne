//! Vault-creation Tauri plugin.
//!
//! Owns the three-command flow (`begin` / `commit` / `cancel`) and the
//! in-flight `VaultCreationSession` state. Secret material
//! (`root_key`, wrap keys, recovery phrase, account number) lives in
//! [`state::VaultCreationState`] and never crosses the IPC boundary —
//! see `agent-tooling/sessions/design/2026-04-28-vault-creation-flow.md`
//! Q3 (backend session) and `backend-vault-creation/rfc.md` § Technical
//! Architecture.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".
//!
//! Command bodies are scaffolded as `unimplemented!()` placeholders;
//! Task 12 fills `begin`, Task 13 fills `commit`, Task 14 fills
//! `cancel`, Task 15 wires the TTL background task in [`init`].

pub mod commands;
pub mod error;
pub mod state;

// Used only by the TTL evictor the gated `init()` spawns.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use std::time::Duration;
// `init()` below IS a Tauri plugin builder — `Builder`, `generate_handler!`,
// `app.manage`, the TTL evictor's `async_runtime::spawn`. There is nothing to
// split out of it, so the whole module's Tauri surface is gated together
// (task 79, Option B). The web client builds its own registration.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::plugin::{Builder, TauriPlugin};
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{Manager, Runtime};

/// Background TTL evictor tick interval — every 60 seconds.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
const EVICTOR_TICK_SECS: u64 = 60;

/// Construct the `vault-creation` plugin.
///
/// Registers the three commands (`begin`, `commit`, `cancel`),
/// initializes [`state::VaultCreationState`] in the Tauri-managed
/// state map, and spawns a background task that evicts sessions
/// older than [`state::SESSION_TTL_SECS`] every
/// [`EVICTOR_TICK_SECS`] seconds. Permission gates (declared in
/// `src-tauri/permissions/vault-creation/default.toml`) restrict
/// IPC access to the three commands.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-creation")
        .invoke_handler(tauri::generate_handler![
            commands::begin,
            commands::commit,
            commands::cancel,
        ])
        .setup(|app, _api| {
            app.manage(state::VaultCreationState::default());

            // Background TTL evictor: every minute, evict sessions
            // older than SESSION_TTL_SECS. Spawned on Tauri's async
            // runtime so it survives for the lifetime of the app.
            let app_handle = app.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(EVICTOR_TICK_SECS));
                loop {
                    interval.tick().await;
                    let state = app_handle.state::<state::VaultCreationState>();
                    let _ = state.evict_expired();
                }
            });

            Ok(())
        })
        .build()
}
