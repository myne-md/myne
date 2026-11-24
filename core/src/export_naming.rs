// SPDX-License-Identifier: AGPL-3.0-only
//! Shared export-naming vocabulary for the export suite (MYND-115 / MYND-211).
//!
//! The vocabulary lives in `myne-format` so the `myne-decrypt` CLI can reuse
//! it without pulling this crate. Re-exported here so every existing
//! `crate::export_naming::…` path keeps resolving.

pub use myne_format::export_naming::{
    export_dedup_key, rewrite_embeds_to_final_names, rewrite_html_attachment_srcs,
    sanitize_export_component, suffixed_filename, DEDUP_RETRY_CAP,
};
