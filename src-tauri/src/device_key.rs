// SPDX-License-Identifier: AGPL-3.0
//! The host's half of the **device signing key** storage ladder
//! (`decisions/protocol/0733` decision 4; `identity-seat-portability` tasks 9
//! and 10).
//!
//! `myne-core` owns the ladder's policy: when a key is read, what a refusal
//! means, when the fallback to the person key is silent. It reaches a platform
//! store through its own `cfg` arms for Apple and Linux. The two platforms it
//! cannot reach that way supply a store from the HOST, because each one's store
//! lives behind something `core` must not link:
//!
//! - Windows: DPAPI, which needs a PATH to seal a blob to (`device_key_dpapi.rs`).
//! - Android: the Keystore, which is behind a Kotlin plugin
//!   (`device_key_keystore.rs`).
//!
//! **This file exists on both hosts and they are twins, with exactly one arm
//! differing.** The two stores are per-platform by nature, so a file that carried
//! either one would be a twin pair answering one product question twice; naming
//! each store in a file of its own and dispatching from here keeps the shared half
//! genuinely shared (`scripts/check-twin-drift-ratchet.mjs` measures exactly that).
//! The arm that differs is the one naming a module its own crate contains: each
//! host carries only the store it can reach, so a `cfg` arm pointing at the other
//! host's module does not resolve at all, which is
//! a compile error on a target this machine cannot build (myne-md/myne#938 review).
//!
//! Non-biometric on both, for the same reason as every other rung: a head is
//! authored on a background sync cycle, so a presence check would fail the cycle
//! or prompt at a moment the user did not choose. The device key unwraps no vault
//! content, so its worst compromise costs attribution.

/// Install this host's device-key store as `core`'s provider, once, at startup.
///
/// A host with neither store installs nothing, and `core`'s own arms answer.
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    platform::install(app)
}

mod platform {
    #[cfg(windows)]
    pub use crate::device_key_dpapi::install;

    /// macOS, iOS, Linux and the dev hosts: `core`'s own arms already answer, so
    /// there is nothing to install. The MOBILE twin carries a
    /// `#[cfg(target_os = "android")]` arm here instead; this crate has no Keystore
    /// module, so an arm naming one would not resolve.
    #[cfg(not(windows))]
    pub fn install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}
}
