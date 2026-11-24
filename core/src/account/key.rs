// SPDX-License-Identifier: AGPL-3.0-only
//! Device-local wrap key for the account record (the account/vault split,
//! `decisions.md` 2026-09-07).
//!
//! A 32-byte symmetric key held in the OS keychain, used to seal the account
//! record so the account id, member vault ids and label never sit on disk in
//! the clear. It is the fourth device-local key in this crate and it is keyed
//! differently from the other three, deliberately.
//!
//! **One key per device, not per vault.** The account record is a single
//! device-local file (not one per vault), so there is exactly one keychain
//! item, under a fixed account string. This is the `captures` / `share_import`
//! shape (a single `device-wrap-key`), not the `vault_label` shape (one key per
//! `VaultId`), because the record groups vaults rather than belonging to one.
//!
//! **There is no `DeriveSubkey` role.** The record must be readable while every
//! vault is LOCKED (the picker groups before any unlock), so `root_key` does not
//! exist yet, and a derived subkey cannot be destroyed on its own.
//!
//! **No separate keychain service.** [`LabelKeychain`] takes only an account
//! name: the production `AppleKeychain` binds the service to
//! `md.myne.vaultlabel` internally, so this key lives at
//! (`md.myne.vaultlabel`, `"account-record"`), sharing the vault-label
//! service. That is safe by namespace partition, not by service: every other
//! occupant of that service is either a `VaultId` (the per-vault label keys)
//! or the availability probe's `"availability-probe"`, and `"account-record"`
//! parses as neither, so no vault-label operation can address this item and
//! this item can never be read as a wrap key. `KEYCHAIN_ACCOUNT` is therefore
//! a RESERVED name: nothing else in the service may mint it, and the test
//! below pins the partition rather than comparing string constants (a
//! constants-only test passes regardless of where the key lands, which is the
//! vacuous-fixture shape that hid this sharing in the first place,
//! myne-md/myne#684 review).
//!
//! ## Platform status
//!
//! Apple (macOS / iOS) has a real backend here. Every other target returns
//! [`AccountError::KeychainUnavailable`], which is a first-class state rather
//! than a failure: the store then holds no record, and vaults keep working
//! standalone with no grouping. What must never happen on those platforms is the
//! other fallback, writing the record in plaintext, because it would look
//! identical on screen while voiding the seal.

use crate::account::error::AccountError;
use crate::vault_label::key::LabelKeychain;
use zeroize::Zeroizing;

/// Length of the account-record wrap key (256-bit XChaCha20-Poly1305 key).
pub const ACCOUNT_WRAP_KEY_LEN: usize = 32;

/// The keychain account component for the single device-local record. A fixed
/// string, not a `VaultId`: the record is one per device, not one per vault.
///
/// RESERVED across the shared `md.myne.vaultlabel` service (see the module
/// header): the partition holds because no vault-label name can equal this
/// string, which the test below pins.
pub const KEYCHAIN_ACCOUNT: &str = "account-record";

/// Fetch the device-local wrap key, minting one on first use. The write path.
///
/// A stored item of the wrong length is corrupt or foreign; it is dropped and
/// re-minted, which loses nothing (the only thing it could have opened is an
/// account record that would then be rebuilt by the caller anyway).
pub fn get_or_create_key(
    keychain: &dyn LabelKeychain,
) -> Result<Zeroizing<[u8; ACCOUNT_WRAP_KEY_LEN]>, AccountError> {
    match keychain.get(KEYCHAIN_ACCOUNT)? {
        Some(bytes) if bytes.len() == ACCOUNT_WRAP_KEY_LEN => Ok(fixed_key(&bytes)),
        Some(_) => {
            keychain.delete(KEYCHAIN_ACCOUNT)?;
            mint(keychain)
        }
        None => mint(keychain),
    }
}

/// Fetch the device-local wrap key WITHOUT minting one. The read path.
///
/// Returns [`AccountError::KeyMissing`] when no key exists, which is what
/// separates "this device has never grouped vaults" from "the keychain is
/// broken": the first is normal and silent, the second is reportable.
pub fn existing_key(
    keychain: &dyn LabelKeychain,
) -> Result<Zeroizing<[u8; ACCOUNT_WRAP_KEY_LEN]>, AccountError> {
    match keychain.get(KEYCHAIN_ACCOUNT)? {
        Some(bytes) if bytes.len() == ACCOUNT_WRAP_KEY_LEN => Ok(fixed_key(&bytes)),
        Some(_) | None => Err(AccountError::KeyMissing),
    }
}

/// Mint a fresh 32-byte key and store it.
fn mint(
    keychain: &dyn LabelKeychain,
) -> Result<Zeroizing<[u8; ACCOUNT_WRAP_KEY_LEN]>, AccountError> {
    let mut key = Zeroizing::new([0u8; ACCOUNT_WRAP_KEY_LEN]);
    getrandom::getrandom(key.as_mut_slice()).map_err(|_| AccountError::Backend)?;
    keychain.store(KEYCHAIN_ACCOUNT, key.as_slice())?;
    Ok(key)
}

/// Narrow a keychain item's bytes to a fixed-size key. The caller has already
/// checked the length.
fn fixed_key(bytes: &[u8]) -> Zeroizing<[u8; ACCOUNT_WRAP_KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; ACCOUNT_WRAP_KEY_LEN]);
    key.copy_from_slice(bytes);
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_label::fake_keychain::FakeKeychain;

    #[test]
    fn the_record_name_is_reserved_in_the_shared_vaultlabel_service() {
        // The partition, not the constants: the key this module mints must be
        // unreachable from every vault-label name shape.
        assert_ne!(
            KEYCHAIN_ACCOUNT,
            crate::vault_label::key::KEYCHAIN_PROBE_ACCOUNT
        );
        assert!(crate::vault_id::VaultId::parse(KEYCHAIN_ACCOUNT).is_err());
        // And the mint really lands under that name: a constants-only
        // assertion would pass with the key stored anywhere.
        let fake = FakeKeychain::empty();
        get_or_create_key(&fake).expect("mint");
        assert_eq!(fake.accounts(), vec![KEYCHAIN_ACCOUNT.to_string()]);
    }

    #[test]
    fn a_second_call_returns_the_same_key_rather_than_re_minting() {
        let fake = FakeKeychain::empty();
        let first = get_or_create_key(&fake).expect("mint");
        let second = get_or_create_key(&fake).expect("fetch");
        assert_eq!(first.as_slice(), second.as_slice());
    }

    #[test]
    fn the_read_path_never_mints() {
        let fake = FakeKeychain::empty();
        assert_eq!(existing_key(&fake), Err(AccountError::KeyMissing));
        assert!(fake.accounts().is_empty());
    }

    #[test]
    fn a_wrong_length_item_is_re_minted_on_write_and_missing_on_read() {
        let fake = FakeKeychain::empty();
        fake.put(KEYCHAIN_ACCOUNT, vec![0x77; ACCOUNT_WRAP_KEY_LEN - 1]);
        assert_eq!(existing_key(&fake), Err(AccountError::KeyMissing));
        let key = get_or_create_key(&fake).expect("re-mint");
        assert_eq!(key.len(), ACCOUNT_WRAP_KEY_LEN);
    }

    #[test]
    fn an_unavailable_keychain_reports_itself() {
        let none = FakeKeychain::unavailable();
        assert_eq!(
            get_or_create_key(&none),
            Err(AccountError::KeychainUnavailable)
        );
        assert_eq!(existing_key(&none), Err(AccountError::KeychainUnavailable));
    }
}
