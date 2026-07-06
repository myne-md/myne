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
// account-number selector) + `error` live in `myne-core` (shared with the
// desktop client). Re-exported so existing
// `crate::plugins::vault_recover::{commands,account_number_select}::…` paths
// keep resolving; the no-op `NoopHooks` installed in `lib.rs` satisfies the
// post-recovery hook seam. The `init()` wiring stays mobile-side.
//
// `commands` is what `init()` registers; `account_number_select` is re-exported
// for path-compatibility (mirrors the desktop re-export surface), hence the
// `unused_imports` allow.
#[allow(unused_imports)]
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
