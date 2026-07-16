// SPDX-License-Identifier: AGPL-3.0
//! Device-local wrap key for the share-import staging queue (`MYF1`,
//! `protocol.md` § 9.19.2).
//!
//! A single **device-global** 32-byte symmetric key held in the OS keychain
//! (Apple) / Keystore (Android), used to seal not-yet-imported shared files
//! while the vault is locked. Like `super::super::captures::device_key`, it is
//! **non-biometric** (a background share-seal must never prompt Face ID) and is
//! device-only (`AfterFirstUnlockThisDeviceOnly` on Apple). There is no
//! `DeriveSubkey` role — a `root_key`-derived KEK would be wrong, since the
//! queue must be writable precisely while `root_key` is unavailable.
//!
//! The keychain service string is **DISTINCT** from the captures queue's
//! (`md.myne.shareimport` vs `md.myne.captures`) so the two device-local keys
//! never collide.
//!
//! ⚠️ **UNVERIFIED — pending a device keychain/Keystore test.** Compile-checked,
//! but the Apple keychain accessibility/non-prompting behaviour and the Android
//! Keystore path CANNOT be confirmed without real hardware.

use crate::plugins::share_import::error::ShareImportError;
use zeroize::Zeroizing;

/// Length of the device wrap key (256-bit XChaCha20-Poly1305 key).
pub const SHARE_WRAP_KEY_LEN: usize = 32;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use getrandom::getrandom;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password_options,
    };
    use security_framework::passwords_options::PasswordOptions;

    /// Keychain service string for the share-import device wrap key — DISTINCT
    /// from `md.myne.captures` and `md.myne.quickunlock`.
    ///
    /// On iOS this item is shared with the Share Extension via a
    /// `keychain-access-group` entitlement on both targets (SF2); the group
    /// prefix is applied by the OS, so the service string stays as below.
    const KEYCHAIN_SERVICE: &str = "md.myne.shareimport";
    /// Single device-global account key (the queue is not per-vault — it is
    /// created while locked and drains into whichever vault unlocks first,
    /// § 9.19).
    const KEYCHAIN_ACCOUNT: &str = "device-wrap-key";

    /// `errSecItemNotFound` — the keychain item is absent (never created / wiped).
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// Fetch the device wrap key, creating it on first use. Callers hold the
    /// queue mutex (`super::super::commands`), so create is race-free.
    pub fn get_or_create() -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
            Ok(bytes) if bytes.len() == SHARE_WRAP_KEY_LEN => {
                let mut key = Zeroizing::new([0u8; SHARE_WRAP_KEY_LEN]);
                key.copy_from_slice(&bytes);
                Ok(key)
            }
            // Present but wrong length (corrupt) → drop and re-mint.
            Ok(_) => {
                let _ = delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
                create()
            }
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => create(),
            Err(e) => {
                log_keychain_err("get", &e);
                Err(ShareImportError::Backend)
            }
        }
    }

    fn create() -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
        let mut key = Zeroizing::new([0u8; SHARE_WRAP_KEY_LEN]);
        getrandom(key.as_mut_slice()).map_err(|_| ShareImportError::Backend)?;

        // No SecAccessControl flags (0) → no biometric / user-presence gate;
        // AfterFirstUnlockThisDeviceOnly accessibility → background-writable
        // after first post-boot unlock, never syncs off-device.
        let access_control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        )
        .map_err(|e| {
            log_keychain_err("access_control_create", &e);
            ShareImportError::Backend
        })?;
        let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        options.set_access_control(access_control);
        set_generic_password_options(key.as_slice(), options).map_err(|e| {
            log_keychain_err("store", &e);
            ShareImportError::Backend
        })?;
        Ok(key)
    }

    /// Log a keychain failure with its OSStatus code (an OS status code is not
    /// key material — safe to emit; it is the diagnostic the hardware review
    /// needs, e.g. `-34018` errSecMissingEntitlement).
    fn log_keychain_err(op: &'static str, e: &security_framework::base::Error) {
        tracing::warn!(
            stage = "share_import_device_key",
            op,
            errsec_code = e.code(),
            "share-import device-key keychain operation failed"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use imp::get_or_create;

/// Android Keystore device wrap key (SYNC-3).
///
/// ⚠️ **NOT YET WIRED — [NEEDS DECISION: Keystore access path].** SYNC-3
/// ratified building the Android locked path in-epic, but reaching the Android
/// Keystore from Rust needs either a Kotlin/JNI bridge (the `screen_guard`
/// precedent) or a vetted Rust Keystore crate that does not break offline /
/// reproducible builds (NO `ndk-context`). Until that spike lands + a device
/// verifies the create/no-prompt/device-only behaviour, Android returns
/// [`ShareImportError::HardwareUnavailable`] so the commands no-op cleanly — the
/// unlocked direct-ingest path (SF3) still works; only the locked-vault staging
/// path is gated on this provider. Tracked in the SF1 open questions.
#[cfg(target_os = "android")]
pub fn get_or_create() -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
    Err(ShareImportError::HardwareUnavailable)
}

/// Desktop / other targets have no device keychain wired for this key — the
/// share-import queue is a mobile feature. Returns
/// [`ShareImportError::HardwareUnavailable`] so the commands no-op cleanly.
#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
pub fn get_or_create() -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
    Err(ShareImportError::HardwareUnavailable)
}

