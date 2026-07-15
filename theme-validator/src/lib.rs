//! `theme-validator` — the Myne custom-theme value-shape allowlist, extracted
//! from the desktop `themes` plugin (`myne_desktop_lib`) into a shared crate so
//! that BOTH the desktop client and the `myne-themes` marketplace CI run the
//! **exact same** validator — no reimplementation, no drift (MYND-508).
//!
//! A custom theme is a flat `.json` map of CSS custom-property names to values.
//! Because the production WebView CSP carries `style-src 'self' 'unsafe-inline'`,
//! a value that reaches the DOM **executes** — so [`value::validate_theme`] is a
//! **security-load-bearing control** (threat-model §149; grill 2026-06-16,
//! SYNC-2). The grammar is an **allowlist**, not a denylist: a value is accepted
//! only if it matches one of a small set of known-safe shapes.
//!
//! This crate holds ONLY the pure validation logic (parse + required-core +
//! value-shape allowlist) and its rich `{ kind, key?, line? }` error. The
//! platform-specific pieces — the `ThemeCommandError` IPC surface, the path-safety
//! name guard, the picker `ThemeInfo` wire shape, and the Tauri commands — stay in
//! the desktop plugin, which re-exports this crate's items.
//!
//! The extraction is **behaviour-preserving**: the accepted/rejected grammar and
//! the `REQUIRED_KEYS` set are byte-for-byte the pre-move logic (its unit tests
//! moved with it unchanged).

#![forbid(unsafe_code)]

pub mod error;
pub mod schema;
pub mod value;

pub use error::{ThemeError, ThemeErrorKind};
pub use schema::{parse_theme, ParsedTheme, REQUIRED_KEYS};
pub use value::{is_allowed_value, validate_theme};
