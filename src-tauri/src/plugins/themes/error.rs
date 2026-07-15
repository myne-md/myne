//! `ThemeCommandError` — the failure surface for the custom-theme IPC commands
//! (custom-themes epic, MYND-297).
//!
//! The rich token-level `ThemeError` / `ThemeErrorKind` it wraps now live in the
//! shared [`theme_validator`] crate (MYND-508); this file keeps only the
//! desktop-specific command error, which additionally carries an
//! `io_failure_kind` and the `InvalidName` path-guard case.
//!
//! DENY-list clean per `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline": theme files are plaintext app-config (no key material), and the
//! surfaced detail is a closed enum + (for `Invalid`) the token-level
//! [`ThemeError`] — never a path string or kernel error display.

use serde::Serialize;
use theme_validator::ThemeError;

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};

/// Failure surface for the `read_custom_theme` / `delete_custom_theme` /
/// `import_custom_theme` IPC commands (custom-themes epic, MYND-297).
///
/// Serialization shape (`tag = "kind", content = "detail"`):
///
/// | Variant                        | JSON                                                         |
/// |--------------------------------|--------------------------------------------------------------|
/// | `InvalidName`                  | `{"kind":"InvalidName"}`                                      |
/// | `NotFound`                     | `{"kind":"NotFound"}`                                         |
/// | `Io { io_error_kind }`         | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `Invalid { error }`            | `{"kind":"Invalid","detail":{"error":{"kind":"MissingKey",…}}}` |
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ThemeCommandError {
    /// The supplied theme name failed [`super::name::is_valid_theme_name`]
    /// (path traversal / separators / out-of-charset) — rejected before any
    /// path join (TB6 guard).
    InvalidName,
    /// No theme file with that name exists in the themes directory.
    NotFound,
    /// Filesystem error reading the themes directory or a theme file.
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The file exists and is readable but failed validation (`read` only —
    /// `delete` does not validate contents).
    Invalid {
        /// The rich token-level validation failure (from `theme_validator`).
        error: ThemeError,
    },
}

impl From<std::io::Error> for ThemeCommandError {
    fn from(e: std::io::Error) -> Self {
        ThemeCommandError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}
