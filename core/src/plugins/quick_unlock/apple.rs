// SPDX-License-Identifier: AGPL-3.0
//! Apple-Keychain biometric wrap-key provider for quick-unlock (MYND-329,
//! task 7; generalized macOS → macOS + iOS when it moved here from the desktop
//! crate so the mobile client shares it — decisions.md 2026-07-12).
//!
//! One provider, two platforms behind the same `provider_kind 0x01`:
//! - **macOS** — Touch ID via the login Keychain.
//! - **iOS** — Face ID / Touch ID via the device Keychain (Secure-Enclave-backed
//!   on all supported hardware). The host app MUST declare
//!   `NSFaceIDUsageDescription` (mobile `Info.ios.plist`) or the Face ID
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
//!
//! The item is named per VAULT, not per account — see [`AppleBiometricProvider`]
//! for why, and for the read-side migration that re-homes a credential enrolled
//! under the earlier account-only name.

#![cfg(any(target_os = "macos", target_os = "ios"))]

use super::provider::{ProviderError, ProviderSecret, QuickUnlockProvider, WRAP_KEY_LEN};
use crate::vault_id::VaultId;
use getrandom::getrandom;
use protocol::quick_unlock_blob::{PROVIDER_KIND_BIOMETRIC, QUICK_UNLOCK_PIN_SALT_LEN};
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::passwords::{delete_generic_password, get_generic_password};
use security_framework::passwords_options::PasswordOptions;
use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
use zeroize::Zeroizing;

/// Keychain service string for quick-unlock wrap keys — the app-level namespace
/// (same shape as `md.myne.shareimport`); per-item identity lives in the account
/// component, not here. UNCHANGED from the desktop-era value — existing macOS
/// Touch ID credentials keep resolving after the move to `myne-core`.
const KEYCHAIN_SERVICE: &str = "md.myne.quickunlock";

/// Separator between the account and vault halves of the Keychain account
/// component. `:` is outside the hex alphabet and outside a `VaultId`'s
/// canonical form, so the two halves can never be confused for one another.
const ACCOUNT_COMPONENT_SEPARATOR: char = ':';

/// The Apple biometric provider (macOS Touch ID; iOS Face ID / Touch ID).
/// Constructed per operation from the vault's `account_number_hash` AND its
/// [`VaultId`]; holds no secret itself — the wrap key lives in the Keychain
/// behind the biometric gate.
///
/// **Both halves are required for identity.** `account_number_hash` names an
/// ACCOUNT, and one device can hold two vault directories for one account (a
/// `CollisionIntent::KeepBoth` restore, or joining an account this device
/// already holds — both mint a fresh `VaultId` around a byte-identical
/// `vault.meta`). Keying the Keychain item by the hash alone made those twins
/// address one item, so setting up biometric quick-unlock on one silently
/// overwrote the other's live wrap key — after which the sibling's unlock
/// attempts read as "wrong credential" and burned its attempt counter down to
/// the wipe.
pub struct AppleBiometricProvider {
    /// Vault-scoped Keychain account component:
    /// `hex(account_number_hash) : vault_id`. **Frozen encoding** — the OS
    /// matches it byte-for-byte, so reformatting it strands every credential
    /// already enrolled under the current shape.
    account: String,
    /// The pre-vault-scoping account component (bare hex `account_number_hash`),
    /// kept solely as [`QuickUnlockProvider::retrieve`]'s one-time migration
    /// lookup. Frozen for the same reason, and read-side ONLY: see
    /// [`AppleBiometricProvider::delete_with_ops`] for why nothing else may
    /// touch it.
    legacy_account: String,
}

impl AppleBiometricProvider {
    /// Build a provider keyed to one vault: its `account_number_hash` and the
    /// [`VaultId`] naming its directory. Callers already hold the vault root,
    /// so the id is `crate::paths::vault_id_from_root(&dir)` away.
    pub fn new(account_number_hash: [u8; 16], vault_id: VaultId) -> Self {
        let legacy_account = hex_lower(&account_number_hash);
        Self {
            account: format!("{legacy_account}{ACCOUNT_COMPONENT_SEPARATOR}{vault_id}"),
            legacy_account,
        }
    }

