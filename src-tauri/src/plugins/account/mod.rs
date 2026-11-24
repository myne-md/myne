// SPDX-License-Identifier: AGPL-3.0-only
//! `account` Tauri plugin: the account-record command surface (the account/vault
//! split, `decisions.md` 2026-09-07).
//!
//! Owns `account_list`: the device-local account record that groups vaults.
//! The record itself lives in `myne_core::account`.
//!
//! ## Capability ACL
//!
//! `account:default` bundles the one command, main-window-only. It is reachable
//! **pre-unlock** and deliberately so: the picker is the surface it serves and it
//! runs before any vault is open. Since myne-md/myne#937 the surface is
//! READ-ONLY: the two mutations it used to carry (`account_move`,
//! `account_split`) were the only code that could create a second account, and
//! multi-account support exists nowhere else in the product. None of this
//! touches vault content, and the only values that cross are hex account ids and
//! vault ids.

// The command bodies and their error enum live in `myne-core` (shared with the
// mobile client). Re-exported so `crate::plugins::account::…` resolves
// desktop-side like every other plugin. The `init()` wiring stays here.
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
