//! `themes` plugin: custom (user-authored) CSS-variable theme support
//! (custom-themes epic — MYND-111 / MYND-297 / MYND-112).
//!
//! A custom theme is a flat `.json` map of CSS custom-property names to values
//! that a user drops into `app_config_dir/themes/<name>.json`. Because the
//! production WebView CSP carries `style-src 'self' 'unsafe-inline'`, any value
//! that reaches the DOM executes — so this module's **validator is a
//! security-load-bearing control** (TB6), the primary gate between an untrusted
//! theme file and the WebView (threat-model §149; grill 2026-06-16, SYNC-2).
//!
//! Theme files are device-local **plaintext** app-config, NOT vault content —
//! they hold no note plaintext or key material (registry.json precedent,
//! `protocol.md`; SYNC-6). Consistent with "no plaintext mode", which governs
//! note content (AS1), not cosmetic config.
//!
//! ## Module layout
//!
//! The **pure validation core** — required-core token set, JSON parse, and the
//! value-shape allowlist injection guard — was extracted into the shared
//! [`theme_validator`] crate (MYND-508) so the desktop client and the
//! `myne-themes` marketplace CI run the *exact same* validator (no
//! reimplementation, no drift). This plugin re-exports that surface and keeps
//! the platform-specific pieces:
//!
//! - [`error`] — the `ThemeCommandError` IPC surface (wraps the crate's
//!   `ThemeError` plus `io_failure_kind` + the `InvalidName` path-guard case).
//! - [`name`] — `is_valid_theme_name` path-safety predicate.
//! - [`info`] — the picker `ThemeInfo` / `ThemePreview` wire shape.
//! - `commands` + plugin builder — Tauri command surface (MYND-297).
//!
//! The re-exported validator is pure (no Tauri, no CSP, no disk) and unit-tested
//! in the crate; the command layer (MYND-297) wraps it.

// The validator's public surface (incl. the `pub use` re-exports below) is
// consumed by the `custom-theme-runtime` command layer (MYND-297) and the picker
// UI's error surface (MYND-112), landed in later sub-features of this epic;
// exercised now by the unit tests here. Until those land, the surface is
// unreferenced — same "consumed later" justification for both allows.
#![allow(dead_code, unused_imports)]

pub mod commands;
pub mod error;
pub mod info;
pub mod name;

// Flat surface for the command layer (MYND-297) + picker error surface
// (MYND-112): callers import `themes::validate_theme` / `is_valid_theme_name` /
// `ThemeError` / `ThemeInfo` without reaching into the internal file split.
// The pure validation core is re-exported from the shared `theme-validator`
// crate (MYND-508) — the single source of truth shared with the myne-themes CI.
pub use error::ThemeCommandError;
pub use info::{ThemeInfo, ThemePreview};
pub use name::is_valid_theme_name;
pub use theme_validator::{
    parse_theme, validate_theme, ParsedTheme, ThemeError, ThemeErrorKind, REQUIRED_KEYS,
};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `themes` plugin (custom-themes epic, MYND-297).
///
/// Binds the custom-theme file commands (`list_custom_themes` /
/// `read_custom_theme` / `delete_custom_theme`) over `app_config_dir/themes/`.
/// Holds NO plugin-private state — theme files are device-local plaintext
/// app-config, read on demand. The plugin name in the ACL namespace is `themes`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("themes")
        .invoke_handler(tauri::generate_handler![
            commands::list_custom_themes,
            commands::read_custom_theme,
            commands::delete_custom_theme,
            commands::import_custom_theme,
            commands::ensure_themes_dir,
        ])
        .build()
}
