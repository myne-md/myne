//! `secret-export` plugin IPC error enum.
//!
//! Closed taxonomy — DENY-list clean (no path strings, no secret material, no
//! kernel-error display strings). See `src-tauri/CLAUDE.md` "Secret-handling
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
