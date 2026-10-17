// SPDX-License-Identifier: AGPL-3.0
//! Value-shape allowlist injection guard (custom-themes epic, MYND-111, task 2).
//!
//! Because the production WebView CSP carries `style-src 'self' 'unsafe-inline'`,
//! a custom-theme value that reaches the DOM **executes** — so this scanner is
//! the PRIMARY security control, not CSP (grill 2026-06-16, SYNC-2; threat-model
//! §149). It is an **allowlist**, not a denylist: a value is accepted only if it
//! matches one of a small set of known-safe grammars, and rejected otherwise.
//! The CSS escape hatches (`url()`, `expression()`, `@import`, `javascript:`,
//! comment-escape, CSS `\` escapes, trailing-`;`-then-injection, newline tricks)
//! fail because they do not match the allowlist — we never chase them
//! individually, so escape/obfuscation variants can't slip past a denylist gap.
//! This mirrors the project's own MYND-209 ultra-tight-allowlist doctrine.
//!
//! Hand-rolled scan — NO `regex` dependency (grill SYNC-2: do not promote
//! `regex` to a direct dep for a grammar this small).
//!
//! Accepted shapes:
//! - hex: `#` + 3/4/6/8 hex digits
//! - color functions: `rgb()` / `rgba()` / `hsl()` / `hsla()` whose body is only
//!   digits, `.`, `,`, `%`, `/`, and whitespace (no letters, no nesting, no `;`)
//! - bare keyword / named color: ASCII letters only, ≤ 24 chars (e.g. `red`,
//!   `transparent`, `currentColor`) — provably injection-safe with no
//!   parens/digits/punctuation, so unknown names merely fail to render
//! - `<number><unit>`: optional sign, digits with optional single `.`, optional
//!   unit (ASCII letters ≤ 4, or `%`) — e.g. `0`, `12px`, `0.5rem`, `100%`

use crate::error::ThemeError;
use crate::schema::{parse_theme, ParsedTheme};

/// Parse + key-shape + required-core validate (task 1) AND value-shape validate
/// (this task). The single entry point the command layer (MYND-297) calls to
/// turn an untrusted theme file into a known-safe [`ParsedTheme`].
///
/// Returns the first value-shape failure as [`ThemeError::invalid_value`] (keyed
/// by the offending token), after the parse + key-shape + required-key pass has
/// succeeded — so by the time this loop runs, every key is already on
/// [`super::schema::is_allowed_key`]'s grammar.
pub fn validate_theme(json: &str) -> Result<ParsedTheme, ThemeError> {
    let parsed = parse_theme(json)?;
    for (key, value) in &parsed.vars {
        if !is_allowed_value(value) {
            return Err(ThemeError::invalid_value(key.clone()));
        }
    }
    Ok(parsed)
}

/// `true` iff `value` matches one of the known-safe value grammars.
pub fn is_allowed_value(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    is_hex(v) || is_color_function(v) || is_bare_keyword(v) || is_number_unit(v)
}

/// `#` followed by exactly 3, 4, 6, or 8 hex digits.
fn is_hex(v: &str) -> bool {
    let Some(rest) = v.strip_prefix('#') else {
        return false;
    };
    matches!(rest.len(), 3 | 4 | 6 | 8) && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `rgb(...)` / `rgba(...)` / `hsl(...)` / `hsla(...)` whose argument list
/// contains only digits, `.`, `,`, `%`, `/`, and whitespace. No letters inside
/// (blocks nested `url()`/`var()`), no `;`, must close with a single trailing
/// `)`.
fn is_color_function(v: &str) -> bool {
    let Some(open) = v.find('(') else {
        return false;
    };
    let name = &v[..open];
    if !(name.eq_ignore_ascii_case("rgb")
        || name.eq_ignore_ascii_case("rgba")
        || name.eq_ignore_ascii_case("hsl")
        || name.eq_ignore_ascii_case("hsla"))
    {
        return false;
    }
    let Some(body) = v[open + 1..].strip_suffix(')') else {
        return false;
    };
    !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b',' | b'%' | b'/' | b' ' | b'\t'))
}

/// A bare keyword or CSS named color: ASCII letters only, length 1..=24. With no
/// parens/digits/punctuation/whitespace it cannot form a functional value,
/// `url()`, `javascript:` scheme, or comment escape — so it is injection-safe
/// even when it is not a recognized color (it then simply does not render).
fn is_bare_keyword(v: &str) -> bool {
    (1..=24).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphabetic())
}

