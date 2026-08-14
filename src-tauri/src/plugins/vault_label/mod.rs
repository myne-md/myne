//! `vault_label` Tauri plugin: the hide-vault-names option (myne-md/myne#411).
//!
//! Owns `hide_vault_names` + `set_hide_vault_names`: the device-local flag that
//! decides whether the LOCKED vault picker may show a vault's real name, and the
//! erase that turning it on performs. The store the flag governs (`MYL1`,
//! `protocol.md` § 9.22) lives in `myne_core::vault_label`.
//!
//! It also owns `vault_label_keychain_status`, which answers a different
//! question for the same row: whether this device has a usable keychain at all.
//! On one that does not, the option cannot store a name however it is set, and
//! the row says so instead of appearing inert. It reads one keychain item that
//! does not exist and reports whether the facility answered.
//!
//! ## Why its own plugin rather than a pair added to `vault-unlock`
//!
//! `sync`'s Tor toggle joined an existing plugin and its module doc says so; the
//! shape is legitimate and it is not the shape here. The `MYL1` store already
//! sits at the crate root of `myne-core` "because four flows consume it and none
//! of them owns it", and hanging its device-wide switch off `vault-unlock` would
//! give that plugin a permission about a screen it does not render. The ACL is
//! also the place a reviewer looks to ask "what may the WebView do", and a
//! `vault-label:` namespace answers that question directly where a fourteenth
//! `vault-unlock:allow-…` identifier would not.
//!
//! ## Capability ACL
//!
//! `vault-label:default` bundles `allow-hide-vault-names` +
//! `allow-set-hide-vault-names` + `allow-vault-label-keychain-status`,
//! main-window-only. All three are reachable **pre-unlock** and deliberately so:
//! the picker is the surface they govern and it runs before any vault is open.
//! None touches vault content, none takes or returns a label, and the only value
//! that crosses in either direction is a boolean.
//!
//! See: src-tauri/CLAUDE.md "Secret-handling logging discipline".

// The command bodies and their error enum live in `myne-core` (shared with the
// mobile client, whose ACL mirror is its own change). Re-exported so
// `crate::plugins::vault_label::…` resolves desktop-side like every other
// plugin. The `init()` wiring stays here.
#[allow(unused_imports)]
pub use myne_core::vault_label::{commands, erase_all, error, hide_flag, key, store};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault_label` plugin. Holds no state: the flag is a file and
/// the keychain is the OS's, so there is nothing to `manage`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-label")
        .invoke_handler(tauri::generate_handler![
            commands::hide_vault_names,
            commands::set_hide_vault_names,
            commands::vault_label_keychain_status,
        ])
        .build()
}
