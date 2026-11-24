// SPDX-License-Identifier: AGPL-3.0-only
//! Error type for the sealed label store (`MYL1`, `protocol.md` § 9.22).
//!
//! Closed, `serde`-tagged set, following the `captures` / `share_import`
//! precedent. No `String` field reaches the frontend; OS and codec detail is
//! reduced to coarse variants per the secret-handling logging discipline
//! (`src-tauri/AGENTS.md`). In particular **no variant can carry the label**,
//! which is the user's own text and is treated as AS3-sensitive exactly as the
//! `vault.prefs` `label` field is.
//!
//! [`VaultLabelError::KeychainUnavailable`] is deliberately its own variant
//! rather than folded into [`VaultLabelError::Backend`]: "this device has no
//! usable keychain" is the one failure the user can be told something true
//! about, and collapsing it would leave the Privacy option looking as though it
//! silently does nothing.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type for every sealed-label-store operation.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum VaultLabelError {
    /// No usable OS keychain on this device: none is wired for this platform,
    /// or the secret service is not running. The store then does nothing at
    /// all. **It never falls back to writing the name in plaintext**, because that
    /// would look identical on screen while voiding the cryptographic-erase
    /// guarantee the whole family exists to deliver.
    #[error("device keychain unavailable")]
    KeychainUnavailable,
    /// A sealed file exists for this vault but its key does not: the key was
    /// destroyed, or the vault directory was restored onto a device that never
    /// held it. The file can never be read again, so the caller deletes it and
    /// falls back to the neutral label.
    #[error("vault label key missing")]
    KeyMissing,
    /// A caller asked to store an empty label. Clearing a name removes the file
    /// (`remove_label`); it is never stored as an empty string, and refusing it
    /// here is what makes that structural rather than a rule to remember.
    #[error("vault label is empty")]
    EmptyLabel,
    /// The label is longer than the § 9.22.4 cap. Refused rather than
    /// truncated: a silently shortened name is a wrong name.
    #[error("vault label exceeds the size cap")]
    LabelTooLong,
    /// Filesystem failure (bounded kind; no path string leaked).
    #[error("vault label io failure")]
    Io(IoFailureKind),
    /// Opaque backend failure (keychain API, CSPRNG, or blob codec).
    #[error("vault label backend failure")]
    Backend,
}

impl From<IoFailureKind> for VaultLabelError {
    fn from(kind: IoFailureKind) -> Self {
        VaultLabelError::Io(kind)
    }
}

/// Closed-enum mapping from a store failure to a static log tag.
///
/// The one mapping, shared by every module that logs one of these, rather than a
/// `match` per call site: no variant of this enum can carry the label, and this
/// is what keeps it that way by construction instead of by each site remembering
/// not to format the error. Adding a variant compile-fails here, which is the
/// point (`src-tauri/AGENTS.md` "Closed-enum mapping rule").
pub fn vault_label_error_kind(e: &VaultLabelError) -> &'static str {
    match e {
        VaultLabelError::KeychainUnavailable => "keychain_unavailable",
        VaultLabelError::KeyMissing => "key_missing",
        VaultLabelError::EmptyLabel => "empty_label",
        VaultLabelError::LabelTooLong => "label_too_long",
        VaultLabelError::Io(_) => "io",
        VaultLabelError::Backend => "backend",
    }
}
