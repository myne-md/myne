// SPDX-License-Identifier: AGPL-3.0-only
//! Export mtime fidelity (MYND-115 task 3, SYNC-13).
//!
//! The mtime mapping lives in `myne-format` so the `myne-decrypt` CLI shares
//! the exact `updated:` → file-mtime behaviour the desktop app uses.
//! Re-exported here so every existing `crate::plugins::notes::export_mtime::…`
//! path keeps resolving.

pub use myne_format::notes::export_mtime::apply_updated_mtime;
