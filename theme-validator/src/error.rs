// SPDX-License-Identifier: AGPL-3.0-only
//! Rich, structured validation error for custom themes.
//!
//! Unlike the closed `kind`-only taxonomies elsewhere, the theme validator
//! carries an OPTIONAL `key` and `line` alongside the kind so the picker UI
//! (MYND-112) can tell the user *which* token / *which* source line is at fault
//! while they hand-author a `.json` theme file, and so the `myne-themes`
//! marketplace CI can report the exact reason a submission was rejected. Decided
//! in the `custom-theme-runtime` grill (2026-06-16, SYNC-4: rich error
//! `{ kind, key?, line? }`).
//!
//! Only the token name + 1-based source line are ever surfaced — never a value,
//! never a path, never a kernel error string (DENY-list clean per
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline"; theme files are
//! plaintext app-config, not vault/key material).
//!
//! The desktop plugin's `ThemeCommandError` (which wraps this type plus an
//! `io_failure_kind` and the `InvalidName` path-guard case) lives in the desktop
//! crate, NOT here — it depends on desktop-only IO machinery.

use serde::Serialize;

/// Closed taxonomy of theme-validation failure modes.
///
/// `ParseError` / `MissingKey` are produced by the parse + required-core pass
/// (`schema`). `InvalidValue` is produced by the value-shape allowlist guard
/// (`value`). `InvalidName` is produced by the desktop plugin's
/// `is_valid_theme_name` enforcement at the command boundary — kept in this one
/// enum so the picker has a single error surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ThemeErrorKind {
    /// The file is not well-formed JSON (or not a `{ "--token": "value" }`
    /// object of string values). `line` carries the 1-based source line when
    /// `serde_json` could locate it.
    ParseError,
    /// A required-core CSS-variable token is absent. `key` carries the missing
    /// token name (e.g. `--accent`).
    MissingKey,
    /// A token's value did not match the value-shape allowlist, or its *name*
    /// did not match the token-name allowlist (`schema::is_allowed_key`) — both
    /// are "this entry is not admissible", so they share one kind rather than
    /// widening the closed taxonomy. `key` carries the offending token name.
    InvalidValue,
    /// A theme name failed the desktop plugin's `is_valid_theme_name` (path
    /// traversal / separators / out-of-charset).
    InvalidName,
    /// A colour pair fell below its WCAG floor (`contrast::CONTRAST_RULES`), so
    /// the palette is unreadable rather than unsafe. `key` carries the
    /// foreground token, `against` the background, and `ratio` / `min` the
    /// measured and required values (myne#394).
    LowContrast,
    /// The theme carries a key in the ornament layer's private `--_` namespace
    /// (`--_o-ceiling` and friends). `key` carries it.
    ///
    /// Distinct from [`InvalidValue`] because the key is perfectly well-formed —
    /// the key grammar admits `_` — and the objection is ownership, not shape:
    /// those variables are the bounds Myne's own stylesheet clamps a theme by,
    /// so a theme that could write one could raise its own ceiling. Five
    /// consumers filter the prefix on read; this is the boundary that stops it
    /// entering the ecosystem at all (myne#394).
    ReservedKey,
}

/// A single theme-validation failure, rich enough for the picker UI (and the
/// marketplace CI) to point at the exact problem.
///
/// Serialization shape (omitting `None` fields):
///
/// | Case                       | JSON                                        |
/// |----------------------------|---------------------------------------------|
/// | malformed JSON at line 7   | `{"kind":"ParseError","line":7}`            |
/// | missing `--accent`         | `{"kind":"MissingKey","key":"--accent"}`    |
/// | bad value for `--paper`    | `{"kind":"InvalidValue","key":"--paper"}`   |
/// | unsafe name                | `{"kind":"InvalidName"}`                    |
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
    /// The background token a [`ThemeErrorKind::LowContrast`] failure measured
    /// `key` against. `None` for every other kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub against: Option<String>,
    /// The measured contrast ratio, formatted to two decimals. Carried as a
    /// string so this type keeps its `Eq` derive — `f64` is not `Eq`, and a
    /// ratio is a display value here rather than something to compare.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ratio: Option<String>,
    /// The floor the pair had to clear, formatted the way the rule states it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<String>,
}

impl Default for ThemeError {
    /// The all-absent shape every constructor starts from. Exists so adding a
    /// sixth field is one edit rather than one per constructor — the struct has
    /// public fields and `skip_serializing_if`, so nothing else would force them.
    fn default() -> Self {
        ThemeError {
            kind: ThemeErrorKind::ParseError,
            key: None,
            line: None,
            against: None,
            ratio: None,
            min: None,
        }
    }
}

impl ThemeError {
    /// A JSON parse / structural failure, optionally located to a source line.
    pub fn parse(line: Option<usize>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::ParseError,
            line,
            ..Default::default()
        }
    }

    /// A missing required-core token.
    pub fn missing_key(key: impl Into<String>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::MissingKey,
            key: Some(key.into()),
            ..Default::default()
        }
    }

    /// A token whose value was rejected by the allowlist guard.
    pub fn invalid_value(key: impl Into<String>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::InvalidValue,
            key: Some(key.into()),
            ..Default::default()
        }
    }

    /// A key in the ornament layer's reserved `--_` namespace.
    pub fn reserved_key(key: impl Into<String>) -> Self {
        ThemeError {
            kind: ThemeErrorKind::ReservedKey,
            key: Some(key.into()),
            ..Default::default()
        }
    }

    /// An unsafe theme name.
    pub fn invalid_name() -> Self {
        ThemeError {
            kind: ThemeErrorKind::InvalidName,
            ..Default::default()
        }
    }

    /// A colour pair below its WCAG floor. Carries both token names and both
    /// numbers, because "your theme is unreadable" without them is not a thing
    /// an author can act on.
    pub fn low_contrast(
        fg: impl Into<String>,
        bg: impl Into<String>,
        ratio: f64,
        min: f64,
    ) -> Self {
        ThemeError {
            kind: ThemeErrorKind::LowContrast,
            key: Some(fg.into()),
            line: None,
            against: Some(bg.into()),
            ratio: Some(format!("{ratio:.2}")),
            min: Some(format!("{min}")),
        }
    }
}
