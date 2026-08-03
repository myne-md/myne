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

pub mod error;
pub mod schema;
pub mod value;

pub use error::{ThemeError, ThemeErrorKind};
pub use schema::{is_allowed_key, parse_theme, ParsedTheme, REQUIRED_KEYS};
pub use value::{is_allowed_value, validate_theme};
