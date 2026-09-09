//! `account` Tauri plugin: the account-record command surface (the account/vault
//! split, `decisions.md` 2026-09-07).
//!
//! Owns `account_list` + `account_rename` + `account_move` + `account_split`:
//! the device-local account record that groups vaults under a name. The record
//! itself lives in `myne_core::account`.
//!
//! ## Capability ACL
//!
//! `account:default` bundles the four commands, main-window-only. `list` is
//! reachable **pre-unlock** and deliberately so: the picker is the surface it
//! serves and it runs before any vault is open. The three mutations (rename,
//! move, split) are **refused while no vault is unlocked** (`Locked`): a
//! locked-screen observer reads labels and grouping but never regroups
//! without any vault password (myne-md/myne#684 land gate). None touches
//! vault content, and the only value that crosses in either direction is the
//! account label (the user's own text) plus vault ids.

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
        .invoke_handler(tauri::generate_handler![
            commands::account_list,
            commands::account_rename,
            commands::account_move,
            commands::account_split,
        ])
        .build()
}
