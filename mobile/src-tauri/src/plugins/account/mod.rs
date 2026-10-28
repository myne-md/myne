// SPDX-License-Identifier: AGPL-3.0
//! `account` Tauri plugin (mobile shim): the account-record command surface
//! (the account/vault split, myne-md/myne#684).
//!
//! Owns the same one command the desktop plugin does: `account_list`. The
//! record it reads lives in `myne_core::account`, so nothing about the format is
//! redefined here. It is read-only since myne-md/myne#937 (the move/split pair
//! is gone from both clients with the single-account grouping).
//!
//! ## iOS groups, Android shows standalone
//!
//! `myne_core::vault_label::key::platform_keychain` has an Apple backend and
//! returns `UnavailableKeychain` everywhere else, so on **Android** the record
//! holds nothing today: `account_list` answers an empty list and vaults show
//! standalone, never an error. Wiring the Android Keystore is a `myne-core`
//! change and is not part of this one. What must never happen meanwhile is the
//! other fallback, writing the record in plaintext.
//!
//! ## Capability ACL
//!
//! `account:default` bundles the one command, main-window-only. It is reachable
//! **pre-unlock** and deliberately so: the picker is the surface it serves and it
//! runs before any vault is open. None of this touches vault content, and the
//! only values that cross are hex account ids and vault ids.

// The command bodies and their error enum live in `myne-core` (shared with the
// desktop client). Re-exported so `crate::plugins::account::…` resolves like
// every other shared plugin; the `init()` wiring stays mobile-side.
#[allow(unused_imports)]
pub use myne_core::account::{commands, error, key, store};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `account` plugin. Holds no state: the record is a file and the
/// keychain is the OS's, so there is nothing to `manage`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("account")
        .invoke_handler(tauri::generate_handler![commands::account_list])
        .build()
}
