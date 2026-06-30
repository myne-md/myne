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

// The vault-recover command core (`recover_with_phrase`, `complete_recovery`,
// account-number selector) + `error` moved to `myne-core` (shared with the
// mobile client). The post-recovery prefs-apply + search-index hydrate attach
// through the `hooks::VaultLifecycleHooks` seam. Re-exported so existing
// `crate::plugins::vault_recover::{commands,error,account_number_select}::…`
// paths keep resolving. The `init()` wiring stays desktop-side.
pub use myne_core::plugins::vault_recover::{account_number_select, commands};

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
            commands::complete_recovery,
            commands::resolve_vault_by_account_number
        ])
        .build()
}
