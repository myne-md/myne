// SPDX-License-Identifier: AGPL-3.0
//! Error type for the account record (the account/vault split,
//! `decisions.md` 2026-09-07).
//!
//! Closed, `serde`-tagged set, following the `vault_label` precedent. No
//! `String` field reaches the frontend; OS and codec detail is reduced to coarse
//! variants per the secret-handling logging discipline (`src-tauri/AGENTS.md`).
//! Since `docs/decisions/ui/0728` the record carries no user-authored text at
//! all, so there is nothing here a variant could leak beyond a vault id or the
//! account id an IPC read already returns.
//!
//! [`AccountError::KeychainUnavailable`] is deliberately its own variant rather
//! than folded into [`AccountError::Backend`]: "this device has no usable
//! keychain" is the one failure the user can be told something true about, and
//! collapsing it would leave the grouping looking as though it silently does
//! nothing.

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type for every account-record operation.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum AccountError {
    /// No usable OS keychain on this device. The store then holds no record and
    /// vaults keep working standalone. **It never falls back to writing the
    /// record in plaintext.**
    #[error("device keychain unavailable")]
    KeychainUnavailable,
    /// A record file exists but its key does not: the key was destroyed, or the
    /// record was restored onto a device that never held it. The record can
    /// never be read again, so the caller rebuilds it from the disk-scan.
    #[error("account record key missing")]
    KeyMissing,
    /// Filesystem failure (bounded kind; no path string leaked).
    #[error("account record io failure")]
    Io(IoFailureKind),
    /// The loaded record was rebuilt in memory because the on-disk source is
    /// undecryptable, so persisting would destroy bytes a restored key could
    /// still open. Mutations refuse with this rather than overwriting.
    #[error("account record unreadable, refusing to overwrite")]
    RecordUnreadable,
    /// Opaque backend failure (keychain API, CSPRNG, or blob codec).
    #[error("account record backend failure")]
    Backend,
    /// Account grouping is suppressed while hide-vault-names is on: the lock
    /// screen must not name accounts while claiming names are hidden.
    /// Mutations are rejected rather than applied invisibly.
    #[error("account actions unavailable while vault names are hidden")]
    Hidden,
}

impl From<IoFailureKind> for AccountError {
    fn from(kind: IoFailureKind) -> Self {
        AccountError::Io(kind)
    }
}

impl From<crate::vault_label::error::VaultLabelError> for AccountError {
    fn from(e: crate::vault_label::error::VaultLabelError) -> Self {
        match e {
            crate::vault_label::error::VaultLabelError::KeychainUnavailable => {
                AccountError::KeychainUnavailable
            }
            crate::vault_label::error::VaultLabelError::Io(kind) => AccountError::Io(kind),
            _ => AccountError::Backend,
        }
    }
}

/// Closed-enum mapping from a store failure to a static log tag.
pub fn account_error_kind(e: &AccountError) -> &'static str {
    match e {
        AccountError::KeychainUnavailable => "keychain_unavailable",
        AccountError::KeyMissing => "key_missing",
        AccountError::Io(_) => "io",
        AccountError::RecordUnreadable => "record_unreadable",
        AccountError::Backend => "backend",
        AccountError::Hidden => "hidden",
    }
}