/// Provider seam for the **Android** device wrap key (SYNC-3). The key lives in
/// the Android Keystore, reachable only through a Kotlin plugin the mobile host
/// owns (`tauri-plugin-share-intent`) — which this shared `core` crate must not
/// depend on (it is also built by the desktop client). So the mobile host
/// implements this trait (wrapping that plugin's `get_or_create_device_key`
/// seam) and registers an [`AndroidShareDeviceKey`] as Tauri managed state;
/// [`resolve`] reads it on Android. This keeps the Keystore dependency in the
/// mobile layer, not in `core`.
///
/// ⚠️ DEVICE-VERIFY-PENDING: the Keystore behaviour (non-biometric, device-only,
/// no-prompt) can only be confirmed on a real Android device — see
/// `tauri-plugin-share-intent/KEYSTORE_TODO.md`.
#[cfg(target_os = "android")]
pub trait AndroidShareDeviceKeyProvider: Send + Sync + 'static {
    fn get_or_create(&self) -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError>;
}

/// Managed-state wrapper for an [`AndroidShareDeviceKeyProvider`] (Tauri
/// `manage` / `try_state` need a concrete `Send + Sync + 'static` type).
#[cfg(target_os = "android")]
pub struct AndroidShareDeviceKey(pub alloc_arc::Arc<dyn AndroidShareDeviceKeyProvider>);

// `std` is available in this crate (unlike `protocol`); alias kept local so the
// wrapper reads clearly.
#[cfg(target_os = "android")]
use std::sync as alloc_arc;

/// Resolve the device wrap key for a share-import seal/drain. On Android the key
/// comes from the Android Keystore via the host-registered
/// [`AndroidShareDeviceKey`] managed state (falling back to
/// [`ShareImportError::HardwareUnavailable`] when the host has not registered a
/// provider — an unprovisioned/no-plugin build). On Apple/desktop it is the
/// direct keychain provider ([`get_or_create`]). The command layer
/// (`seal_share` / `drain_pending_shares`, which hold the `AppHandle`) calls
/// this rather than `get_or_create` directly, so the Android path is reachable
/// without threading Tauri state into the OS-free `*_in_dir` cores.
pub fn resolve<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Zeroizing<[u8; SHARE_WRAP_KEY_LEN]>, ShareImportError> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let provider = app
            .try_state::<AndroidShareDeviceKey>()
            .ok_or(ShareImportError::HardwareUnavailable)?;
        provider.0.get_or_create()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        get_or_create()
    }
}
