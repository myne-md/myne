// SPDX-License-Identifier: AGPL-3.0-only
//! Hybrid byte-range slice extractor for `note_titles_batch`.
//!
//! The extractor lives in `myne-format` so the `myne-decrypt` CLI shares the
//! exact title/folder/frontmatter scan the desktop app uses. Re-exported here
//! so every existing `crate::plugins::notes::title_extract::…` path keeps
//! resolving.

pub use myne_format::notes::title_extract::{
    body_after_frontmatter, extract_title_slices, fm_folder, fm_raw_value, fm_title,
    resolve_note_title, TitleSlices,
};
