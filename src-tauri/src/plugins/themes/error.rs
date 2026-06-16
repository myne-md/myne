//! Rich, structured validation error for custom themes
//! (custom-themes epic, MYND-111 / sub-feature `custom-theme-validation`).
//!
//! Unlike the closed `kind`-only taxonomies elsewhere in `plugins/`, the
//! theme validator carries an OPTIONAL `key` and `line` alongside the kind so
//! the picker UI (MYND-112) can tell the user *which* token / *which* source
//! line is at fault while they hand-author a `.json` theme file. Decided in the
//! `custom-theme-runtime` grill (2026-06-16, SYNC-4: rich error `{ kind, key?, line? }`).
//!
//! DENY-list clean per `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline": a theme file is plaintext app-config (not vault/key material),
//! and only the token name + 1-based source line are surfaced — never a value,
//! never a path, never a kernel error string.

use serde::Serialize;

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};

/// Closed taxonomy of theme-validation failure modes.
///
/// `ParseError` / `MissingKey` are produced by the parse + required-core pass
/// (this sub-feature, task 1). `InvalidValue` is produced by the value-shape
/// allowlist guard (task 2). `InvalidName` is produced by
/// [`super::name::is_valid_theme_name`] enforcement at the command boundary
/// (task 3) — kept in this one enum so the picker has a single error surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ThemeErrorKind {
    /// The file is not well-formed JSON (or not a `{ "--token": "value" }`
    /// object of string values). `line` carries the 1-based source line when
    /// `serde_json` could locate it.
    ParseError,
    /// A required-core CSS-variable token is absent. `key` carries the missing
    /// token name (e.g. `--accent`).
    MissingKey,
    /// A token's value did not match the value-shape allowlist. `key` carries
    /// the offending token name. (Task 2.)
    InvalidValue,
    /// A theme name failed [`super::name::is_valid_theme_name`] (path
    /// traversal / separators / out-of-charset). (Task 3.)
    InvalidName,
}

/// A single theme-validation failure, rich enough for the picker UI to point
/// the user at the exact problem.
///
/// Serialization shape (omitting `None` fields):
///
/// | Case                       | JSON                                                    |
/// |----------------------------|---------------------------------------------------------|
/// | malformed JSON at line 7   | `{"kind":"ParseError","line":7}`                        |
/// | missing `--accent`         | `{"kind":"MissingKey","key":"--accent"}`                |
/// | bad value for `--paper`    | `{"kind":"InvalidValue","key":"--paper"}`               |
/// | unsafe name                | `{"kind":"InvalidName"}`                                |
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemeError {
    /// The failure mode.
    pub kind: ThemeErrorKind,
    /// The offending CSS-variable token, when the failure is token-scoped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The 1-based source line, when the failure is a locatable parse error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

impl ThemeError {
    /// A JSON parse / structural failure, optionally located to a source line.
    pub fn parse(line: Option<usize>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::ParseError,
            key: None,
            line,
        }
    }

    /// A missing required-core token.
    pub fn missing_key(key: impl Into<String>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::MissingKey,
            key: Some(key.into()),
            line: None,
        }
    }

    /// A token whose value was rejected by the allowlist guard (task 2).
    pub fn invalid_value(key: impl Into<String>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::InvalidValue,
            key: Some(key.into()),
            line: None,
        }
    }

    /// An unsafe theme name (task 3).
    pub fn invalid_name() -> Self {
        ThemeError {
            kind: ThemeErrorKind::InvalidName,
            key: None,
            line: None,
        }
    }
}

/// Failure surface for the `read_custom_theme` / `delete_custom_theme` IPC
/// commands (custom-themes epic, MYND-297, task 2).
///
/// DENY-list clean per `src-tauri/CLAUDE.md` "Secret-handling logging
/// discipline": theme files are plaintext app-config (no key material), and the
/// surfaced detail is a closed enum + (for `Invalid`) the token-level
/// [`ThemeError`] — never a path string or kernel error display.
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
        /// The rich token-level validation failure.
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
