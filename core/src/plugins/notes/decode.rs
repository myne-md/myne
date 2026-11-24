// SPDX-License-Identifier: AGPL-3.0-only
//! The one place a note blob is turned back into markdown, whatever its format
//! (myne-md/myne#432, #442).
//!
//! The dispatcher lives in `myne-format` so the `myne-decrypt` CLI can read a
//! note without pulling this crate. Re-exported here so every existing
//! `crate::plugins::notes::decode::…` path keeps resolving.

pub use myne_format::notes::decode::{decode_note_any, NoteDecodeError};
