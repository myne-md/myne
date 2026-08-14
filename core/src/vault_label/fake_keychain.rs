// SPDX-License-Identifier: AGPL-3.0
//! In-memory stand-in for the OS keychain, for this module's own tests.
//!
//! It exists because the property worth asserting here is **which account each
//! operation addressed** (that routing is the per-vault erase guarantee), and
//! that has to be assertable on a machine with no keychain at all, which is what
//! CI runs on. Same shape and same reason as `quick_unlock::apple`'s
//! `FakeKeychain`; what it does NOT simulate is the OS access-control gate,
//! which is exactly the part `key.rs`'s header defers to a hardware checklist.
//!
//! `#[cfg(test)]` only: it is never compiled into a production build.

use crate::vault_label::error::VaultLabelError;
use crate::vault_label::key::LabelKeychain;
use std::sync::Mutex;
use zeroize::Zeroizing;

/// An account -> secret map plus a call log.
///
/// A `Mutex` rather than a `RefCell` because [`LabelKeychain`] is `Send + Sync`
/// (the production one is shared across the runtime) and the store's tests drive
/// it from an async body.
pub(crate) struct FakeKeychain {
    items: Mutex<Vec<(String, Vec<u8>)>>,
    calls: Mutex<Vec<String>>,
    store_fails: bool,
    unavailable: bool,
}

impl FakeKeychain {
    pub(crate) fn empty() -> Self {
        Self {
            items: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
            store_fails: false,
            unavailable: false,
        }
    }

    /// A keychain that accepts reads but refuses to store, so a caller cannot
    /// end up holding a key the OS did not keep.
    pub(crate) fn failing_store() -> Self {
        Self {
            store_fails: true,
            ..Self::empty()
        }
    }

    /// A keychain that is not there at all (the Linux-with-no-secret-service
    /// shape), so a test can prove no path answers it by writing plaintext.
    pub(crate) fn unavailable() -> Self {
        Self {
            unavailable: true,
            ..Self::empty()
        }
    }

    pub(crate) fn read(&self, account: &str) -> Option<Vec<u8>> {
        self.items
            .lock()
            .expect("fake keychain lock")
            .iter()
            .find(|(a, _)| a.as_str() == account)
            .map(|(_, s)| s.clone())
    }

    pub(crate) fn accounts(&self) -> Vec<String> {
        self.items
            .lock()
            .expect("fake keychain lock")
            .iter()
            .map(|(a, _)| a.clone())
            .collect()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("fake keychain lock").clone()
    }

    pub(crate) fn put(&self, account: &str, secret: Vec<u8>) {
        let mut items = self.items.lock().expect("fake keychain lock");
        items.retain(|(a, _)| a.as_str() != account);
        items.push((account.to_string(), secret));
    }

    fn log(&self, entry: String) {
        self.calls.lock().expect("fake keychain lock").push(entry);
    }
}

impl LabelKeychain for FakeKeychain {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        self.log(format!("get {account}"));
        if self.unavailable {
            return Err(VaultLabelError::KeychainUnavailable);
        }
        Ok(self.read(account).map(Zeroizing::new))
    }

    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
        self.log(format!("store {account}"));
        if self.unavailable {
            return Err(VaultLabelError::KeychainUnavailable);
        }
        if self.store_fails {
            return Err(VaultLabelError::Backend);
        }
        self.put(account, secret.to_vec());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
        self.log(format!("delete {account}"));
        if self.unavailable {
            return Err(VaultLabelError::KeychainUnavailable);
        }
        self.items
            .lock()
            .expect("fake keychain lock")
            .retain(|(a, _)| a.as_str() != account);
        Ok(())
    }
}
