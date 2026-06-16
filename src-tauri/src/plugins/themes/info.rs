//! `ThemeInfo` — the per-theme row the picker UI (MYND-112) renders from
//! `list_custom_themes` (custom-themes epic, MYND-297, task 2; SYNC-4).
//!
//! The runtime pre-extracts a small fixed **preview swatch tuple** from the
//! validated palette so the picker can draw a chiplet thumbnail WITHOUT parsing
//! the full theme. An invalid file still produces a row (`valid: false` + the
//! rich [`ThemeError`]) so it shows greyed in the list rather than silently
//! vanishing.

use serde::Serialize;

use super::error::ThemeError;
use super::schema::ParsedTheme;

/// A small, fixed set of representative swatch colors for the picker's chiplet
/// thumbnail. Every key is a member of [`super::schema::REQUIRED_KEYS`], so on a
/// valid theme all five are guaranteed present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemePreview {
    /// `--paper` — page background.
    pub background: String,
    /// `--paper-2` — recessed surface (sidebars, cards).
    pub surface: String,
    /// `--ink-1` — primary text.
    pub foreground: String,
    /// `--accent` — accent color.
    pub accent: String,
    /// `--line-1` — hairline border.
    pub line: String,
}

impl ThemePreview {
    /// Pull the five swatch tokens from a validated palette, **moving** them out
    /// of the (about-to-be-dropped) map rather than cloning. Each is a member of
    /// the required core, so the lookups never miss on a valid theme; the
    /// `unwrap_or_default` is a defensive fallback that cannot fire after
    /// [`super::value::validate_theme`].
    pub fn from_theme(mut theme: ParsedTheme) -> Self {
        let mut take = |k: &str| theme.vars.remove(k).unwrap_or_default();
        ThemePreview {
            background: take("--paper"),
            surface: take("--paper-2"),
            foreground: take("--ink-1"),
            accent: take("--accent"),
            line: take("--line-1"),
        }
    }
}

/// One row in the custom-theme list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThemeInfo {
    /// The theme's file-stem name (identifier; also what `read`/`delete` take).
    pub name: String,
    /// Human-facing label. v0.1 mirrors `name`; a future change may prettify it.
    pub display_name: String,
    /// The chiplet preview swatches — `Some` for a valid theme, `None` for an
    /// invalid file (the picker greys the row and shows the error instead).
    pub preview: Option<ThemePreview>,
    /// Whether the file passed validation.
    pub valid: bool,
    /// The rich validation error when `valid` is false; `None` otherwise.
    pub error: Option<ThemeError>,
}

impl ThemeInfo {
    /// Build a row from the validation result of a theme file: a valid palette
    /// yields a `preview`; a [`ThemeError`] yields a greyed row carrying the
    /// error. (`valid` / `error` stay distinct serialized fields — the picker's
    /// wire shape, mirrored in `src/lib/themes.ts` — rather than being derived
    /// from `preview`.)
    pub fn from_validation(name: String, result: Result<ParsedTheme, ThemeError>) -> Self {
        let (preview, valid, error) = match result {
            Ok(theme) => (Some(ThemePreview::from_theme(theme)), true, None),
            Err(e) => (None, false, Some(e)),
        };
        ThemeInfo {
            display_name: name.clone(),
            name,
            preview,
            valid,
            error,
        }
    }
}
