// SPDX-License-Identifier: AGPL-3.0
//! The per-vault device-local secrets that live in the OS keychain, and the one
//! address they share.
//!
//! **The class rule** (normative: `design-notes/security/0709`). Every secret
//! scoped to ONE vault that this device keeps outside the vault directory is
//! either destroyed when that vault is erased, or is declared independent of the
//! vault's lifetime with the reason. Two members exist in the keychain today, and
//! they occupy the SAME item address rather than two:
//!
//! 1. the **owner quick-unlock biometric wrap key** (`MYQ1`'s third `root_key`
//!    copy; `super::apple`), and
//! 2. the **member-vault biometric wrap key** (the B2B member's device-local
//!    fast unlock, `plugins::sync::person_account`), which reuses the owner
//!    provider and therefore the owner's service and account shape.
//!
//! A vault is an owner vault or a member vault, so the two never coexist for one
//! `(account, vault id)`; one delete at
//! [`account_component`] removes whichever of them is there. The third per-vault
//! member of the class is the sealed-label wrap key (`crate::vault_label`, its
//! own `md.myne.vaultlabel` service), destroyed by the same teardown since
//! myne-md/myne#411.
//!
//! **Deliberately NOT in the class**, and each for the same structural reason:
//! `md.myne.captures` and `md.myne.shareimport` mint ONE device-wide account
//! (`device-wrap-key`) because a capture or a shared file is enqueued before
//! anybody knows which vault will drain it. Erasing one vault must not make
//! another vault's queued items permanently unreadable, so a vault delete must
//! never touch them. The account-label record (`crate::account::key`,
//! `md.myne.vaultlabel`'s reserved `account-record` account) is device-wide by
//! definition for the same reason: it names the co-membership ACROSS vaults, and
//! the hide-vault-names sweep is what erases it.
//!
//! **Platform status.** Apple (macOS / iOS) has a real backend here; every other
//! target reports [`SecretDeleteFailure::Unavailable`], which is the honest
//! answer rather than a failure: no keychain item was ever created there, so
//! there is nothing to erase. The delete copy says so instead of implying a
//! cleanup that cannot happen (`settings.deleteVault.keychainNote`).
//!
//! See: `design-notes/security/0709-per-vault-device-local-secrets-are-erased-with-the-vault.md`.

use crate::vault_id::VaultId;

/// Keychain service string for the quick-unlock wrap keys: the app-level
/// namespace (same shape as `md.myne.shareimport`); per-item identity lives in
/// the account component, not here. **Frozen**: the OS matches it byte-for-byte,
/// and it is UNCHANGED from the desktop-era value so existing macOS Touch ID
/// credentials keep resolving.
pub const KEYCHAIN_SERVICE: &str = "md.myne.quickunlock";

/// Separator between the account and vault halves of the Keychain account
/// component. `:` is outside the hex alphabet and outside a `VaultId`'s
/// canonical form, so the two halves can never be confused for one another.
const ACCOUNT_COMPONENT_SEPARATOR: char = ':';

/// Why a per-vault secret delete did not complete. A closed enum rather than an
/// OSStatus or a string, so the diagnostic log carries a bounded reason
/// (`src-tauri/AGENTS.md`, "Secret-handling logging discipline").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretDeleteFailure {
    /// No keychain on this target. Nothing was created there, so nothing is
    /// left behind; the UI copy states the same thing.
    Unavailable,
    /// The platform has the facility and the delete failed. This one is worth a
    /// log line: the item, if any, survived.
    Backend,
}

/// The delete half of the keychain a per-vault secret needs.
///
/// Deliberately narrower than `crate::vault_label::key::LabelKeychain`: the erase
/// path only destroys, and `Send + Sync` is what lets the shared command hold it
/// across the async teardown.
pub trait DeviceSecretKeychain: Send + Sync {
    /// Remove the item at `account`. An already-absent item is success: the
    /// post-condition the caller wants is "the secret is gone", and it is.
    fn delete(&self, account: &str) -> Result<(), SecretDeleteFailure>;
}

/// The Keychain account component for one vault:
/// `hex(account_number_hash) : vault_id`. **Frozen encoding**: the OS matches
/// it byte-for-byte, so reformatting it strands every enrolled credential.
///
/// Both halves are required, and that is not decoration. `account_number_hash`
/// names an ACCOUNT, and one device can hold two vault directories for one
/// account (a `CollisionIntent::KeepBoth` restore, or joining an account this
/// device already holds). Keying by the hash alone made those twins address one
/// item, so setting up biometric quick-unlock on one silently overwrote the
/// other's live wrap key.
pub fn account_component(account_number_hash: &[u8; 16], vault_id: VaultId) -> String {
    format!(
        "{}{ACCOUNT_COMPONENT_SEPARATOR}{vault_id}",
        protocol::hex::encode_lower(account_number_hash)
    )
}

