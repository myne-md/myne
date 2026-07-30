// SPDX-License-Identifier: AGPL-3.0
//! Apple-Keychain biometric wrap-key provider for quick-unlock (MYND-329,
//! task 7; generalized macOS → macOS + iOS when it moved here from the desktop
//! crate so the mobile client shares it — decisions.md 2026-07-12).
//!
//! One provider, two platforms behind the same `provider_kind 0x01`:
//! - **macOS** — Touch ID via the login Keychain.
//! - **iOS** — Face ID / Touch ID via the device Keychain (Secure-Enclave-backed
//!   on all supported hardware). The host app MUST declare
//!   `NSFaceIDUsageDescription` (myne-mobile `Info.ios.plist`) or the Face ID
//!   prompt is denied by the OS.
//!
//! ⚠️ **UNVERIFIED — pending biometric hardware test + a primitive-level review.**
//! This module is compile-checked on macOS/iOS but its biometric gating CANNOT
//! be confirmed without real hardware: a mistake here could store the wrap key
//! WITHOUT an effective biometric requirement (the Bitwarden CVE-2023-27706
//! failure class), which compilation does not catch. Do not rely on it until:
//! (1) a device with Touch ID / Face ID confirms `retrieve` actually prompts
//! and that a non-authenticated read fails; (2) the design session's flagged
//! `kSecAccessControlBiometryCurrentSet` primitive review is done (`/grill-me`).
//! The biometric command branch IS wired (`quick_unlock_*_biometric`) precisely
//! so that hardware verification — the task's manual checklist — can be run; it
//! must not be presented to users as a trusted gate until the checklist passes.
//!
//! Design (the part that IS settled): mint a 32-byte random `wrap_key`, store it
//! as a Keychain generic-password item under an access-control object built with
//! `kSecAccessControlBiometryCurrentSet` + `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
//! Retrieving it triggers the OS biometric prompt inherently (gated resource,
//! not an app-level boolean — the OWASP-MASTG / Teleport-RFD-54 lesson). The
//! `biometryCurrentSet` flag invalidates the item when the enrolled biometric
//! set changes (User Story 9, for free at the OS level).

#![cfg(any(target_os = "macos", target_os = "ios"))]

use super::provider::{ProviderError, ProviderSecret, QuickUnlockProvider, WRAP_KEY_LEN};
use getrandom::getrandom;
use protocol::quick_unlock_blob::{PROVIDER_KIND_BIOMETRIC, QUICK_UNLOCK_PIN_SALT_LEN};
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::passwords::{delete_generic_password, get_generic_password};
use security_framework::passwords_options::PasswordOptions;
use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
use zeroize::Zeroizing;

/// Keychain service string for quick-unlock wrap keys. Vault identity is the
/// account component (the hex `account_number_hash`), so one device can hold
/// distinct items for distinct vaults. UNCHANGED from the desktop-era value —
/// existing macOS Touch ID credentials keep resolving after the move to
/// `myne-core`.
const KEYCHAIN_SERVICE: &str = "md.myne.quickunlock";

/// The Apple biometric provider (macOS Touch ID; iOS Face ID / Touch ID).
/// Constructed per operation from the vault's `account_number_hash` (the
/// Keychain account key); holds no secret itself — the wrap key lives in the
/// Keychain behind the biometric gate.
pub struct AppleBiometricProvider {
    account: String,
}

impl AppleBiometricProvider {
    /// Build a provider keyed to a vault by its `account_number_hash`.
    pub fn new(account_number_hash: [u8; 16]) -> Self {
        Self {
            account: hex_lower(&account_number_hash),
        }
    }

    /// Build the biometry-current-set + this-device-only access control object.
    fn access_control() -> Result<SecAccessControl, ProviderError> {
        // `kSecAccessControlBiometryCurrentSet`: require Touch ID / Face ID, and
        // invalidate if the enrolled biometric set changes.
        // `WhenUnlockedThisDeviceOnly`: non-exportable, never leaves this device.
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            kSecAccessControlBiometryCurrentSet,
        )
        .map_err(|e| {
            log_keychain_err("access_control_create", &e);
            ProviderError::Backend
        })
    }
}

impl QuickUnlockProvider for AppleBiometricProvider {
    fn kind(&self) -> u8 {
        PROVIDER_KIND_BIOMETRIC
    }

    fn create(&self) -> Result<ProviderSecret, ProviderError> {
        let mut wrap_key = [0u8; WRAP_KEY_LEN];
        getrandom(&mut wrap_key).map_err(|_| ProviderError::Backend)?;
        let wrap_key = Zeroizing::new(wrap_key);

        // Replace any stale item first (idempotent re-setup).
        let _ = delete_generic_password(KEYCHAIN_SERVICE, &self.account);

        let access_control = Self::access_control()?;
        let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, &self.account);
        options.set_access_control(access_control);
        // Store the wrap key behind the biometric gate.
        security_framework::passwords::set_generic_password_options(wrap_key.as_slice(), options)
            .map_err(|e| {
            log_keychain_err("store", &e);
            ProviderError::Backend
        })?;

