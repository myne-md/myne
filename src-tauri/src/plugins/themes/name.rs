//! Theme-name path-safety predicate (custom-themes epic, MYND-111, task 3).
//!
//! The runtime command layer (MYND-297) takes a theme `name` from the WebView
//! and joins it onto `app_config_dir/themes/` to `read`/`delete` a file. An
//! unconstrained name (`..`, `/etc/passwd`, `C:\…`) would escape the themes
//! directory — a TB6 path-traversal surface (grill 2026-06-16, SYNC-2). This
//! predicate is the single gate the command boundary calls BEFORE any path
//! join; a `false` result maps to [`super::error::ThemeError::invalid_name`].
//!
//! The accepted charset is deliberately tight: ASCII alphanumerics plus `-` and
//! `_`, length 1..=64. Notably `.` is rejected entirely — that alone kills `..`
//! traversal and dotfiles, and the runtime owns appending the `.json` extension
//! (the name here is the file *stem*, not a path or filename).

/// `true` iff `name` is a safe theme file-stem: 1..=64 chars, each an ASCII
/// alphanumeric or `-`/`_`. Rejects path separators, `..`, absolute paths,
/// control characters, dots, whitespace, non-ASCII, empty, and over-long names.
pub fn is_valid_theme_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_sane_stems() {
        for name in ["my-theme", "dark_blue", "Theme1", "a", "solarized-dark-2"] {
            assert!(is_valid_theme_name(name), "should accept {name:?}");
        }
    }

    #[test]
    fn rejects_traversal_and_separators() {
        for name in [
            "..",
            "../etc/passwd",
            "a/b",
            "a\\b",
            "/abs",
            "C:\\windows",
            ".hidden",
            "a.b", // dot rejected (kills extensions + dotfiles)
            "themes/..",
        ] {
            assert!(!is_valid_theme_name(name), "should reject {name:?}");
        }
    }

    #[test]
    fn rejects_empty_overlong_control_whitespace_nonascii() {
        assert!(!is_valid_theme_name(""), "empty rejected");
        assert!(!is_valid_theme_name(&"a".repeat(65)), "over-long rejected");
        assert!(!is_valid_theme_name("a b"), "space rejected");
        assert!(!is_valid_theme_name("a\tb"), "tab rejected");
        assert!(!is_valid_theme_name("a\0b"), "NUL rejected");
        assert!(!is_valid_theme_name("café"), "non-ascii rejected");
    }
}
