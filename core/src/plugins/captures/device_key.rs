// SPDX-License-Identifier: AGPL-3.0-only
//! Device-local wrap key for the pending-capture queue (`MYK1`, `protocol.md`
//! § 9.18.2).
//!
//! A single **device-global** 32-byte symmetric key held in the OS keychain,
//! used to seal not-yet-committed watch-dictated captures while the vault is
//! locked. Unlike the quick-unlock provider key (`super::super::quick_unlock`),
//! this key is **non-biometric** (a background enqueue must never prompt Face
//! ID) and is stored `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — a
//! deliberate divergence from quick-unlock's `WhenUnlocked...BiometryCurrentSet`:
//! sealing must be able to run in the background after first post-boot unlock so
//! the transient plaintext staging window (§ 9.18.4) is minimised. There is no
//! `DeriveSubkey` role — a `root_key`-derived KEK would be wrong, since the
//! queue must be writable precisely while `root_key` is unavailable.
//!
//! ⚠️ **UNVERIFIED — pending a device keychain test.** Compile-checked on
//! macOS/iOS, but the keychain accessibility + non-prompting behaviour CANNOT be
//! confirmed without real hardware. The manual checklist to run before trusting
//! it: (1) confirm `get_or_create` creates the item with NO biometric prompt;
//! (2) confirm a seal succeeds in the background while the screen is locked
//! (AfterFirstUnlock); (3) confirm the item is `ThisDeviceOnly` (absent from an
//! iCloud-Keychain-synced sibling device).

use crate::plugins::captures::error::CaptureError;
use zeroize::Zeroizing;

/// Length of the device wrap key (256-bit XChaCha20-Poly1305 key).
pub const CAPTURE_WRAP_KEY_LEN: usize = 32;

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use getrandom::getrandom;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password_options,
    };
    use security_framework::passwords_options::PasswordOptions;

    /// Keychain service string for the pending-capture device wrap key —
    /// DISTINCT from `md.myne.quickunlock` so the two device-local keys never
    /// collide.
    const KEYCHAIN_SERVICE: &str = "md.myne.captures";
    /// Single device-global account key (the queue is not per-vault — it is
    /// created while locked and drains into whichever vault unlocks first,
    /// § 9.18).
    const KEYCHAIN_ACCOUNT: &str = "device-wrap-key";

    /// `errSecItemNotFound` — the keychain item is absent (never created / wiped).
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// Fetch the device wrap key, creating it on first use. Callers hold the
    /// queue mutex (`super::super::commands`), so create is race-free.
    ///
    /// The keychain's `Vec` is wrapped **on receipt**, before any arm inspects
    /// it: `get_generic_password` returns a plain `Vec<u8>` holding the wrap key,
    /// and wrapping only the fixed-size copy below would leave the source
    /// allocation intact on every read — including the corrupt-length arm, which
    /// never reaches a `Zeroizing` copy at all.
    ///
    /// **Honest limit** (`docs/threat-model.md` §7 defers forensic-grade
    /// scrubbing): `security_framework` builds that `Vec` from a `CFData` it then
    /// releases without wiping, so a CoreFoundation-side residue survives this.
    /// Reaching it would mean dropping to `SecItemCopyMatching` directly.
    pub fn get_or_create() -> Result<Zeroizing<[u8; CAPTURE_WRAP_KEY_LEN]>, CaptureError> {
        match get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map(Zeroizing::new) {
            Ok(bytes) if bytes.len() == CAPTURE_WRAP_KEY_LEN => {
                let mut key = Zeroizing::new([0u8; CAPTURE_WRAP_KEY_LEN]);
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
                Err(CaptureError::Backend)
            }
        }
    }

    fn create() -> Result<Zeroizing<[u8; CAPTURE_WRAP_KEY_LEN]>, CaptureError> {
        let mut key = Zeroizing::new([0u8; CAPTURE_WRAP_KEY_LEN]);
        getrandom(key.as_mut_slice()).map_err(|_| CaptureError::Backend)?;

        // No SecAccessControl flags (0) → no biometric / user-presence gate;
        // AfterFirstUnlockThisDeviceOnly accessibility → background-writable
        // after first post-boot unlock, never syncs off-device.
        let access_control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        )
        .map_err(|e| {
            log_keychain_err("access_control_create", &e);
            CaptureError::Backend
        })?;
        let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        options.set_access_control(access_control);
        set_generic_password_options(key.as_slice(), options).map_err(|e| {
            log_keychain_err("store", &e);
            CaptureError::Backend
        })?;
        Ok(key)
    }

    /// Log a keychain failure with its OSStatus code (an OS status code is not
    /// key material — safe to emit; it is the diagnostic the hardware review
    /// needs, e.g. `-34018` errSecMissingEntitlement).
    fn log_keychain_err(op: &'static str, e: &security_framework::base::Error) {
        tracing::warn!(
            stage = "captures_device_key",
            op,
            errsec_code = e.code(),
            "captures device-key keychain operation failed"
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub use imp::get_or_create;

/// Non-Apple platforms have no device keychain wired for this key — the queue
/// is an Apple-Watch-companion feature. Returns [`CaptureError::HardwareUnavailable`]
/// so the commands no-op cleanly (Android/Linux/Windows never enqueue).
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get_or_create() -> Result<Zeroizing<[u8; CAPTURE_WRAP_KEY_LEN]>, CaptureError> {
    Err(CaptureError::HardwareUnavailable)
}
