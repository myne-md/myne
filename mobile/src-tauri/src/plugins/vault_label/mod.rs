// SPDX-License-Identifier: AGPL-3.0
//! `vault_label` Tauri plugin (mobile shim): the hide-vault-names option
//! (myne-md/myne#411).
//!
//! Owns the same three commands the desktop plugin does: `hide_vault_names`
//! (read the device-local flag), `set_hide_vault_names` (write it, and the
//! write IS the erase when it is being turned on), and
//! `vault_label_keychain_status` (whether this device has a usable keychain at
//! all). The store they govern (`MYL1`, `protocol.md` § 9.22) lives in
//! `myne_core::vault_label`, so nothing about the format is redefined here.
//!
//! ## All three, not two
//!
//! The probe is the one that looks droppable and is the one mobile needs most.
//! `myne_core::vault_label::key::platform_keychain` has an Apple backend and
//! returns `UnavailableKeychain` everywhere else, so on **Android** the store
//! holds nothing today: every row falls back and the Privacy switch cannot
//! change that. Without the probe the row would sit there looking broken with
//! no explanation, on the one platform where that is the normal state rather
//! than an exotic one. Wiring the Android Keystore behind a provider seam (the
//! shape `share_import::device_key::AndroidShareDeviceKeyProvider` establishes,
//! which this crate already implements for `MYF1`) is a `myne-core` change and
//! is not part of this one. What must never happen meanwhile is the other
//! fallback, writing the name in plaintext, which would look identical on
//! screen while voiding the erase guarantee (`decisions.md` 2026-08-15).
//!
//! ## Capability ACL
//!
//! `vault-label:default` bundles `allow-hide-vault-names` +
//! `allow-set-hide-vault-names` + `allow-vault-label-keychain-status`,
//! main-window-only. All three are reachable **pre-unlock** and deliberately
//! so: the picker is the surface they govern and it runs before any vault is
//! open. None touches vault content, none takes or returns a label, and the
//! only value that crosses in either direction is a boolean.
//!
//! Four registration sites and only one of them fails loudly: this
//! `generate_handler!`, `build.rs`'s `InlinedPlugin` command list,
//! `permissions/vault-label/default.toml` (both the `[[permission]]` block and
//! the `[default]` roster that names it), and `capabilities/default.json`.
//! Missing any of the last three fails CLOSED at runtime on a device, which is
//! exactly where it is most expensive to discover. `tests/hide-vault-names.test.ts`
//! compares all four.

// The command bodies and their error enum live in `myne-core` (shared with the
// desktop client, the `graph_layout` / `themes` re-export precedent).
// Re-exported so `crate::plugins::vault_label::…` resolves like every other
// shared plugin; the `init()` wiring stays mobile-side.
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
