// SPDX-License-Identifier: AGPL-3.0
//! `themes` plugin — shared core (MYND-486).
//!
//! Owns the vault-content custom-theme store: the encrypted `vault.themes`
//! blob (`protocol::themes_blob`, `MYT1`) holding a
//! `{theme_name → {palette, created_at, updated_at, deleted_at?}}` map — the
//! per-name wall clocks are what let the sync layer merge the store **per theme
//! name** (see [`commands::ThemeEntry`] and the `merge_custom_themes` primitive
//! in `plugins::sync::conflict`), so a concurrent add on two devices keeps both
//! themes and a delete leaves a tombstone rather than a resurrectable hole.
//! This is the **vault-content replacement** for the pre-MYND-486
//! device-local plaintext `themes` plugin (which lived in the desktop crate over
//! `app_config_dir/themes/<name>.json`, threat-model §158). Promoting the
//! palettes to vault content makes them encrypted, syncable, backed up, and
//! encrypted-at-rest.
//!
//! Mirrors the `spell`/`dictionary` split (the MYD1 twin): the **pure `*_in_dir`
//! cores** (`commands::*_in_dir`) take the derived KEK + account-hash directly
//! and own the crypto+IO round-trip (fully unit-tested); the thin `*_with_dir`
//! wrappers fetch `root_key`/hash from the unlocked `VaultRuntimeState` and
//! derive the KEK; the `#[tauri::command]` wrappers resolve the active vault dir
//! and are `Slot::Unlocked`-gated. Any failure on read collapses to the empty
//! theme store (fall-back-to-empty, § 9.21.4).
//!
//! ## The injection guard runs at both ends, and the second end is why
//!
//! Every **imported** palette is validated through the shared
//! [`theme_validator::validate_theme`] injection guard (the exact same
//! security-load-bearing allowlist the desktop client + the `myne-themes`
//! marketplace CI run — threat-model §149) BEFORE it is sealed into the blob,
//! and an off-grammar value is **rejected** there, with its key, so the author
//! learns what was wrong.
//!
//! That sentence used to be the whole story, and it was the wrong shape of
//! guarantee (myne#386): import is one of **three** writers to `vault.themes`.
//! The sync merge adopts a peer's entry verbatim — and its agreeing-store arm
//! writes the server's bytes unchanged — and a restored `.myne-backup` extracts
//! the blob byte-identically. Neither looks at a value. So every palette that
//! arrived on a second device had passed no grammar at all, on the device that
//! paints it.
//!
//! The read side therefore filters as well: `commands::vetted` applies the same
//! per-token allowlist wherever a palette **leaves** the store, which covers all
//! three writers and every future one with one check instead of one per
//! producer. Read **filters** rather than rejecting — on read there is no author
//! to tell, and one bad token from a peer must not blank the picker everywhere
//! else.
//!
//! Like `notes` / `prefs` / `vault_indices`, the `tauri::Builder` `init()`
//! wiring stays in each client crate (the desktop integration that swaps the old
//! device-local plugin for this one is the remaining follow-on).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

pub use error::ThemesError;
// Re-export the shared validator surface so command-layer + client consumers
// import `themes::validate_theme` / `ThemeError` without reaching into the
// external crate's file split.
pub use theme_validator::{validate_theme, ParsedTheme, ThemeError, ThemeErrorKind};