    /// [`QuickUnlockProvider::create`] over an injected Keychain, so the
    /// account-name routing is testable without biometric hardware.
    fn create_with_ops(&self, ops: &dyn KeychainOps) -> Result<ProviderSecret, ProviderError> {
        // Filled IN PLACE inside the wrapper. Minting into a bare array and then
        // moving it into `Zeroizing` wipes the destination slot, never the stack
        // array the CSPRNG actually wrote — same shape as
        // `captures::device_key::create`.
        let mut wrap_key = Zeroizing::new([0u8; WRAP_KEY_LEN]);
        getrandom(wrap_key.as_mut_slice()).map_err(|_| ProviderError::Backend)?;

        // Replace any stale item first (idempotent re-setup). Only this vault's
        // item — a twin's legacy item is not ours to remove.
        ops.delete(&self.account);

        // Store the wrap key behind the biometric gate.
        ops.store(&self.account, wrap_key.as_slice())?;

        Ok(ProviderSecret {
            wrap_key,
            pin_salt: [0u8; QUICK_UNLOCK_PIN_SALT_LEN],
        })
    }

    /// [`QuickUnlockProvider::retrieve`] over an injected Keychain, carrying the
    /// one-time migration off the legacy account component.
    ///
    /// The vault-scoped item is looked up first; only `errSecItemNotFound`
    /// (→ [`ProviderError::CredentialMissing`]) falls back to the legacy one, so
    /// a cancelled prompt or an unsigned build still surfaces its own error. A
    /// successful legacy read happened INSIDE the biometric prompt the user just
    /// passed, so the same `wrap_key` is re-stored under the vault-scoped
    /// account and the legacy item removed — a single-vault install upgrades
    /// transparently on its next unlock, with no UI and no unlocked vault. The
    /// re-store is best-effort: if it fails the legacy item stays, because
    /// deleting it before its replacement exists destroys the credential.
    fn retrieve_with_ops(
        &self,
        ops: &dyn KeychainOps,
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        match ops.get(&self.account) {
            Ok(bytes) => wrap_key_from_item(bytes.as_slice()),
            Err(ProviderError::CredentialMissing) => {
                let legacy = ops.get(&self.legacy_account)?;
                let wrap_key = wrap_key_from_item(legacy.as_slice())?;
                if ops.store(&self.account, wrap_key.as_slice()).is_ok() {
                    ops.delete(&self.legacy_account);
                }
                Ok(wrap_key)
            }
            Err(e) => Err(e),
        }
    }

    /// [`QuickUnlockProvider::delete`] over an injected Keychain.
    ///
    /// **No legacy fallback here, deliberately.** On a twin install the legacy
    /// item may be the SIBLING's live credential, and `delete` runs on paths the
    /// sibling never consented to (disable, master-password change, the
    /// attempt-counter wipe). The cost is that a twin install can orphan one
    /// legacy item — a random 32-byte secret behind biometry whose blob is gone,
    /// i.e. hygiene residue, not exposure.
    fn delete_with_ops(&self, ops: &dyn KeychainOps) -> Result<(), ProviderError> {
        // An already-absent item is a successful delete (idempotent).
        ops.delete(&self.account);
        Ok(())
    }
}

impl QuickUnlockProvider for AppleBiometricProvider {
    fn kind(&self) -> u8 {
        PROVIDER_KIND_BIOMETRIC
    }

    fn create(&self) -> Result<ProviderSecret, ProviderError> {
        self.create_with_ops(&RealKeychain)
    }

    fn retrieve(
        &self,
        _pin_salt: &[u8; QUICK_UNLOCK_PIN_SALT_LEN],
    ) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
        self.retrieve_with_ops(&RealKeychain)
    }

    fn delete(&self) -> Result<(), ProviderError> {
        self.delete_with_ops(&RealKeychain)
    }
}

