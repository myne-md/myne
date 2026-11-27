// SPDX-License-Identifier: AGPL-3.0-only
//! The Linux arm of the label custodian: the Secret Service over the session bus.
//!
//! This is rung 2 of the storage ladder `decisions/protocol/0733` decision 4 fixed
//! for the device signing key, applied to the two device-local keys this module
//! keeps: one per vault (the sealed label store, `MYL1`, `protocol.md` §9.22) and one
//! for the account record. The crate, the feature flags and the blocking call style
//! are the device-key arm's, deliberately: one Secret Service client in the tree
//! rather than two that drift.
//!
//! **Item addressing is the account name**, under `md.myne.vaultlabel`. A vault's
//! key is addressed by its canonical `VaultId` rendering and the account record's by
//! the reserved `account-record` name, so the two cannot collide and a per-vault
//! delete can address exactly one item. That is the property the erase guarantee
//! rests on, and it is the reason the Apple arm accepts only an account name too.
//!
//! **A locked collection answers unavailable, and it never prompts.** Every call
//! here runs while a vault may be LOCKED: the picker draws before any unlock, a
//! background unlock re-caches the name, and the Privacy row asks whether storing is
//! possible at all. `Item::unlock` raises a user prompt, so it is never called. The
//! honest answer for a locked collection is a failure, and the caller falls back to
//! the neutral label for this launch rather than putting a dialog in front of a
//! locked screen.

use super::key::{LabelKeychain, KEYCHAIN_SERVICE};
use crate::secret_service_shared::{attributes, error_class};
use crate::vault_label::error::VaultLabelError;
use secret_service::blocking::SecretService;
use secret_service::EncryptionType;
use zeroize::Zeroizing;

/// The production Linux store. Every operation connects per call rather than
/// holding a session: the callers are short-lived, a cached proxy would go stale
/// when the daemon restarts, and the session bus round-trip is milliseconds.
pub struct SecretServiceKeychain;

impl LabelKeychain for SecretServiceKeychain {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        let ss = connect()?;
        let found = ss
            .search_items(attributes(KEYCHAIN_SERVICE, account))
            .map_err(|e| {
                log_backend_err("search", error_class(&e));
                VaultLabelError::Backend
            })?;

        let Some(item) = found.unlocked.first() else {
            if found.locked.is_empty() {
                // No item at all: this vault has never been unlocked here, or its
                // key was destroyed. The ordinary answer, not a fault.
                return Ok(None);
            }
            // The item exists and the collection is locked. No prompt, no unlock:
            // see the module header.
            tracing::warn!(
                stage = "vault_label_key",
                event = "label_key_locked",
                "the Secret Service holds this label key but its collection is locked; \
                 the picker falls back to the neutral label for this launch"
            );
            return Err(VaultLabelError::Backend);
        };

        let secret = item.get_secret().map_err(|e| {
            log_backend_err("get_secret", error_class(&e));
            VaultLabelError::Backend
        })?;
        Ok(Some(Zeroizing::new(secret)))
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        let result = store_inner(account, secret);
        log_key_op("store", if result.is_ok() { "ok" } else { "refused" });
        result
    }

    fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
        let result = delete_inner(account);
        log_key_op("delete", if result.is_ok() { "ok" } else { "refused" });
        result
    }
}

/// A DH session, so the key crosses the bus encrypted rather than in the clear.
fn connect<'a>() -> Result<SecretService<'a>, VaultLabelError> {
    SecretService::connect(EncryptionType::Dh).map_err(|e| {
        tracing::warn!(
            stage = "vault_label_key",
            op = "connect",
            reason = error_class(&e),
            "no Secret Service on this session bus; no label key can be stored or read \
             (the picker falls back to the neutral label)"
        );
        VaultLabelError::KeychainUnavailable
    })
}

fn store_inner(account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
    let ss = connect()?;
    let collection = ss.get_default_collection().map_err(|e| {
        log_backend_err("default_collection", error_class(&e));
        VaultLabelError::Backend
    })?;
    // A locked collection makes `create_item` raise a prompt: the crate executes the
    // prompt object the service returns when CreateItem answers "/". The picker calls
    // this while a vault may be LOCKED, so refuse instead. The caller keeps the
    // neutral label for this launch and the write is retried after an unlock.
    if collection.is_locked().map_err(|e| {
        log_backend_err("is_locked", error_class(&e));
        VaultLabelError::Backend
    })? {
        tracing::warn!(
            stage = "vault_label_key",
            op = "store",
            reason = "locked",
            "the default collection is locked; refusing to write the label key rather \
             than prompting in front of a locked screen"
        );
        return Err(VaultLabelError::Backend);
    }
    // `replace = true`: one key per account name, so a second write replaces the
    // item rather than creating a sibling that `search_items().unlocked.first()`
    // would have to pick between arbitrarily.
    collection
        .create_item(
            "Myne vault label key",
            attributes(KEYCHAIN_SERVICE, account),
            secret,
            true,
            "text/plain",
        )
        .map_err(|e| {
            log_backend_err("create_item", error_class(&e));
            VaultLabelError::Backend
        })?;
    Ok(())
}

fn delete_inner(account: &str) -> Result<(), VaultLabelError> {
    let ss = connect()?;
    let found = ss
        .search_items(attributes(KEYCHAIN_SERVICE, account))
        .map_err(|e| {
            log_backend_err("search", error_class(&e));
            VaultLabelError::Backend
        })?;
    // Locked items are deleted too: the point of the erase is that the key stops
    // existing, and a delete needs no unlock. An absent item is a successful
    // delete, which is the post-condition every caller cares about.
    let mut refused = false;
    for item in found.unlocked.iter().chain(found.locked.iter()) {
        if let Err(e) = item.delete() {
            log_backend_err("delete", error_class(&e));
            refused = true;
        }
    }
    if refused {
        return Err(VaultLabelError::Backend);
    }
    Ok(())
}

/// One line per mutation, with a closed token rather than an error's text.
fn log_key_op(op: &'static str, result: &'static str) {
    tracing::info!(
        stage = "vault_label_key",
        op,
        result,
        "vault-label Secret Service operation"
    );
}

fn log_backend_err(op: &'static str, reason: &'static str) {
    tracing::warn!(
        stage = "vault_label_key",
        op,
        reason,
        "vault-label Secret Service operation failed"
    );
}