/// The pre-vault-scoping account component (bare lowercase hex
/// `account_number_hash`). Read-side migration only, in
/// `super::apple::AppleBiometricProvider::retrieve`; frozen for exactly as long
/// as unmigrated credentials can exist. **Nothing destroys anything under this
/// name, and the read-side migration does not either**: it re-stores the key it
/// read under the vault-scoped name and leaves this item alone, because on a
/// twin install it may be the SIBLING's live credential. The item therefore
/// survives as a second copy of the same wrap key and is a declared residue of
/// the class rule (`design-notes/security/0709`).
pub fn legacy_account_component(account_number_hash: &[u8; 16]) -> String {
    protocol::hex::encode_lower(account_number_hash)
}

/// Destroy the per-vault quick-unlock / member-biometric wrap key for
/// `vault_id`.
///
/// The caller must have read `account_number_hash` from `vault.meta` BEFORE the
/// sweep: the account component is derived from it and the only at-rest copy
/// goes with the vault directory. On the Apple backend a delete is idempotent,
/// so an owner vault with a PIN credential (no keychain item) and a vault that
/// never enrolled either provider both answer `Ok(())`. Every other target
/// answers [`SecretDeleteFailure::Unavailable`] rather than `Ok`, because no
/// item was ever created there and the two answers are deliberately different
/// (`NoSystemKeychain`'s doc says why).
pub fn erase_for_vault(
    account_number_hash: &[u8; 16],
    vault_id: VaultId,
    keychain: &dyn DeviceSecretKeychain,
) -> Result<(), SecretDeleteFailure> {
    keychain.delete(&account_component(account_number_hash, vault_id))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use security_framework::passwords::delete_generic_password;

    /// `errSecItemNotFound`: the item is absent (never created / wiped). An
    /// already-absent item is the post-condition the caller wanted.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    /// The production [`DeviceSecretKeychain`]: the Apple Keychain itself.
    pub struct AppleKeychain;

    impl DeviceSecretKeychain for AppleKeychain {
        fn delete(&self, account: &str) -> Result<(), SecretDeleteFailure> {
            match delete_generic_password(KEYCHAIN_SERVICE, account) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(e) => {
                    // An OSStatus code is not key material; the account, the
                    // vault id and the hash never appear. This is the only
                    // diagnostic the hardware checklist has.
                    tracing::warn!(
                        stage = "device_secret_keychain",
                        op = "delete",
                        errsec_code = e.code(),
                        "per-vault device-local secret could not be removed"
                    );
                    // A failed erase must NOT report success: the whole point is
                    // a claim about what is left in the keychain.
                    Err(SecretDeleteFailure::Backend)
                }
            }
        }
    }
}

/// The keychain this platform actually has. Apple gets the real one; every other
/// target reports `Unavailable` because no per-vault item was ever created there
/// (see `core/AGENTS.md` "Every keychain-backed device-local secret in this crate
/// was Apple-only"). It is deliberately NOT a silent no-op `Ok`: the caller logs
/// `Backend` and ignores `Unavailable`, and collapsing the two would erase that
/// distinction.
pub struct NoSystemKeychain;

impl DeviceSecretKeychain for NoSystemKeychain {
    fn delete(&self, _account: &str) -> Result<(), SecretDeleteFailure> {
        Err(SecretDeleteFailure::Unavailable)
    }
}

/// The keychain this platform actually has, named for the service it
/// addresses so it cannot be confused with `vault_label::key`'s pair in the
/// one place that calls both (`vault_delete`).
pub fn quick_unlock_keychain() -> &'static dyn DeviceSecretKeychain {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        &imp::AppleKeychain
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        &NoSystemKeychain
    }
}

/// In-memory stand-in for the OS keychain, for the erase tests.
///
/// The property worth asserting is WHICH account the erase addressed and whether
/// a failure stays visible; both have to be assertable on a machine with no
/// keychain at all, which is what CI runs on. What it does NOT simulate is the
/// OS access-control gate, the part the module header defers to the manual
/// hardware row in `scripts/manual-test-roster.mjs`.
#[cfg(test)]
pub(crate) mod fake {
    use super::{DeviceSecretKeychain, SecretDeleteFailure};
    use std::sync::Mutex;

    #[derive(Default)]
    pub(crate) struct FakeDeviceSecretKeychain {
        items: Mutex<Vec<(String, Vec<u8>)>>,
        calls: Mutex<Vec<String>>,
        /// Accounts whose delete refuses. One account at a time rather than a
        /// global flag, because the property the scoping test proves is that a
        /// failure on ONE vault does not touch the other.
        fail_for: Mutex<Vec<String>>,
    }

