//! macOS Touch ID wrap-key provider for quick-unlock (MYND-329, task 7).
//!
//! ⚠️ **UNVERIFIED — pending Touch ID hardware test + a primitive-level review.**
//! This module is compile-checked on macOS but its biometric gating CANNOT be
//! confirmed without real Touch ID hardware: a mistake here could store the
//! wrap key WITHOUT an effective biometric requirement (the Bitwarden
//! CVE-2023-27706 failure class), which compilation does not catch. Do not rely
//! on it until: (1) a device with Touch ID confirms `retrieve` actually prompts
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

#![cfg(target_os = "macos")]

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
/// distinct items for distinct vaults.
const KEYCHAIN_SERVICE: &str = "md.myne.quickunlock";

/// The macOS Touch ID provider. Constructed per operation from the vault's
/// `account_number_hash` (the Keychain account key); holds no secret itself —
/// the wrap key lives in the Keychain behind the biometric gate.
pub struct MacosBiometricProvider {
    account: String,
}

impl MacosBiometricProvider {
    /// Build a provider keyed to a vault by its `account_number_hash`.
    pub fn new(account_number_hash: [u8; 16]) -> Self {
        Self {
            account: hex_lower(&account_number_hash),
        }
    }

    /// Build the biometry-current-set + this-device-only access control object.
    fn access_control() -> Result<SecAccessControl, ProviderError> {
        // `kSecAccessControlBiometryCurrentSet`: require Touch ID, and invalidate
        // if the enrolled biometric set changes. `WhenUnlockedThisDeviceOnly`:
        // non-exportable, never leaves this device.
        SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            kSecAccessControlBiometryCurrentSet,
        )
        .map_err(|_| ProviderError::Backend)
    }
}

impl QuickUnlockProvider for MacosBiometricProvider {
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
            .map_err(|_| ProviderError::Backend)?;

        Ok(ProviderSecret {
            wrap_key,
            pin_salt: [0u8; QUICK_UNLOCK_PIN_SALT_LEN],
        })
    }

    fn retrieve(
        &self,
        _pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        // Reading the gated item triggers the OS Touch ID prompt. A user-cancel
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

/// Map a Keychain error to the coarse provider error. NOTE: precise mapping
/// (user-cancel `errSecUserCanceled` vs missing `errSecItemNotFound` vs
/// biometry-lockout) is part of the pending hardware review — today an
/// unauthenticated/failed read collapses to `UserCancelled` so the command
/// layer falls back to the password path rather than burning an attempt.
fn map_keychain_error(_e: security_framework::base::Error) -> ProviderError {
    ProviderError::UserCancelled
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
