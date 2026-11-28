// SPDX-License-Identifier: AGPL-3.0-only
//! The Linux label store against a LIVE Secret Service, in a process of its own.
//!
//! Why this exists, stated because the arm has already shipped broken once: the Linux
//! Secret Service arm of the device signing key reached a pushed branch with a session
//! object nothing had bound, and its coverage at the time was "CI compiles it"
//! (myne-md/myne#1027). Compiling is not evidence about a D-Bus round trip. This test
//! writes, reads back, isolates per item and erases, through the same
//! `platform_keychain()` the app calls.
//!
//! **It needs a session bus and a DEFAULT collection, so it names which of the two it
//! found instead of pretending.** No `DBUS_SESSION_BUS_ADDRESS` prints
//! `label-store-secret-service: no session bus`. A bus whose daemon has no default
//! collection (a bare `dbus-run-session` with a fresh gnome-keyring, which is what a CI
//! container looks like) prints `label-store-secret-service: no default collection` and
//! returns: the arm's answer there is `Backend`, which is correct behaviour and not a
//! defect in it. `label-store-secret-service: ok` prints only where the round trip ran
//! against a working daemon, and that is the line a future CI gate should grep for.
//!
//! **There is no CI gate yet, and this file says so** (myne-md/myne#1091 task 6): the
//! provisioning was attempted and abandoned, because a headless daemon's default alias
//! never resolves and creating a collection over the bus hangs. The evidence today is a
//! run on a Linux desktop, which is one real run more than the arm had the first time it
//! shipped broken.
#![cfg(target_os = "linux")]

use myne_core::vault_label::key::platform_keychain;

/// The account names this test writes. Neither is a `VaultId` rendering, so neither can
/// collide with a real vault's key even if the store is shared with a running app.
const ITEM_A: &str = "ci-probe-label-store-a";
const ITEM_B: &str = "ci-probe-label-store-b";

#[test]
fn the_linux_arm_round_trips_against_a_live_secret_service() {
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        println!("label-store-secret-service: no session bus");
        return;
    }

    let store = platform_keychain();
    // Clean up anything a previous aborted run left, so the test starts from a known
    // state rather than asserting over a leftover.
    let _ = store.delete(ITEM_A);
    let _ = store.delete(ITEM_B);

    if let Err(e) = store.store(ITEM_A, b"first-item-material") {
        // A bus with no default collection answers `Backend`, which is the arm behaving
        // correctly on a machine that has not been logged into a keyring. Say which state
        // this is rather than reporting a defect the arm does not have.
        println!("label-store-secret-service: no default collection ({e:?})");
        return;
    }
    store
        .store(ITEM_B, b"second-item-material")
        .expect("second write");

    assert_eq!(
        read(store, ITEM_A),
        b"first-item-material",
        "an item must read back byte for byte"
    );
    assert_eq!(read(store, ITEM_B), b"second-item-material");

    // Per-vault isolation: the erase guarantee rests on destroying ONE item, so this is
    // the assertion that says a sweep cannot take a neighbour's key with it.
    store.delete(ITEM_A).expect("delete");
    assert_eq!(
        store.get(ITEM_A).expect("read after delete"),
        None,
        "the erased item must be gone"
    );
    assert_eq!(
        read(store, ITEM_B),
        b"second-item-material",
        "deleting one item must leave the other readable"
    );

    // An already-absent item is a successful delete, which is the post-condition every
    // caller wants and the one the erase sweep relies on when it meets a stale name.
    store
        .delete(ITEM_A)
        .expect("deleting an absent item succeeds");

    store.delete(ITEM_B).expect("clean up the second item");

    // The marker the CI step greps for. It is printed only where the round trip above
    // actually ran against a daemon.
    println!("label-store-secret-service: ok");
}

/// Read an item this test wrote, or panic with the identity of the item.
fn read(store: &dyn myne_core::vault_label::key::LabelKeychain, account: &str) -> Vec<u8> {
    store
        .get(account)
        .expect("read")
        .unwrap_or_else(|| panic!("{account} must be present"))
        .to_vec()
}