    impl FakeDeviceSecretKeychain {
        pub(crate) fn empty() -> Self {
            Self::default()
        }

        pub(crate) fn put(&self, account: &str, secret: &[u8]) {
            let mut items = self.items.lock().expect("fake keychain lock");
            items.retain(|(a, _)| a.as_str() != account);
            items.push((account.to_string(), secret.to_vec()));
        }

        pub(crate) fn read(&self, account: &str) -> Option<Vec<u8>> {
            self.items
                .lock()
                .expect("fake keychain lock")
                .iter()
                .find(|(a, _)| a.as_str() == account)
                .map(|(_, s)| s.clone())
        }

        pub(crate) fn fail_delete_for(&self, account: &str) {
            self.fail_for
                .lock()
                .expect("fake keychain lock")
                .push(account.to_string());
        }

        pub(crate) fn calls(&self) -> Vec<String> {
            self.calls.lock().expect("fake keychain lock").clone()
        }
    }

    impl DeviceSecretKeychain for FakeDeviceSecretKeychain {
        fn delete(&self, account: &str) -> Result<(), SecretDeleteFailure> {
            self.calls
                .lock()
                .expect("fake keychain lock")
                .push(format!("delete {account}"));
            if self
                .fail_for
                .lock()
                .expect("fake keychain lock")
                .iter()
                .any(|a| a.as_str() == account)
            {
                return Err(SecretDeleteFailure::Backend);
            }
            self.items
                .lock()
                .expect("fake keychain lock")
                .retain(|(a, _)| a.as_str() != account);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_id::VaultId;

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

    #[test]
    fn the_service_string_is_the_quickunlock_one_and_distinct_from_its_neighbours() {
        // The frozen address the OS matches. A drift here strands every
        // credential already enrolled, and the vault delete would then destroy
        // an item nothing reads while leaving the live one behind.
        assert_eq!(KEYCHAIN_SERVICE, "md.myne.quickunlock");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.vaultlabel");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.captures");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.shareimport");
    }

    #[test]
    fn the_account_component_is_lowercase_hex_hash_then_vault_id() {
        assert_eq!(
            account_component(&HASH, vault(VAULT_A)),
            format!("{HASH_HEX}:{VAULT_A}")
        );
        assert_eq!(legacy_account_component(&HASH), HASH_HEX);
    }

    #[test]
    fn distinct_vaults_of_one_account_get_distinct_items() {
        // The KeepBoth-restore / join-an-account-this-device-already-holds
        // shape: one hash, two vault directories, and the earlier account-only
        // key made these twins overwrite each other's live wrap key.
        assert_ne!(
            account_component(&HASH, vault(VAULT_A)),
            account_component(&HASH, vault(VAULT_B))
        );
    }

    #[test]
    fn the_unavailable_platform_answers_unavailable_rather_than_success() {
        // `Ok` here would be a platform claiming an erase it never attempted.
        // The caller ignores `Unavailable` and logs `Backend`, and the two are
        // only distinguishable if this stays an error.
        assert_eq!(
            NoSystemKeychain.delete("any"),
            Err(SecretDeleteFailure::Unavailable)
        );
    }

    #[test]
    fn erase_removes_only_the_addressed_item() {
        use super::fake::FakeDeviceSecretKeychain;

        let fake = FakeDeviceSecretKeychain::empty();
        let a = account_component(&HASH, vault(VAULT_A));
        let b = account_component(&HASH, vault(VAULT_B));
        fake.put(&a, &[0x11; 32]);
        fake.put(&b, &[0x22; 32]);

        erase_for_vault(&HASH, vault(VAULT_A), &fake).expect("erase A");

        assert_eq!(
            fake.calls(),
            vec![format!("delete {a}")],
            "exactly one call, and it addressed A's item"
        );
        assert_eq!(fake.read(&a), None, "A's item is the erase");
        assert_eq!(fake.read(&b), Some(vec![0x22; 32]), "B is untouched");
    }

    #[test]
    fn a_failed_delete_is_reported_rather_than_swallowed() {
        use super::fake::FakeDeviceSecretKeychain;

        let fake = FakeDeviceSecretKeychain::empty();
        let a = account_component(&HASH, vault(VAULT_A));
        fake.put(&a, &[0x11; 32]);
        fake.fail_delete_for(&a);

        assert_eq!(
            erase_for_vault(&HASH, vault(VAULT_A), &fake),
            Err(SecretDeleteFailure::Backend),
            "the helper must not turn a surviving secret into a success"
        );
        assert!(fake.read(&a).is_some(), "and the item really did survive");
    }
}
