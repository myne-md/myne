// SPDX-License-Identifier: AGPL-3.0-only
//! The DPAPI entropy string of every device-local key family, in one list.
//!
//! Entropy is what keeps one family's sealed blob from opening in another even if the
//! file were moved between their directories, so the list IS the namespace. It lives in
//! one module, compiled on every host, for the reason the two families' stores do not:
//! both callers are Windows-only, and a rule stated twice inside code no lane here
//! compiles is a rule nothing checks. This module has no Windows types in it, so the
//! `assert_ne!` in its own test runs on a Linux host and CI.
//!
//! Adding a family means adding a line here and nothing else. Two families sharing a
//! string is the one edit this file exists to make impossible to land silently.
//!
//! On a host that is not Windows nothing reads these, and that is the point: they are
//! compiled and TESTED here precisely because their only readers are Windows modules.
#![cfg_attr(not(windows), allow(dead_code))]

/// The device signing key's store (`device_key_dpapi.rs`).
pub(crate) const DEVICE_KEY_ENTROPY: &[u8] = b"md.myne.devicekey v1";

/// The label store's one device-wide key and its per-vault keys
/// (`label_keychain_dpapi.rs`).
pub(crate) const LABEL_STORE_ENTROPY: &[u8] = b"md.myne.vaultlabel v1";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_family_seals_under_its_own_entropy() {
        assert_ne!(
            DEVICE_KEY_ENTROPY, LABEL_STORE_ENTROPY,
            "two families sharing entropy means one family's blob opens in the other"
        );
        for e in [DEVICE_KEY_ENTROPY, LABEL_STORE_ENTROPY] {
            assert!(!e.is_empty(), "empty entropy is no namespace at all");
        }
    }
}