        Ok(ProviderSecret {
            wrap_key,
            pin_salt: [0u8; QUICK_UNLOCK_PIN_SALT_LEN],
        })
    }

    fn retrieve(
        &self,
        _pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        // Reading the gated item triggers the OS biometric prompt. A user-cancel
        // / no-hardware surfaces as an error; we map to the coarse variants the
        // command layer expects (cancel → silent password fallback).
        let bytes =
            get_generic_password(KEYCHAIN_SERVICE, &self.account).map_err(map_keychain_error)?;
        if bytes.len() != WRAP_KEY_LEN {
            return Err(ProviderError::CredentialMissing);
        }
        let mut wrap_key = Zeroizing::new([0u8; WRAP_KEY_LEN]);
        wrap_key.copy_from_slice(&bytes);
        Ok(wrap_key)
    }

    fn delete(&self) -> Result<(), ProviderError> {
        match delete_generic_password(KEYCHAIN_SERVICE, &self.account) {
            Ok(()) => Ok(()),
            // An already-absent item is a successful delete (idempotent).
            Err(_) => Ok(()),
        }
    }
}

/// `errSecUserCanceled` — the user dismissed the biometric prompt.
const ERR_SEC_USER_CANCELED: i32 = -128;
/// `errSecItemNotFound` — the Keychain item is absent (wiped / never set).
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
/// `errSecMissingEntitlement` — this PROCESS may not use the Keychain item,
/// regardless of hardware. The dominant cause is an unsigned binary: a
/// biometric-gated (`kSecAccessControlBiometryCurrentSet`) item requires the
/// `keychain-access-groups` entitlement on a SIGNED build, and `tauri dev`
/// runs unsigned. Distinguishing it from [`ProviderError::Backend`] is what
/// lets the Unlock screen say "biometric unavailable in this build" and fall
/// back to the password, instead of surfacing an opaque backend failure that
/// reads as "Touch ID is broken" (MYND-628).
const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;

/// Log a Keychain failure with its OSStatus code (safe to emit — an OS status
/// code is not key material; the DENY-list covers keys/PINs/paths, not error
/// codes). The code is the diagnostic the hardware review needs (e.g.
/// `-34018` errSecMissingEntitlement → the dev build isn't signed with the
/// keychain entitlement; `-25293` errSecAuthFailed → biometric mismatch).
fn log_keychain_err(op: &'static str, e: &security_framework::base::Error) {
    tracing::warn!(
        stage = "quick_unlock_biometric",
        op,
        errsec_code = e.code(),
        "Apple Keychain operation failed"
    );
}

/// Map a Keychain error (from `retrieve`) to the coarse provider error, logging
/// its OSStatus code first. User-cancel → silent password fallback (no attempt
/// burned); item-not-found → credential missing; missing-entitlement → the
/// facility is unusable by this build (see [`ERR_SEC_MISSING_ENTITLEMENT`]);
/// everything else → a backend failure surfaced (with the logged code) so the
/// real cause is visible.
fn map_keychain_error(e: security_framework::base::Error) -> ProviderError {
    log_keychain_err("retrieve", &e);
    match e.code() {
        ERR_SEC_USER_CANCELED => ProviderError::UserCancelled,
        ERR_SEC_ITEM_NOT_FOUND => ProviderError::CredentialMissing,
        ERR_SEC_MISSING_ENTITLEMENT => ProviderError::HardwareUnavailable,
        _ => ProviderError::Backend,
    }
}

/// Lowercase-hex encode (no external dep; matches the device-local naming).
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // The OSStatus constants are the contract with the OS, not our invention —
    // a typo here would silently reroute a real failure into the wrong
    // user-facing branch. Pin them against Apple's published values.
    #[test]
    fn osstatus_constants_match_apple_values() {
        assert_eq!(ERR_SEC_USER_CANCELED, -128, "errSecUserCanceled");
        assert_eq!(ERR_SEC_ITEM_NOT_FOUND, -25300, "errSecItemNotFound");
        assert_eq!(
            ERR_SEC_MISSING_ENTITLEMENT, -34018,
            "errSecMissingEntitlement"
        );
    }

    #[test]
    fn account_key_is_lowercase_hex_of_the_account_number_hash() {
        // The Keychain account component IS the vault's identity: two vaults on
        // one device must land on distinct items, and the encoding must stay
        // byte-stable or every existing macOS credential stops resolving.
        let provider = AppleBiometricProvider::new([
            0x00, 0x0f, 0x10, 0xff, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x9a, 0xbc,
            0xde, 0xf0,
        ]);
        assert_eq!(provider.account, "000f10ffabcdef01234567899abcdef0");
    }

    #[test]
    fn distinct_vaults_get_distinct_keychain_accounts() {
        let a = AppleBiometricProvider::new([0u8; 16]);
        let b = AppleBiometricProvider::new([1u8; 16]);
        assert_ne!(a.account, b.account);
    }
}
