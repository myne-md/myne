// SPDX-License-Identifier: AGPL-3.0
//! `workspace` plugin IPC error enums (MYND-166).
//!
//! Two closed taxonomies — read + write — both DENY-list clean per
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline" (no path
//! strings, no key material, no kernel-error display). Mirrored on the TS
//! side at `src/types/workspace-error.ts`.
//!
//! `workspace_read` returns `Ok(None)` (→ default single empty pane) on
//! absent / AEAD-fail / unsupported-format / parse-fail per
//! `myne-agents/docs/spec/protocol.md` § 9.7.4 — those do NOT surface as errors. Only
//! a Slot precondition violation or an unrecoverable `vault.meta` IO/parse
//! failure becomes a read error. `workspace_write` surfaces real failures
//! so the frontend knows the descriptor did not commit.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Failure surface for [`super::commands::workspace_read`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum WorkspaceReadError {
    /// Vault not unlocked when the command ran (bug-canary: the editor
    /// only mounts behind the unlock gate).
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// Unrecoverable filesystem error reading `vault.meta` (needed for the
    /// `account_number_hash` AAD binding). The `vault.workspace` read itself
    /// never surfaces Io — absent/corrupt collapses to `None` (§ 9.7.4).
    #[error("failed to read vault.meta for account_number_hash")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// `vault.meta` read but failed to parse.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
}

/// Failure surface for [`super::commands::workspace_write`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum WorkspaceWriteError {
    /// Vault not unlocked when the write ran.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// Filesystem error reading `vault.meta` or writing `vault.workspace`.
    #[error("filesystem error during workspace write")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// `vault.meta` parse failure during account_number_hash extraction.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
    /// `protocol::encode_workspace_blob` returned an error (e.g. the
    /// descriptor exceeded the 1 MiB cap).
    #[error("workspace blob encode failed")]
    WorkspaceEncodeFailed,
}

/// The storage seam's closed error, straight through (phase3-web-client task 65).
///
/// Both reads go through [`crate::vault_io::VaultIo`] now, which already reduces
/// `std::io::Error` at its own boundary — so this is an identity wrap, not a
/// second reduction. The `From<std::io::Error>` impl below stays for the
/// host-only path resolution, which still yields a real `io::Error`.
impl From<IoFailureKind> for WorkspaceReadError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        WorkspaceReadError::Io { io_error_kind }
    }
}

impl From<IoFailureKind> for WorkspaceWriteError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        WorkspaceWriteError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for WorkspaceReadError {
    fn from(e: std::io::Error) -> Self {
        WorkspaceReadError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

impl From<std::io::Error> for WorkspaceWriteError {
    fn from(e: std::io::Error) -> Self {
        WorkspaceWriteError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}
