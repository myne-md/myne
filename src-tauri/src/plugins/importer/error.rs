// SPDX-License-Identifier: AGPL-3.0-only
//! Error type for the `importer` read-seam plugin (MYND-53, SYNC-1).
//!
//! Secret-logging discipline: no path string and no `io::Error::Display` (which
//! may carry a path on some kernels) ever crosses the IPC boundary — I/O
//! failures are reduced to the closed [`IoFailureKind`] enum first. See
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline".

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;

/// Failure of an external-directory read-seam command. No `String`/path payload.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ImportReadError {
    /// The path is not absolute, escapes the user-picked import root, or is a
    /// symlink resolving outside it. The offending path is intentionally NOT
    /// included (it would leak filesystem structure across the boundary).
    PathRejected,
    /// An I/O failure, categorized — the raw `io::Error` (possibly path-bearing)
    /// is dropped at this boundary.
    Io { io_error_kind: IoFailureKind },
    /// `import_read_file` was pointed at bytes that are not valid UTF-8 (a
    /// non-text file). Myne note plaintext is UTF-8, so such a file is not
    /// importable as a note; the TS engine flags/skips it.
    NotUtf8,
}
