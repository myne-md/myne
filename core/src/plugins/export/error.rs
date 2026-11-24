// SPDX-License-Identifier: AGPL-3.0-only
//! Tauri-layer error type for the `export` plugin (MYND-211).
//!
//! The error enum and its label helper live in `myne-format` so the
//! `myne-decrypt` CLI shares the exact error surface the desktop app returns.
//! Re-exported here so every existing `crate::plugins::export::error::…` path
//! keeps resolving.

pub use myne_format::export_error::{vault_export_error_kind, VaultExportError};
