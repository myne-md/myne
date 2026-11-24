// SPDX-License-Identifier: AGPL-3.0-only
//! `secret-export` plugin IPC error enum.
//!
//! Closed taxonomy — DENY-list clean (no path strings, no secret material, no
//! kernel-error display strings). See `src-tauri/AGENTS.md` "Secret-handling
//! logging discipline". Hand-mirrored on the TS side (`secret-export.ts` only
//! logs a static `fs-write-failed` kind, never the error payload).

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned by [`super::commands::save_secret_text`].
///
/// Serialization shape (`tag = "kind", content = "detail"`):
/// - `{"kind":"InvalidDestination"}` — no filename, a missing/non-dir parent, or
///   a destination that resolves inside the app-data / vault tree (rejected so a
///   compromised WebView cannot bypass the save dialog to overwrite vault files).
/// - `{"kind":"Io","detail":{"io_error_kind":"…"}}` — the write failed.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum SecretExportError {
    #[error("destination is invalid")]
    InvalidDestination,
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
}

impl SecretExportError {
    /// Bounded, content-free tag for structured logging (DENY-list safe), the same
    /// shape `ModelStoreError::kind` and `IoFailureKind` use.
    ///
    /// A `?error` Debug at the log site would carry a path the day a variant grows
    /// one, and nothing would notice: the diagnostic log is a file users are invited
    /// to publish. A closed tag makes that a compile error instead.
    pub fn kind(&self) -> &'static str {
        match self {
            SecretExportError::InvalidDestination => "invalid_destination",
            SecretExportError::Io { .. } => "io",
        }
    }
}
