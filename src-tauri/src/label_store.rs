// SPDX-License-Identifier: AGPL-3.0-only
//! The host's half of the **label store** (`decisions/clients/0795`).
//!
//! `myne-core` owns the policy: which keys exist, when one is minted, what a refusal
//! means, when the fallback to the neutral label is silent. It reaches a platform store
//! through its own `cfg` arms for Apple and Linux. The two platforms it cannot reach that
//! way supply a store from the HOST, because each one's store lives behind something
//! `core` must not link:
//!
//! - Windows: DPAPI, which needs a PATH to seal a blob to (`label_keychain_dpapi.rs`).
//! - Android: the Keystore, which is behind a Kotlin plugin
//!   (`label_keychain_keystore.rs`).
//!
//! **This file exists on both hosts and they are twins, with exactly one arm
//! differing.** The two stores are per-platform by nature, so a file that carried either
//! one would be a twin pair answering one product question twice; naming each store in a
//! file of its own and dispatching from here keeps the shared half genuinely shared
//! (`scripts/check-twin-drift-ratchet.mjs` measures exactly that). The arm that differs is
//! the one naming a module its own crate contains: each host carries only the store it
//! can reach, so a `cfg` arm pointing at the other host's module does not resolve at all,
//! which is a compile error on a target this machine cannot build (myne-md/myne#938
//! review).

/// Install this host's label store as `core`'s provider, once, at startup.
///
/// A host with neither store installs nothing, and `core`'s own arms answer.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    platform::install(app)
}

mod platform {
    #[cfg(windows)]
    pub use crate::label_keychain_dpapi::install;

    /// macOS, iOS, Linux and the dev hosts: `core`'s own arms already answer, so there is
    /// nothing to install. The MOBILE twin carries a `#[cfg(target_os = "android")]` arm
    /// here instead; this crate has no Keystore module, so an arm naming one would not
    /// resolve.
    #[cfg(not(windows))]
    pub fn install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}
}
