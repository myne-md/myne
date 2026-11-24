// SPDX-License-Identifier: AGPL-3.0-only
//! `NoteId` — host-side UUIDv7 wrapper for note identifiers.
//!
//! The identifier lives in `myne-format` so the `myne-decrypt` CLI shares the
//! exact strict-parse contract the desktop app uses. Re-exported here so every
//! existing `crate::plugins::notes::note_id::…` path keeps resolving.

pub use myne_format::notes::note_id::{InvalidNoteIdCause, NoteId};
