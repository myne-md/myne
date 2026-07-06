//! Quick-unlock (PIN) plugin — mobile host.
//!
//! Quick-unlock stores a third wrapped copy of `root_key` in the device-local
//! `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`, § 9.14) so a
//! re-lock can be reversed with a PIN instead of the full master-password
//! Argon2id path — without touching the zero-knowledge root.
//!
//! The PIN path + the OS-free `*_with_dir` cores live in `myne-core`
//! (`myne_core::plugins::quick_unlock`, shared with the desktop client). Mobile
//! registers only the four PIN / status / disable commands. Biometric is
//! desktop-only (macOS Secure Enclave); a mobile biometric provider (iOS
//! Face/Touch ID, Android BiometricPrompt) is a Phase-3+ decision — see
//! `myne-mobile/CLAUDE.md` "Biometric vault unlock is a Phase 3+ design
//! question".
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" in the main repo.

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::quick_unlock::{attempt,error,pin,provider}` (mirrors the
// desktop re-export surface); `commands` is the only symbol `init()` registers.
#[allow(unused_imports)]
pub use myne_core::plugins::quick_unlock::{attempt, commands, error, pin, provider};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `quick-unlock` plugin (PIN path only). The
/// `VaultRuntimeState` it borrows is registered by the `vault-unlock` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("quick-unlock")
        .invoke_handler(tauri::generate_handler![
            commands::quick_unlock_setup_pin,
            commands::quick_unlock_with_pin,
            commands::quick_unlock_status,
            commands::quick_unlock_disable,
        ])
        .build()
}