/// The Keychain operations this provider needs, behind a trait so the
/// account-name routing — and the legacy-account migration in particular — is
/// exercisable without biometric hardware. The biometric gate itself is NOT
/// simulated: it is exactly the part the module header defers to a hardware
/// checklist. [`RealKeychain`] is the only production implementation.
trait KeychainOps {
    /// Read an item, mapping the OSStatus to the coarse provider error.
    fn get(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, ProviderError>;
    /// Store `secret` under `account` behind a fresh biometry-current-set
    /// access-control object.
    fn store(&self, account: &str, secret: &[u8]) -> Result<(), ProviderError>;
    /// Remove an item; an absent item is not a failure.
    fn delete(&self, account: &str);
}

/// The production [`KeychainOps`] — the Apple Keychain itself.
struct RealKeychain;

impl KeychainOps for RealKeychain {
    fn get(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
        // Reading the gated item triggers the OS biometric prompt. A user-cancel
        // / no-hardware surfaces as an error; we map to the coarse variants the
        // command layer expects (cancel → silent password fallback).
        //
        // `Zeroizing` goes on the returned `Vec` ITSELF, not on a fixed-size copy
        // taken from it later: this `Vec` holds the wrap key that unwraps
        // `vault.quickunlock`'s third `root_key` copy, and every caller arm —
        // including `wrap_key_from_item`'s wrong-length reject — must leave a
        // wiped allocation behind. **Honest limit** (`docs/threat-model.md` §7
        // defers forensic-grade scrubbing): `security_framework` builds this
        // `Vec` from a `CFData` it then releases without wiping, so a
        // CoreFoundation-side residue survives; reaching it would mean dropping
        // to `SecItemCopyMatching` directly.
        get_generic_password(KEYCHAIN_SERVICE, account)
            .map(Zeroizing::new)
            .map_err(map_keychain_error)
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), ProviderError> {
        let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, account);
        options.set_access_control(access_control()?);
        security_framework::passwords::set_generic_password_options(secret, options)
            .map_err(map_store_error)
    }

