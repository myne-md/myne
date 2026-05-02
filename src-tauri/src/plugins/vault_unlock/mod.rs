//! Vault-unlock Tauri plugin.
//!
//! Owns the singleton `UnlockedVault` slot and the `unlock` + `lock`
//! commands. Secret material (`root_key`, `items_key`) lives in
//! [`state::VaultRuntimeState`] and never crosses the IPC boundary —
//! see grilling session
//! `myne-agents/sessions/grill/2026-05-02-vault-unlock-password.md`
//! Q1 (single-slot RwLock + Semaphore design) and the feature PRD
//! at `myne-agents/features/vault-unlock-password/prd.md`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod state;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `vault-unlock` plugin.
///
/// Registers [`state::VaultRuntimeState`] in the Tauri-managed state
/// map and binds the IPC commands declared in [`commands`].
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-unlock")
        .invoke_handler(tauri::generate_handler![
            commands::unlock,
            commands::lock,
            commands::vault_status,
            commands::vault_is_unlocked,
            commands::vault_slot_kind,
        ])
        .setup(|app, _api| {
            app.manage(state::VaultRuntimeState::default());
            Ok(())
        })
        .build()
}
