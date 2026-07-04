//! Quick-unlock plugin (MYND-329) — desktop host.
//!
//! Quick-unlock stores a third wrapped copy of `root_key` in the device-local
//! `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`, § 9.14) so
//! a re-lock can be reversed with Touch ID / a PIN instead of the full
//! master-password Argon2id path — without touching the zero-knowledge root.
//!
//! The PIN path + the OS-free `*_with_dir` cores moved to `myne-core`
//! (`myne_core::plugins::quick_unlock`, shared with the mobile client). This
//! crate keeps the macOS Keychain biometric provider (`macos`), the biometric
//! command branch, and the OS-credential cleanup (`commands`), and registers all
//! six commands. Mobile registers only the four PIN/status/disable commands.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

// The wrap-key providers, PIN provider, attempt counter, and error enum moved to
// myne-core. Re-exported so existing `crate::plugins::quick_unlock::{attempt,
// error, pin, provider}::…` paths keep resolving (incl. `macos.rs`'s
// `super::provider::…`).
pub use myne_core::plugins::quick_unlock::{attempt, error, pin, provider};

// Desktop command surface: PIN commands re-exported from core + the macOS
// biometric branch + OS-credential cleanup.
pub mod commands;
#[cfg(target_os = "macos")]
pub mod macos;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `quick-unlock` plugin. The runtime state it relies on
/// (`VaultRuntimeState`) is registered by the `vault-unlock` plugin; this
/// plugin only binds its IPC commands.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // PIN/status commands are registered via their myne-core module path so
    // `generate_handler!` sees the `#[tauri::command]`-generated hidden items
    // (a bare `pub use` of the fn would not carry them). Biometric + disable are
    // defined in the desktop `commands` module.
    Builder::<R>::new("quick-unlock")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::quick_unlock::commands::quick_unlock_setup_pin,
            myne_core::plugins::quick_unlock::commands::quick_unlock_with_pin,
            commands::quick_unlock_setup_biometric,
            commands::quick_unlock_with_biometric,
            myne_core::plugins::quick_unlock::commands::quick_unlock_status,
            commands::quick_unlock_disable,
        ])
        .build()
}
