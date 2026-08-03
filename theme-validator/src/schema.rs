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
//! - [`is_allowed_key`] — the token-*name* allowlist, so "CSS custom-property
//!   names" above is enforced rather than merely described.
//! - [`parse_theme`] — parse the JSON map, enforce the key grammar, and enforce
//!   required-core presence.
//!
//! Value-shape validation (the injection-guard allowlist) is a SEPARATE pass
//! ([`super::value::validate_value`], task 2) wired into [`validate_theme`]
//! there; this module deliberately does NOT inspect value *contents* beyond
//! "is a JSON string", so the parse + required-key logic is testable in
//! isolation.

use std::collections::BTreeMap;

use crate::error::ThemeError;

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

/// `true` iff `key` is a well-formed theme token name: `--` followed by 1..=64
/// characters of ASCII `[A-Za-z0-9_-]`.
///
/// The key half of a theme file is exactly as untrusted as the value half, and
/// the same CSP argument covers it (`style-src 'unsafe-inline'`, threat-model
/// §149) — so it gets an **allowlist** too, on the same doctrine as
/// [`super::value::is_allowed_value`]. `;`, `{`, `}`, `:`, `/* */`, `\`
/// escapes, newlines and `url(` are rejected because they are off the charset,
/// never because they were enumerated, so obfuscation variants have nothing to
/// slip past.
///
/// The bound is deliberately narrower than CSS, which admits escapes and
/// non-ASCII in a custom-property ident: Myne's token vocabulary is ASCII
/// kebab-case (the longest token in the shared tree or in any published
/// `myne-themes` palette is 17 characters), so "narrow enough to admit every
/// real theme, nothing wider" costs nothing here. This is a choice, not an
/// oversight — widen it only against a theme that actually needs it.
pub fn is_allowed_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("--") else {
        return false;
    };
    (1..=64).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// Parse a theme file and enforce the key grammar plus required-core presence.
///
/// Returns a [`ParsedTheme`] when the bytes are a JSON object whose every key
/// satisfies [`is_allowed_key`], whose every value is a string, AND whose keys
/// include every [`REQUIRED_KEYS`] token. Does NOT validate value *shapes* —
/// that is task 2's allowlist guard.
///
/// Errors (rich, see [`ThemeError`]):
/// - [`ThemeError::parse`] — not valid JSON, or not an object of string values
///   (with the 1-based source line when locatable).
/// - [`ThemeError::invalid_value`] — the first key that is not a well-formed
///   token name, or the first non-string value; keyed by the offending token.
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
        // The key is untrusted input too, so it is vetted HERE — before the
        // required-core loop and before the value pass — and no consumer ever
        // sees a `ParsedTheme` holding a token name off the grammar.
        if !is_allowed_key(&k) {
            return Err(ThemeError::invalid_value(k));
        }
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
    use crate::error::ThemeErrorKind;

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

    #[test]
    fn accepts_every_valid_key_shape() {
        let longest = format!("--{}", "a".repeat(64));
        let ok = [
            "--paper",
            "--ink-1",
            "--syntax-keyword",
            "--label-red",
            "--highlight-yellow",
            "--a",            // shortest admissible token
            "--Accent_2-B",   // upper case, underscore, digit
            longest.as_str(), // exactly at the 64-char bound
        ];
        for k in ok {
            assert!(is_allowed_key(k), "should accept {k:?}");
        }
        // Every required-core token is, by construction, on the grammar.
        for k in REQUIRED_KEYS {
            assert!(is_allowed_key(k), "required key {k:?} must be admissible");
        }
    }

    #[test]
    fn rejects_every_injection_class_in_key_position() {
        // The value guard's `rejects_every_injection_class` table, mirrored in
        // key position, plus the three classes the value grammar has no
        // analogue for: no `--` prefix, bare `--`, and over-length.
        let over_long = format!("--{}", "a".repeat(65));
        let bad = [
            "paper",             // no `--` prefix
            "-paper",            // single dash
            "--",                // bare prefix, no token
            "--paper;color:red", // trailing-`;`-then-injection
            "--paper{}",         // brace escape
            "--paper:red",       // declaration colon
            "--/* */paper",      // comment escape
            "--paper/**/",       // comment escape
            "--paper\nink",      // newline trick
            "--\\75rl",          // CSS `\` escape
            "--url(evil.png)",   // functional value in key position
            "--paper 2",         // whitespace
            "--pâper",           // non-ASCII ident
            over_long.as_str(),  // past the 64-char bound
        ];
        for k in bad {
            assert!(!is_allowed_key(k), "should reject {k:?}");
        }
    }

    #[test]
    fn malformed_key_rejects_as_invalid_value_with_that_key() {
        // A complete, otherwise-valid theme carrying one extra malformed key.
        let mut s = minimal_core_json();
        s.pop(); // drop closing brace
        s.push_str(",\n  \"--paper;}\": \"#123456\"\n}");
        let err = parse_theme(&s).expect_err("a malformed token name must reject");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--paper;}"));
    }

    #[test]
    fn malformed_key_rejects_before_missing_required_key() {
        // Key shape is established in the same traversal as the string check,
        // ahead of the required-core loop: a theme that is BOTH malformed and
        // incomplete reports the key, not the absent core token.
        let err = parse_theme("{ \"color\": \"#123456\" }")
            .expect_err("a token name without the `--` prefix must reject");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("color"));
    }
}
