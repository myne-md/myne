// SPDX-License-Identifier: AGPL-3.0-only
//! The host-store seam, proven in a process of its own.
//!
//! `myne-core` reaches a platform store it cannot compile against through
//! [`myne_core::vault_label::key::install_host_keychain`], and the install is a
//! process-wide `OnceLock`: the first call wins and a second is refused. That
//! makes it untestable in the crate's own unit-test module, where a single install
//! would answer for every test that ran afterwards. An integration test gets its
//! own process, so the install happens once and nothing else observes it.
//!
//! What these cases exist for: a host that installs its store and is silently
//! answered by the crate's built-in arm instead. The picker then shows `Vault N`
//! on a platform whose store works, and nothing anywhere says why.

use myne_core::vault_label::error::VaultLabelError;
use myne_core::vault_label::key::{install_host_keychain, platform_keychain, LabelKeychain};
use std::collections::HashMap;
use std::sync::Mutex;
use zeroize::Zeroizing;

/// One item store, in memory. Stands in for a platform store the way
/// `FakeKeychain` stands in inside the crate.
struct FakeStore {
    items: Mutex<HashMap<String, Vec<u8>>>,
}

impl FakeStore {
    fn with_item(account: &str, secret: &[u8]) -> Self {
        let mut items = HashMap::new();
        items.insert(account.to_string(), secret.to_vec());
        Self {
            items: Mutex::new(items),
        }
    }
}

impl LabelKeychain for FakeStore {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        Ok(self
            .items
            .lock()
            .expect("lock")
            .get(account)
            .map(|bytes| Zeroizing::new(bytes.clone())))
    }

    fn store(&self, _account: &str, _secret: &[u8]) -> Result<(), VaultLabelError> {
        unreachable!("this suite only reads")
    }

    fn delete(&self, _account: &str) -> Result<(), VaultLabelError> {
        unreachable!("this suite only reads")
    }
}

/// The install is once per process, so both cases share it and are ordered by
/// running in one test body.
#[test]
fn a_host_store_answers_and_a_second_install_is_refused() {
    install_host_keychain(Box::new(FakeStore::with_item("host-owned", b"first")));

    // The claim: the resolver answers the installed store, not this crate's arm.
    let answered = platform_keychain()
        .get("host-owned")
        .expect("the installed store answers")
        .expect("the seeded item is there");
    assert_eq!(
        answered.as_slice(),
        b"first",
        "the resolver must answer the install"
    );

    // A second install is refused, so the first store is still the one answering.
    // The failure this pins: a silent replacement would orphan every name the
    // first store had already sealed.
    install_host_keychain(Box::new(FakeStore::with_item("host-owned", b"second")));
    let still = platform_keychain()
        .get("host-owned")
        .expect("the first store still answers")
        .expect("the first store still holds the item");
    assert_eq!(
        still.as_slice(),
        b"first",
        "a second install must not replace the first"
    );
}
