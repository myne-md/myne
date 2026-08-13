//! Quick-unlock (PIN + biometric) plugin — mobile host.
//!
//! Quick-unlock stores a third wrapped copy of `root_key` in the device-local
//! `vault.quickunlock` blob (`protocol::quick_unlock_blob`, `MYQ1`, § 9.14) so a
//! re-lock can be reversed with Face ID / Touch ID or a PIN instead of the full
//! master-password Argon2id path — without touching the zero-knowledge root.
//!
//! Everything lives in `myne-core` (`myne_core::plugins::quick_unlock`, shared
//! with the desktop client): the PIN path, the OS-free `*_with_dir` cores, and
//! the Apple-Keychain biometric provider + command branch (macOS Touch ID / iOS
//! Face ID + Touch ID behind `kSecAccessControlBiometryCurrentSet`; the
//! threat-model trade-off is analyzed in the main repo's `design-notes.md`
//! 2026-07-12 entry). On Android the biometric commands return
//! `HardwareUnavailable` until an Android Keystore provider lands (Android
//! packaging itself is not initialized yet).
//!
//! iOS requires `NSFaceIDUsageDescription` (`Info.ios.plist`) for the Face ID
//! prompt; the Keychain item is device-only (`WhenUnlockedThisDeviceOnly`), so
//! a restored backup re-offers setup instead of silently resurrecting the gate.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" in the main repo.

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::quick_unlock::{attempt,error,pin,provider}` (mirrors the
// desktop re-export surface); `commands` is what `init()` and `hooks.rs`
// (`invalidate_credential`) reach through.
#[allow(unused_imports)]
pub use myne_core::plugins::quick_unlock::{attempt, commands, error, pin, provider};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `quick-unlock` plugin (PIN + biometric). The
/// `VaultRuntimeState` it borrows is registered by the `vault-unlock` plugin.
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
