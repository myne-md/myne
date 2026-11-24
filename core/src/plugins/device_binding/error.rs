// SPDX-License-Identifier: AGPL-3.0-only

//! Failure modes of the device-binding store. Closed and typed, following the
//! `MemberNamesError` / `ThemesError` precedent: no `String` reaches the WebView,
//! and each arm is something a caller can act on rather than a message to print.

use thiserror::Error;

/// One closed enum for the store's whole surface. `serde::Serialize` in the repo's
/// tagged shape, because it crosses IPC as a command error.
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum DeviceBindingError {
    /// The family's file could not be consulted at all.
    #[error("the device-binding store could not be read")]
    Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind,
    },
    /// The file exists but NO copy decrypted. Deliberately not folded into the empty
    /// map: answering "no device has claimed itself" for a damaged store would let the
    /// next write persist that emptiness over every other device's row, and the dropped
    /// rows carry no tombstone, so no later merge could notice (`device_binding_blob.rs`
    /// states the shape this refuses).
    #[error("vault.device-bindings exists but no copy could be decrypted")]
    StoreUnreadable,
    /// The codec refused the map, or a signature could not be produced.
    #[error("the device-binding codec refused the map")]
    Codec,
    /// A merge would put one device under two DIFFERENT people at the SAME version.
    /// There is no arm left to separate the pair, so the merge refuses rather than
    /// choosing a side that would make the two peers disagree forever. A fresh claim at
    /// a strictly higher version is the repair.
    #[error("vault.device-bindings binds one device to two people at the same version")]
    ConflictingBinding,
    /// Nothing is unlocked, or no person identity is installed in the session, so
    /// there is no key to derive and nobody to sign as.
    #[error("the vault session is not unlocked")]
    SlotNotUnlocked,
    /// The active vault is not a shared (`NTV6`) one. This family is B2B-only: a
    /// pre-B2B vault has no `group_key`, so there is no key a member could read a
    /// member-writable binding map with, and no members to bind a device to.
    #[error("device bindings exist only in a shared (NTV6) vault")]
    NotASharedVault,
    /// The vault carries no enrolled device identity, so this device has no id to
    /// claim itself under. A never-synced vault has no device_id at all
    /// (`sync-state.json` is written at enrolment), and a binding is a sync-plane
    /// statement, so there is nothing honest to write yet.
    #[error("this device has no enrolled device id, so it cannot claim itself")]
    NoDeviceId,
}
