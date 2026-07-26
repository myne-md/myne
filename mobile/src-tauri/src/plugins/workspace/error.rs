//! `workspace` plugin IPC error enums (MYND-561, mobile).
//!
//! Two closed taxonomies — read + write — both DENY-list clean per the main
//! repo's `src-tauri/CLAUDE.md` "Secret-handling logging discipline" (no path
//! strings, no key material, no kernel-error display).
//!
//! Deliberately NOT mirrored by a `src/types/workspace-error.ts`: nothing on the
//! frontend discriminates these. A lost folder-expand set is cosmetic, so
//! `lib/workspace-persist.ts` swallows every rejection (a failed write just stays
//! dirty and retries at the next exit seam) and there is no branch for a typed
//! shape to feed. The taxonomy still earns its keep in the `tracing` logs.
//!
//! `workspace_read` returns `Ok(None)` (→ frontend default: nothing restored,
//! every folder starts collapsed) on absent / AEAD-fail / unsupported-format /
//! parse-fail per `docs/spec/protocol.md` § 9.7.4 — those do NOT surface as
//! errors. Only a Slot precondition violation or an unrecoverable `vault.meta`
//! IO/parse failure becomes a read error. `workspace_write` surfaces real
//! failures so the caller knows the descriptor did not commit.
//!
//! Deliberately the same shape as the desktop client's
//! `src-tauri/src/plugins/workspace/error.rs`: the two clients read and write
//! the SAME `vault.workspace` container, so their failure taxonomies should not
//! drift. See the module doc on `super::commands` for why the command bodies are
//! mobile-local rather than shared through `myne-core`.

use myne_core::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Failure surface for [`super::commands::workspace_read`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum WorkspaceReadError {
    /// Vault not unlocked when the command ran (bug-canary: the editor only
    /// mounts behind the unlock gate).
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
    /// `protocol::encode_workspace_blob` returned an error (e.g. the descriptor
    /// exceeded the codec's plaintext cap).
    #[error("workspace blob encode failed")]
    WorkspaceEncodeFailed,
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
