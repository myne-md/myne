//! Quick-unlock plugin (MYND-329) — PIN / biometric fast re-entry over the
//! auto-lock envelope.
//!
//! Quick-unlock stores a third wrapped copy of `root_key` in the device-local
//! `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`, § 9.14) so
//! a re-lock can be reversed with Touch ID / a PIN instead of the full
//! master-password Argon2id path — without touching the zero-knowledge root.
//!
//! Module layout:
//! - `provider` — the `QuickUnlockProvider` trait + test `MockProvider` (task 3)
//! - `pin` — the PIN (Argon2id) provider (task 4)
//! - `attempt` — the code-enforced failed-attempt counter (task 5)
//! - `commands` / `error` — the Tauri plugin surface (task 6)
//! - `macos` — the macOS Keychain biometric provider (task 7)
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod attempt;
pub mod commands;
pub mod error;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod pin;
pub mod provider;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `quick-unlock` plugin. The runtime state it relies on
/// (`VaultRuntimeState`) is registered by the `vault-unlock` plugin; this
/// plugin only binds its IPC commands.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("quick-unlock")
        .invoke_handler(tauri::generate_handler![
            commands::quick_unlock_setup_pin,
            commands::quick_unlock_with_pin,
            commands::quick_unlock_setup_biometric,
            commands::quick_unlock_with_biometric,
            commands::quick_unlock_status,
            commands::quick_unlock_disable,
        ])
        .build()
}