/// `<number><unit?>`: optional leading sign, digits with at most one `.`,
/// optional unit (ASCII letters length 1..=4, or a single `%`).
fn is_number_unit(v: &str) -> bool {
    let v = v.strip_prefix(['+', '-']).unwrap_or(v);
    if v.is_empty() {
        return false;
    }

    // Split the numeric prefix from an optional unit suffix.
    let num_end = v
        .bytes()
        .position(|b| !(b.is_ascii_digit() || b == b'.'))
        .unwrap_or(v.len());
    let (num, unit) = v.split_at(num_end);

    // Numeric part: at least one digit, at most one '.'.
    if !num.bytes().any(|b| b.is_ascii_digit()) {
        return false;
    }
    if num.bytes().filter(|b| *b == b'.').count() > 1 {
        return false;
    }

    // Unit part: empty, a single '%', or 1..=4 ASCII letters.
    match unit {
        "" | "%" => true,
        u => (1..=4).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_alphabetic()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ThemeErrorKind;
    use crate::schema::REQUIRED_KEYS;

    #[test]
    fn accepts_every_valid_value_shape() {
        let ok = [
            "#fff",
            "#ffff",
            "#a1b2c3",
            "#a1b2c3d4", // hex 3/4/6/8
            "rgb(12, 34, 56)",
            "rgba(0,0,0,0.5)",
            "hsl(210, 50%, 40%)",
            "hsla(210 50% 40% / 0.5)",
            "red",
            "transparent",
            "currentColor",
            "0",
            "12px",
            "0.5rem",
            "100%",
            "-2em",
        ];
        for v in ok {
            assert!(is_allowed_value(v), "should accept {v:?}");
        }
    }

    #[test]
    fn rejects_every_injection_class() {
        let bad = [
            "url(evil.png)",
            "url('x')",
            "expression(alert(1))",
            "red; @import \"x\"",
            "javascript:alert(1)",
            "@import url(x)",
            "#fff;}",          // brace/semicolon escape
            "rgb(0,0,0);x",    // trailing injection after close
            "rgb(0,0,0",       // unclosed
            "rgb(0,0,url(x))", // nested function (letters in body)
            "\\75rl(x)",       // CSS escape for u
            "/* */red",        // comment escape
            "red/**/",         // comment escape
            "calc(1px + 2px)", // not on the allowlist
            "var(--x)",        // not on the allowlist
            "#ffggff",         // non-hex digits
            "#12345",          // wrong hex length
            "",                // empty
            "  ",              // whitespace only
        ];
        for v in bad {
            assert!(!is_allowed_value(v), "should reject {v:?}");
        }
    }

    fn minimal_core_with(value: &str) -> String {
        let mut s = String::from("{\n");
        for (i, key) in REQUIRED_KEYS.iter().enumerate() {
            let comma = if i + 1 < REQUIRED_KEYS.len() { "," } else { "" };
            s.push_str(&format!("  \"{key}\": \"{value}\"{comma}\n"));
        }
        s.push('}');
        s
    }

    #[test]
    fn validate_theme_accepts_all_valid_values() {
        validate_theme(&minimal_core_with("#101010")).expect("all-valid theme passes");
    }

    #[test]
    fn validate_theme_rejects_a_bad_value_with_its_key() {
        // Build a valid theme, then poison exactly one token with an injection.
        let mut s = minimal_core_with("#101010");
        s = s.replace(
            "\"--accent\": \"#101010\"",
            "\"--accent\": \"url(evil.png)\"",
        );
        let err = validate_theme(&s).expect_err("a poisoned value must reject");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--accent"));
    }

    #[test]
    fn validate_theme_rejects_a_bad_key_with_that_key() {
        // A safe value cannot launder an unsafe token name: the key grammar is
        // enforced on the way in, not inferred from the value beside it.
        let mut s = minimal_core_with("#101010");
        s.pop(); // drop closing brace
        s.push_str(",\n  \"--accent;}\": \"#101010\"\n}");
        let err = validate_theme(&s).expect_err("a malformed token name must reject");
        assert_eq!(err.kind, ThemeErrorKind::InvalidValue);
        assert_eq!(err.key.as_deref(), Some("--accent;}"));
    }

    #[test]
    fn validate_theme_still_enforces_required_keys() {
        // Missing a required key must surface the parse-pass error, not a value error.
        let err = validate_theme("{ \"--paper\": \"#fff\" }").expect_err("missing keys reject");
        assert_eq!(err.kind, ThemeErrorKind::MissingKey);
    }
}
