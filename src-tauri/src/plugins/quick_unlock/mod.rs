//! Quick-unlock plugin (MYND-329) — desktop host.
//!
//! Quick-unlock stores a third wrapped copy of `root_key` in the device-local
//! `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`, § 9.14) so
//! a re-lock can be reversed with Touch ID / a PIN instead of the full
//! master-password Argon2id path — without touching the zero-knowledge root.
//!
//! The whole surface now lives in `myne-core` (`myne_core::plugins::quick_unlock`,
//! shared with the mobile client): the PIN path, the OS-free `*_with_dir`
//! cores, AND the Apple-Keychain biometric provider + its command branch
//! (generalized macOS → macOS + iOS, decisions.md 2026-07-12). This crate only
//! registers the six shared commands.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// Re-exported so existing `crate::plugins::quick_unlock::{attempt, error, pin,
// provider, commands}::…` paths keep resolving (`hooks.rs` reaches
// `commands::invalidate_credential` through this).
#[allow(unused_imports)]
pub use myne_core::plugins::quick_unlock::{attempt, commands, error, pin, provider};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `quick-unlock` plugin. The runtime state it relies on
/// (`VaultRuntimeState`) is registered by the `vault-unlock` plugin; this
/// plugin only binds its IPC commands.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Commands are registered via their myne-core module path so
    // `generate_handler!` sees the `#[tauri::command]`-generated hidden items
    // (a bare `pub use` of the fn would not carry them).
    Builder::<R>::new("quick-unlock")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::quick_unlock::commands::quick_unlock_setup_pin,
            myne_core::plugins::quick_unlock::commands::quick_unlock_with_pin,
            myne_core::plugins::quick_unlock::commands::quick_unlock_setup_biometric,
            myne_core::plugins::quick_unlock::commands::quick_unlock_with_biometric,
            myne_core::plugins::quick_unlock::commands::quick_unlock_status,
            myne_core::plugins::quick_unlock::commands::quick_unlock_disable,
        ])
        .build()
}
