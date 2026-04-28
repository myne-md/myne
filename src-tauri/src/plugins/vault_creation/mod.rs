//! Vault-creation Tauri plugin.
//!
//! Owns the three-command flow (`begin` / `commit` / `cancel`) and the
//! in-flight `VaultCreationSession` state. Secret material
//! (`root_key`, wrap keys, recovery phrase, account number) lives in
//! [`state::VaultCreationState`] and never crosses the IPC boundary —
//! see `myne-agents/sessions/design/2026-04-28-vault-creation-flow.md`
//! Q3 (backend session) and `backend-vault-creation/rfc.md` § Technical
//! Architecture.
//!
//! Command bodies are scaffolded as `unimplemented!()` placeholders;
//! Task 12 fills `begin`, Task 13 fills `commit`, Task 14 fills
//! `cancel`, Task 15 wires the TTL background task in [`init`].

pub mod commands;
pub mod error;
pub mod state;

use std::time::Duration;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Background TTL evictor tick interval — every 60 seconds.
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
