// SPDX-License-Identifier: AGPL-3.0
//! `theme-validator` — the Myne custom-theme shape allowlist, extracted
//! from the desktop `themes` plugin (`myne_desktop_lib`) into a shared crate so
//! that BOTH the desktop client and the `myne-themes` marketplace CI run the
//! **exact same** validator — no reimplementation, no drift (MYND-508).
//!
//! A custom theme is a flat `.json` map of CSS custom-property names to values.
//! Because the production WebView CSP carries `style-src 'self' 'unsafe-inline'`,
//! a value that reaches the DOM **executes** — so [`value::validate_theme`] is a
//! **security-load-bearing control** (threat-model §149; grill 2026-06-16,
//! SYNC-2). The grammar is an **allowlist**, not a denylist, and it covers BOTH
//! halves of the map: a key is accepted only if it is a well-formed token name
//! ([`schema::is_allowed_key`]) and a value only if it matches one of a small
//! set of known-safe shapes ([`value::is_allowed_value`]). Consumers may treat a
//! [`ParsedTheme`] as vetted on both axes — nothing downstream re-examines it
//! before it is sealed into `vault.themes`.
//!
//! This crate holds ONLY the pure validation logic (parse + key-shape +
//! required-core + value-shape allowlist) and its rich `{ kind, key?, line? }`
//! error. The platform-specific pieces — the `ThemeCommandError` IPC surface,
//! the path-safety name guard, the picker `ThemeInfo` wire shape, and the Tauri
//! commands — stay in the desktop plugin, which re-exports this crate's items.
//!
//! The extraction was **behaviour-preserving**: the accepted/rejected value
//! grammar and the `REQUIRED_KEYS` set were byte-for-byte the pre-move logic
//! (its unit tests moved with it unchanged). The key grammar is the one later
//! addition — it closes the half of the map the extracted allowlist never
//! governed, and rejects nothing any shipped or published theme uses.

#![forbid(unsafe_code)]

pub mod contrast;
pub mod error;
pub mod ornament;
pub mod schema;
pub mod value;

pub use contrast::check_contrast;
pub use error::{ThemeError, ThemeErrorKind};
pub use ornament::{
    drop_unknown_ornament_values, is_known, refused_ornament_keys, KeyClass, Primitive,
};
pub use schema::{is_allowed_key, parse_theme, ParsedTheme, REQUIRED_KEYS};
pub use value::{is_allowed_value, validate_theme};

/// Everything a theme must clear to be **imported**: parse → key grammar →
/// required core → value allowlist → WCAG floors.
///
/// One named entry point rather than a two-call convention, because the
/// convention already failed once: the contrast gate was added to one of the two
/// import paths in `core`, every unit test stayed green, and only an E2E scenario
/// noticed the real command was unguarded (myne#394). A third site composed the
/// same pair again in `bin/validate.rs`. With this, "the marketplace and the
/// client run literally the same code" is structural rather than something each
/// call site re-performs.
///
/// Deliberately NOT folded into [`validate_theme`]: the read path must keep the
/// safety pass **without** the readability pass — a peer's palette failing a
/// contrast floor must not blank the theme picker — and the two names are what
/// say so.
pub fn validate_theme_for_import(json: &str) -> Result<ParsedTheme, ThemeError> {
    let parsed = validate_theme(json)?;
    // The ornament layer's private namespace, refused at the BOUNDARY.
    //
    // `--_o-ceiling` is the bound the tint wash is clamped by, and the key
    // grammar admits `_`, so nothing about the shape of `--_o-ceiling: 1`
    // objects to it. Five consumers filter the prefix when they read a palette —
    // and every one of them is a sink. Until this check, a marketplace
    // submission carrying the key passed CI, merged, and synced into vaults,
    // stopped only by those sinks. Defence in depth is the right posture; having
    // *only* depth is not (myne#394).
    if let Some(key) = parsed.vars.keys().find(|k| k.starts_with("--_")) {
        return Err(ThemeError::reserved_key(key));
    }
    contrast::check_contrast(&parsed.vars)?;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::REQUIRED_KEYS;

    /// A complete minimal core with honest ink/paper so the contrast gate passes
    /// — the same fixture shape `myne-core`'s tests use, and for the same reason.
    fn core_plus(extra: &[(&str, &str)]) -> String {
        let mut s = String::from("{\n");
        for key in REQUIRED_KEYS {
            let value = match *key {
                "--paper" | "--paper-2" | "--paper-3" => "#ffffff",
                "--ink-0" | "--ink-1" => "#1a1a17",
                "--ink-2" => "#5c5c50",
                "--accent" => "#8a5a2b",
                _ => "#123456",
            };
            s.push_str(&format!("  \"{key}\": \"{value}\",\n"));
        }
        for (i, (k, v)) in extra.iter().enumerate() {
            let comma = if i + 1 < extra.len() { "," } else { "" };
            s.push_str(&format!("  \"{k}\": \"{v}\"{comma}\n"));
        }
        if extra.is_empty() {
            s.truncate(s.trim_end().trim_end_matches(',').len());
            s.push('\n');
        }
        s.push('}');
        s
    }

    #[test]
    fn a_reserved_key_is_refused_at_the_boundary() {
        // `--_o-ceiling` is the bound the tint wash is clamped by. The key
        // grammar admits `_`, so nothing about its SHAPE objects — which is why
        // a submission carrying it used to pass CI, merge, and sync into vaults,
        // stopped only by the five read-side filters. This is the boundary.
        let err = validate_theme_for_import(&core_plus(&[("--_o-ceiling", "1")]))
            .expect_err("a reserved key must be refused");
        assert_eq!(err.kind, ThemeErrorKind::ReservedKey);
        assert_eq!(err.key.as_deref(), Some("--_o-ceiling"));
    }

    #[test]
    fn the_reserved_check_is_import_only() {
        // `validate_theme` is the READ path's gate and must stay non-rejecting:
        // a peer's palette carrying a stray key must still be listed and
        // deletable, and the read-side filter strips it. Only import refuses.
        assert!(validate_theme(&core_plus(&[("--_o-ceiling", "1")])).is_ok());
    }

    #[test]
    fn an_ordinary_theme_still_imports() {
        let parsed = validate_theme_for_import(&core_plus(&[("--box-frame", "thick")]))
            .expect("a well-formed theme must import");
        assert_eq!(
            parsed.vars.get("--box-frame").map(String::as_str),
            Some("thick")
        );
    }
}
