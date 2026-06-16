//! Theme schema: the required-core token set, the parsed-theme type, and the
//! JSON parse + required-key validation pass (custom-themes epic, MYND-111,
//! task 1).
//!
//! A custom theme file is a flat `.json` map of CSS custom-property names to
//! string values: `{ "--paper": "#fbfbfa", "--ink-1": "#1a1a17", … }`. A
//! *single flat palette* (grill 2026-06-16, SYNC-1) — overriding the **raw
//! ramp** is sufficient because the semantic aliases (`--bg-1: var(--paper)`,
//! …) re-resolve automatically off the raw tokens.
//!
//! This module owns:
//! - [`REQUIRED_KEYS`] — the minimal-core raw-ramp tokens a theme MUST define,
//!   exported as the single source of truth siblings (runtime list/extract,
//!   docs) read.
//! - [`parse_theme`] — parse the JSON map and enforce required-core presence.
//!
//! Value-shape validation (the injection-guard allowlist) is a SEPARATE pass
//! ([`super::value::validate_value`], task 2) wired into [`validate_theme`]
//! there; this module deliberately does NOT inspect value *contents* beyond
//! "is a JSON string", so the parse + required-key logic is testable in
//! isolation.

use std::collections::BTreeMap;

use super::error::ThemeError;

/// The minimal required-core CSS-variable tokens a custom theme MUST define
/// (grill 2026-06-16, SYNC-1: minimal core). These are the **raw ramp** tokens
/// from `docs/design/colors_and_type.css`; the semantic aliases resolve off
/// them automatically, so a theme that supplies these gets full coverage.
///
/// The optional `--syntax-*` / `--label-*` / `--highlight-*` token families are
/// intentionally NOT here: a theme may omit them (they then inherit the
/// built-in light values — a dark theme should set them, a caveat the docs
/// sub-feature (MYND-298) surfaces).
///
/// Order matters only for determinism of the "first missing key" report.
pub const REQUIRED_KEYS: &[&str] = &[
    // Neutral paper ramp (page / recessed / hover surfaces)
    "--paper",
    "--paper-2",
    "--paper-3",
    // Ink ramp (display / primary / secondary / tertiary text)
    "--ink-0",
    "--ink-1",
    "--ink-2",
    "--ink-3",
    // Hairline / border / disabled lines
    "--line-1",
    "--line-2",
    "--line-3",
    // Accent family
    "--accent",
    "--accent-hover",
    "--accent-press",
    "--accent-soft",
    "--accent-on",
    // State colors
    "--danger",
    "--danger-soft",
    "--warning",
    "--warning-soft",
    "--success",
    "--success-soft",
];

/// A parsed, structurally-valid theme: an ordered map of CSS-variable token
/// names to their (string) values. Ordering is `BTreeMap` so a downstream
/// re-serialization is deterministic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTheme {
    /// Token name → value. Includes the required core plus any optional tokens
    /// the author supplied.
    pub vars: BTreeMap<String, String>,
}

/// Parse a theme file and enforce required-core presence.
///
/// Returns a [`ParsedTheme`] when the bytes are a JSON object whose every value
/// is a string AND every [`REQUIRED_KEYS`] token is present. Does NOT validate
/// value *shapes* — that is task 2's allowlist guard.
///
/// Errors (rich, see [`ThemeError`]):
/// - [`ThemeError::parse`] — not valid JSON, or not an object of string values
///   (with the 1-based source line when locatable).
/// - [`ThemeError::missing_key`] — the first absent required-core token.
pub fn parse_theme(json: &str) -> Result<ParsedTheme, ThemeError> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| ThemeError::parse(line_of(&e)))?;

    let serde_json::Value::Object(map) = value else {
        return Err(ThemeError::parse(None));
    };

    // `value` is owned and dropped after this loop, so move each key + string
    // out of the map rather than cloning borrowed copies.
    let mut vars = BTreeMap::new();
    for (k, v) in map {
        // A non-string value is a structural problem; report it against the
        // token so the author can find it. (Value-shape allowlisting of the
        // string contents is task 2.)
        let serde_json::Value::String(s) = v else {
            return Err(ThemeError::invalid_value(k));
        };
        vars.insert(k, s);
    }

    for req in REQUIRED_KEYS {
        if !vars.contains_key(*req) {
            return Err(ThemeError::missing_key(*req));
        }
    }

    Ok(ParsedTheme { vars })
}

