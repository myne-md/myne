// SPDX-License-Identifier: AGPL-3.0-only

//! Failure modes of the member-names store. Closed and typed, following the
//! `ThemesError` precedent: no `String` reaches the WebView, and each arm is
//! something a caller can act on rather than a message to print.

use thiserror::Error;

/// One closed enum for the store's whole surface. `serde::Serialize` in the repo's
/// tagged shape, because it crosses IPC as a command error.
#[derive(Debug, Error, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum MemberNamesError {
    /// The family's file could not be consulted at all.
    #[error("the member-names store could not be read")]
    Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind,
    },
    /// The file exists but NO copy decrypted. Deliberately not folded into the empty
    /// map: answering "no names" for a damaged store would let the next write persist
    /// that emptiness over the real rows, which is the shape `themes` records.
    #[error("vault.member-names exists but no copy could be decrypted")]
    StoreUnreadable,
    /// A display name was empty. Clearing a name is a distinct operation, so this is a
    /// refusal rather than a silent clear.
    #[error("a display name may not be empty; clearing is a separate operation")]
    NameEmpty,
    /// A display name is over the family's cap.
    #[error("a display name is over the {max}-byte cap")]
    NameTooLong { max: usize },
    /// The codec refused the map, or a signature could not be produced.
    #[error("the member-names codec refused the map")]
    Codec,
    /// Nothing is unlocked, or no person identity is installed in the session, so
    /// there is no key to derive and nobody to sign as.
    #[error("the vault session is not unlocked")]
    SlotNotUnlocked,
    /// The active vault is not a shared (`NTV6`) one. This family is B2B-only: a
    /// pre-B2B vault has no `group_key`, so there is no key a member could read a
    /// member-writable name with, and no members to name.
    #[error("member names exist only in a shared (NTV6) vault")]
    NotASharedVault,
}
