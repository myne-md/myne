//! Vault-recover Tauri plugin.
//!
//! Owns `vault_recover_with_phrase` and `vault_complete_recovery`.
//! Sibling to `vault_unlock` rather than a submodule — plugin
//! boundary mirrors the user-facing flow boundary (unlock vs
//! recover). Both plugins share `VaultRuntimeState`, registered at
//! the host level by `vault_unlock::init()`; recover borrows via
//! `Tauri::State<VaultRuntimeState>`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-recover` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT register
/// `VaultRuntimeState` — the unlock plugin owns the runtime-state
/// singleton; recover borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-recover")
        .invoke_handler(tauri::generate_handler![
            commands::recover_with_phrase,
            commands::complete_recovery
        ])
        .build()
}
