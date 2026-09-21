// SPDX-License-Identifier: AGPL-3.0
//! `export` plugin — shared core (MYND-211, epic export-suite).
//!
//! Owns the platform-agnostic whole-vault plaintext markdown-tree export:
//! `vault_export_markdown` decrypts the vault's live notes into an
//! Obsidian-shape folder tree at a user-chosen destination (folder hierarchy
//! from each note's FM `folder:`, filenames from FM `title:` + one `.md` with
//! tree-level `" (1)"` dedup, deliberate empty folders recreated from prefs,
//! referenced attachments decrypted once into `attachments/` with embeds
//! rewritten per the markdown-dialect §6 sanctioned export transform,
//! per-file mtimes from FM `updated:`), staging in a sibling directory and
//! publishing via one same-filesystem rename — the tree exists at the
//! destination only when complete.
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile,
//! mobile parity for export). Both `#[tauri::command]`s
//! (`vault_export_markdown` + `vault_export_cancel`) are `AppHandle<R>`-generic
//! — the only host coupling is the `export://progress` `Emitter` and the
//! app-managed [`commands::ExportRuntime`] cancel flag, both `Runtime`-generic —
//! so they live here and each client registers them via the
//! `myne_core::plugins::export` module path (a bare `pub use` of the
//! `#[tauri::command]` fns would drop their hidden `__cmd__` items). The pure
//! [`commands::vault_export_core`] is exposed for host-free testing.
//!
//! The `tauri::Builder` `init()` wiring (register the two commands + manage
//! `ExportRuntime`) stays in each client crate. The concurrency discipline
//! (capacity-1 auth permit + writer quiescence, the backup plugin's exact
//! shape) and the per-note machinery (decrypt, sanitize, suffix-dedup, embed
//! rewrite, mtime) are shared cross-plugin via `pub` helpers.
//!
//! TB3 egress: deliberate, user-initiated plaintext leaving the vault —
//! covered by the SYNC-4 spec package landed with MYND-115.
//!
//! Logging: see the desktop crate's `src-tauri/AGENTS.md` "Secret-handling
//! logging discipline" — counts-only events, no paths/titles/ids.

pub mod commands;
pub mod error;
