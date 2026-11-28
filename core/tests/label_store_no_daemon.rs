// SPDX-License-Identifier: AGPL-3.0-only
//! The Linux label store where there is no Secret Service to reach.
//!
//! Its own integration binary because it points `DBUS_SESSION_BUS_ADDRESS` at a socket
//! that does not exist, and an environment variable is process-wide: doing that inside a
//! shared test binary would move the bus out from under a case that needs one.
//!
//! What it pins is the refusal, not a fallback. A device with no daemon must answer
//! `KeychainUnavailable`, the state the Privacy row renders, and must never write the name
//! in the clear: a plaintext fallback would look identical on screen while voiding the
//! erase guarantee the whole family exists to deliver.
#![cfg(target_os = "linux")]

use myne_core::vault_label::{error::VaultLabelError, key::platform_keychain};

#[test]
fn every_operation_refuses_when_no_daemon_can_be_reached() {
    // An address that cannot answer. `unix:path=` with a path nothing listens on makes
    // the connect itself fail, which is the "no keyring here" shape rather than a locked
    // collection (that one is covered in the live suite).
    std::env::set_var(
        "DBUS_SESSION_BUS_ADDRESS",
        "unix:path=/nonexistent/myne-label-store-test-bus",
    );

    let store = platform_keychain();
    assert_eq!(
        store.store("ci-probe-label-store", b"must-not-land"),
        Err(VaultLabelError::KeychainUnavailable),
        "a device with no daemon must refuse rather than store"
    );
    assert_eq!(
        store.get("ci-probe-label-store"),
        Err(VaultLabelError::KeychainUnavailable),
        "a device with no daemon must refuse rather than answer absent"
    );
    assert!(
        !platform_keychain_probe(),
        "the availability probe must report the facility as missing"
    );
}

/// The probe the Privacy row asks, over the same store.
fn platform_keychain_probe() -> bool {
    myne_core::vault_label::key::keychain_available(platform_keychain())
}
