// SPDX-License-Identifier: AGPL-3.0
//! `graph_layout` plugin IPC error enums.
//!
//! Two closed taxonomies — read + write — both DENY-list clean per
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline" (no path
//! strings, no key material, no kernel-error display). The TS side treats
//! both as opaque IPC rejections (the graph layout is a best-effort cache),
//! so there is no TS error-type mirror.
//!
//! `graph_layout_read` returns `Ok(None)` (→ frontend recomputes the layout)
//! on absent / AEAD-fail / unsupported-format / parse-fail per
//! `agent-tooling/docs/spec/protocol.md` § 9.19.4 — those do NOT surface as errors (a
//! rebuildable cache). Only a Slot precondition violation or an unrecoverable
//! `vault.meta` IO/parse failure becomes a read error. `graph_layout_write`
//! surfaces real failures so the frontend knows the layout did not persist.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Failure surface for [`super::commands::graph_layout_read`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum GraphLayoutReadError {
    /// Vault not unlocked when the command ran (bug-canary: the graph view
    /// only mounts behind the unlock gate).
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// Unrecoverable filesystem error reading `vault.meta` (needed for the
    /// `account_number_hash` AAD binding). The `vault.graph` read itself never
    /// surfaces Io — absent/corrupt collapses to `None` (§ 9.19.4).
    #[error("failed to read vault.meta for account_number_hash")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// `vault.meta` read but failed to parse.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
}

/// Failure surface for [`super::commands::graph_layout_write`].
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum GraphLayoutWriteError {
    /// Vault not unlocked when the write ran.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,
    /// Filesystem error reading `vault.meta` or writing `vault.graph`.
    #[error("filesystem error during graph-layout write")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// `vault.meta` parse failure during account_number_hash extraction.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
    /// `protocol::encode_graph_layout_blob` returned an error (e.g. the
    /// payload exceeded the 16 MiB cap).
    #[error("graph-layout blob encode failed")]
    GraphLayoutEncodeFailed,
}

/// The storage seam's closed error, straight through (phase3-web-client task 46).
///
/// Both reads go through [`crate::vault_io::VaultIo`] now, which already reduces
/// `std::io::Error` at its own boundary — so this is an identity wrap, not a
/// second reduction. The `From<std::io::Error>` impl below stays for the
/// host-only path resolution, which still yields a real `io::Error`.
impl From<IoFailureKind> for GraphLayoutReadError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        GraphLayoutReadError::Io { io_error_kind }
    }
}

impl From<IoFailureKind> for GraphLayoutWriteError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        GraphLayoutWriteError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for GraphLayoutReadError {
    fn from(e: std::io::Error) -> Self {
        GraphLayoutReadError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

impl From<std::io::Error> for GraphLayoutWriteError {
    fn from(e: std::io::Error) -> Self {
        GraphLayoutWriteError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}