    fn delete(&self, account: &str) {
        let _ = delete_generic_password(KEYCHAIN_SERVICE, account);
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

/// Narrow a Keychain item's bytes to a wrap key. A wrong length is a corrupt /
/// foreign item, which is indistinguishable from no credential at all here.
fn wrap_key_from_item(bytes: &[u8]) -> Result<Zeroizing<[u8; WRAP_KEY_LEN]>, ProviderError> {
    if bytes.len() != WRAP_KEY_LEN {
        return Err(ProviderError::CredentialMissing);
    }
    let mut wrap_key = Zeroizing::new([0u8; WRAP_KEY_LEN]);
    wrap_key.copy_from_slice(bytes);
    Ok(wrap_key)
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

/// Map a Keychain error from `create` (store). The dominant failure on an
/// UNSIGNED build is `errSecMissingEntitlement`: a biometric-gated item needs the
/// `keychain-access-groups` entitlement on a signed binary, which `tauri dev`
/// (and an unsigned `tauri build`) lacks. Surfacing it as `HardwareUnavailable`
/// rather than the opaque `Backend` is what lets Settings say "Touch ID isn't
/// available in this build" and hide the affordance, instead of a generic
/// "something went wrong" that reads as "Touch ID is broken" (#214). Anything
/// else → `Backend`, with the OSStatus code logged for the hardware review.
fn map_store_error(e: security_framework::base::Error) -> ProviderError {
    log_keychain_err("store", &e);
    match e.code() {
        ERR_SEC_MISSING_ENTITLEMENT => ProviderError::HardwareUnavailable,
        _ => ProviderError::Backend,
    }
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
    use std::cell::RefCell;

    const HASH: [u8; 16] = [
        0x00, 0x0f, 0x10, 0xff, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0x9a, 0xbc, 0xde,
        0xf0,
    ];
    const HASH_HEX: &str = "000f10ffabcdef01234567899abcdef0";
    const VAULT_A: &str = "0197c0de-0000-7000-8000-00000000000a";
    const VAULT_B: &str = "0197c0de-0000-7000-8000-00000000000b";

    fn vault(id: &str) -> VaultId {
        VaultId::parse(id).expect("test VaultId parses")
    }

    /// Scripted in-memory stand-in for the Keychain: an account → secret map
    /// plus a call log, so a test can assert WHICH account each operation
    /// addressed. The biometric gate is not simulated (see [`KeychainOps`]).
    struct FakeKeychain {
        items: RefCell<Vec<(String, Vec<u8>)>>,
        calls: RefCell<Vec<String>>,
        store_fails: bool,
    }

    impl FakeKeychain {
        fn empty() -> Self {
            Self {
                items: RefCell::new(Vec::new()),
                calls: RefCell::new(Vec::new()),
                store_fails: false,
            }
        }

        fn with_item(account: &str, secret: [u8; WRAP_KEY_LEN]) -> Self {
            let fake = Self::empty();
            fake.items
                .borrow_mut()
                .push((account.to_string(), secret.to_vec()));
            fake
        }

        fn read(&self, account: &str) -> Option<Vec<u8>> {
            self.items
                .borrow()
                .iter()
                .find(|(a, _)| a.as_str() == account)
                .map(|(_, s)| s.clone())
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl KeychainOps for FakeKeychain {
        fn get(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, ProviderError> {
            self.calls.borrow_mut().push(format!("get {account}"));
            self.read(account)
                .map(Zeroizing::new)
                .ok_or(ProviderError::CredentialMissing)
        }

        fn store(&self, account: &str, secret: &[u8]) -> Result<(), ProviderError> {
            self.calls.borrow_mut().push(format!("store {account}"));
            if self.store_fails {
                return Err(ProviderError::Backend);
            }
            let mut items = self.items.borrow_mut();
            items.retain(|(a, _)| a.as_str() != account);
            items.push((account.to_string(), secret.to_vec()));
            Ok(())
        }

        fn delete(&self, account: &str) {
            self.calls.borrow_mut().push(format!("delete {account}"));
            self.items
                .borrow_mut()
                .retain(|(a, _)| a.as_str() != account);
        }
    }

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
    fn account_key_is_lowercase_hex_hash_then_vault_id() {
        // The Keychain account component IS the item's identity, and the OS
        // matches it byte-for-byte: the encoding must stay stable or every
        // credential enrolled under it stops resolving.
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        assert_eq!(provider.account, format!("{HASH_HEX}:{VAULT_A}"));
    }

    #[test]
    fn legacy_account_key_is_the_bare_hex_hash() {
        // The migration's lookup key is the pre-vault-scoping encoding; it is
        // frozen for exactly as long as unmigrated credentials can exist.
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        assert_eq!(provider.legacy_account, HASH_HEX);
    }

    #[test]
    fn distinct_vaults_get_distinct_keychain_accounts() {
        // Twin vaults of ONE account — the KeepBoth-restore / join-an-account-
        // this-device-already-holds shape — are the case that made an
        // account-keyed item overwrite its sibling's live wrap key.
        let a = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        let b = AppleBiometricProvider::new(HASH, vault(VAULT_B));
        assert_ne!(a.account, b.account, "twin vaults of one account");

        // And distinct accounts still separate, vault ids held equal.
        let c = AppleBiometricProvider::new([0u8; 16], vault(VAULT_A));
        let d = AppleBiometricProvider::new([1u8; 16], vault(VAULT_A));
        assert_ne!(c.account, d.account, "distinct accounts");
    }

    #[test]
    fn create_writes_only_the_vault_scoped_account() {
        // Setup on one twin must not touch the item the other twin may still be
        // reading — including the legacy one.
        let fake = FakeKeychain::with_item(HASH_HEX, [0x11; WRAP_KEY_LEN]);
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));

        let secret = provider.create_with_ops(&fake).expect("create");

        assert_eq!(
            fake.read(&provider.account).as_deref(),
            Some(secret.wrap_key.as_slice())
        );
        assert_eq!(
            fake.read(HASH_HEX).as_deref(),
            Some(&[0x11; WRAP_KEY_LEN][..]),
            "the legacy item is left alone"
        );
    }

    #[test]
    fn retrieve_reads_the_vault_scoped_item_without_touching_the_legacy_one() {
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        let fake = FakeKeychain::with_item(&provider.account, [0x22; WRAP_KEY_LEN]);

        let wrap_key = provider.retrieve_with_ops(&fake).expect("retrieve");

        assert_eq!(wrap_key.as_slice(), &[0x22; WRAP_KEY_LEN]);
        assert_eq!(fake.calls(), vec![format!("get {}", provider.account)]);
    }

    #[test]
    fn retrieve_migrates_a_legacy_item_to_the_vault_scoped_account() {
        // The pre-vault-scoping install: one Touch ID unlock re-homes the item.
        let fake = FakeKeychain::with_item(HASH_HEX, [0x33; WRAP_KEY_LEN]);
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));

        let wrap_key = provider.retrieve_with_ops(&fake).expect("retrieve");

        assert_eq!(wrap_key.as_slice(), &[0x33; WRAP_KEY_LEN]);
        assert_eq!(
            fake.read(&provider.account).as_deref(),
            Some(&[0x33; WRAP_KEY_LEN][..]),
            "same wrap key, vault-scoped account"
        );
        assert!(fake.read(HASH_HEX).is_none(), "legacy item removed");
    }

    #[test]
    fn retrieve_keeps_the_legacy_item_when_the_migration_store_fails() {
        // Deleting the legacy item before its replacement exists would destroy
        // the credential the user just authenticated for.
        let mut fake = FakeKeychain::with_item(HASH_HEX, [0x44; WRAP_KEY_LEN]);
        fake.store_fails = true;
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));

        let wrap_key = provider.retrieve_with_ops(&fake).expect("retrieve");

        assert_eq!(wrap_key.as_slice(), &[0x44; WRAP_KEY_LEN]);
        assert_eq!(
            fake.read(HASH_HEX).as_deref(),
            Some(&[0x44; WRAP_KEY_LEN][..]),
            "legacy item survives a failed re-store"
        );
    }

