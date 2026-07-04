// SPDX-License-Identifier: AGPL-3.0
//! `secret-export` plugin — shared core.
//!
//! Owns the single `save_secret_text` IPC command — the narrow-seam file write
//! backing the recovery-kit / account-number `.txt` save affordance
//! (vault-creation PhraseStep / AccountStep). It exists so the main-window ACL
//! does NOT grant the WebView a broad `fs:allow-write-text-file $HOME/**` scope:
//! the WebView picks the destination via the dialog plugin, the Rust core does
//! the only IO, and the command re-validates the destination as untrusted (TB6),
//! rejecting anything inside the app-data / vault tree. Same least-privilege
//! posture as `export` / `backup` / `importer`.
//!
//! Extracted from the desktop crate into `myne-core` (shared desktop↔mobile,
//! mobile parity for the recovery-kit save). The single `#[tauri::command]`
//! (`save_secret_text`) is `AppHandle<R>`-generic — its only host coupling is
//! `crate::paths::app_data_dir(&app)` for the containment check — so it lives
//! here and each client registers it via the `myne_core::plugins::secret_export`
//! module path (a bare `pub use` of the `#[tauri::command]` fn would drop its
//! hidden `__cmd__` item). All the IO helpers it borrows (`atomic_write`,
//! `paths`, `io_failure_kind`) are already in `myne-core`, so `crate::` paths
//! resolve unchanged.
//!
//! The `tauri::Builder` `init()` wiring (register the one command) stays in each
//! client crate.
//!
//! See: the desktop crate's `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline".

pub mod commands;
pub mod error;