/// `serde_json` reports a 1-based line of `0` when it cannot locate the error;
/// normalize that to `None` so the UI doesn't show a bogus "line 0".
fn line_of(e: &serde_json::Error) -> Option<usize> {
    match e.line() {
        0 => None,
        n => Some(n),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::themes::error::ThemeErrorKind;

    /// A complete, well-formed minimal-core theme (every required key, valid
    /// hex values), as a JSON string.
    fn minimal_core_json() -> String {
        let mut s = String::from("{\n");
        for (i, key) in REQUIRED_KEYS.iter().enumerate() {
            let comma = if i + 1 < REQUIRED_KEYS.len() { "," } else { "" };
            s.push_str(&format!("  \"{key}\": \"#123456\"{comma}\n"));
        }
        s.push('}');
        s
    }

    #[test]
    fn accepts_minimal_core_theme() {
        let parsed = parse_theme(&minimal_core_json()).expect("minimal core is valid");
        assert_eq!(parsed.vars.len(), REQUIRED_KEYS.len());
        for key in REQUIRED_KEYS {
            assert_eq!(parsed.vars.get(*key).map(String::as_str), Some("#123456"));
        }
    }

    #[test]
    fn accepts_full_theme_with_optional_tokens() {
        // minimal core + optional syntax/label tokens
        let mut s = minimal_core_json();
        s.pop(); // drop closing brace
        s.push_str(",\n  \"--syntax-keyword\": \"#abcdef\",\n  \"--label-red\": \"#ff0000\"\n}");
        let parsed = parse_theme(&s).expect("core + optional is valid");
        assert!(parsed.vars.contains_key("--syntax-keyword"));
        assert!(parsed.vars.contains_key("--label-red"));
    }

    #[test]
    fn absent_optional_tokens_still_valid() {
        // minimal_core_json has NO optional tokens at all — must still pass.
        parse_theme(&minimal_core_json()).expect("optional tokens are not required");
    }

    #[test]
    fn each_missing_required_key_rejects_with_that_key() {
        // For every required key, build a theme missing exactly that one and
        // assert the error names it. Because parse_theme returns the FIRST
        // missing key in REQUIRED_KEYS order, dropping a single key yields it.
        for drop in REQUIRED_KEYS {
            let mut s = String::from("{\n");
            let kept: Vec<&&str> = REQUIRED_KEYS.iter().filter(|k| *k != drop).collect();
            for (i, key) in kept.iter().enumerate() {
                let comma = if i + 1 < kept.len() { "," } else { "" };
                s.push_str(&format!("  \"{key}\": \"#123456\"{comma}\n"));
            }
            s.push('}');
            let err = parse_theme(&s).expect_err("missing required key must reject");
            assert_eq!(err.kind, ThemeErrorKind::MissingKey);
            assert_eq!(err.key.as_deref(), Some(*drop));
        }
    }

    #[test]
    fn malformed_json_rejects_as_parse_error_with_line() {
        let bad = "{\n  \"--paper\": \"#fff\",\n  \"--ink-1\": \n}"; // value missing
        let err = parse_theme(bad).expect_err("malformed JSON must reject");
        assert_eq!(err.kind, ThemeErrorKind::ParseError);
        assert!(err.line.is_some(), "parse error should carry a line");
    }

    #[test]
    fn non_object_json_rejects_as_parse_error() {
        let err = parse_theme("[1, 2, 3]").expect_err("a JSON array is not a theme");
        assert_eq!(err.kind, ThemeErrorKind::ParseError);
    }

    #[test]
    fn non_string_value_rejects_as_invalid_value_with_key() {
        let bad = "{ \"--paper\": 42 }";
        let err = parse_theme(bad).expect_err("a numeric value is not a theme value");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--paper"));
    }
}