    #[test]
    fn retrieve_reports_credential_missing_when_neither_item_exists() {
        let fake = FakeKeychain::empty();
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));

        assert_eq!(
            provider.retrieve_with_ops(&fake),
            Err(ProviderError::CredentialMissing)
        );
        assert_eq!(
            fake.calls(),
            vec![
                format!("get {}", provider.account),
                format!("get {HASH_HEX}"),
            ]
        );
    }

    #[test]
    fn retrieve_rejects_a_wrong_length_item_without_minting_a_wrap_key() {
        // The corrupt / foreign-item arm. It rejects before any fixed-size copy
        // exists, which is exactly why the keychain `Vec` has to be `Zeroizing`
        // at the seam (`KeychainOps::get`) rather than at the copy: this path
        // never reaches the copy, and the bytes it read are still a wrap key.
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        let fake = FakeKeychain::empty();
        fake.items
            .borrow_mut()
            .push((provider.account.clone(), vec![0x77; WRAP_KEY_LEN - 1]));

        assert_eq!(
            provider.retrieve_with_ops(&fake),
            Err(ProviderError::CredentialMissing)
        );
        // And it did NOT fall through to the legacy lookup — a short item is a
        // corrupt one, not an absent one.
        assert_eq!(fake.calls(), vec![format!("get {}", provider.account)]);
    }

    #[test]
    fn delete_never_touches_the_legacy_item() {
        // On a twin install the legacy item may be the SIBLING's live
        // credential; disable / password-change / wipe must not reach it.
        let provider = AppleBiometricProvider::new(HASH, vault(VAULT_A));
        let fake = FakeKeychain::with_item(HASH_HEX, [0x55; WRAP_KEY_LEN]);
        fake.items
            .borrow_mut()
            .push((provider.account.clone(), vec![0x66; WRAP_KEY_LEN]));

        assert_eq!(provider.delete_with_ops(&fake), Ok(()));

        assert!(fake.read(&provider.account).is_none());
        assert_eq!(
            fake.read(HASH_HEX).as_deref(),
            Some(&[0x55; WRAP_KEY_LEN][..]),
            "the sibling's item is untouched"
        );
    }
}
