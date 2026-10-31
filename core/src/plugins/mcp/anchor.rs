// SPDX-License-Identifier: AGPL-3.0
//! The anchored edit and the move: the two write verbs that change text that is
//! already there (external-mcp-connection task 15).
//!
//! ## Nothing here is a second implementation
//!
//! [`place`], [`move_note`], [`edit_moves_note`] and [`edit_hides_note`] are the
//! agent's own, already reviewed against the failures they close
//! (`myne-md/myne#622`, `#848`). This module adds the three things an external
//! caller needs and the agent path does not: a scope check against the write grant,
//! a restore point, and a set of closed reasons a client can branch on. Writing a
//! second anchored-edit implementation would be the drift the repository warns
//! about twice already, and here it would be worse than duplication: the near-miss
//! rule and the frontmatter clamps are the whole safety argument, and a copy is the
//! place they quietly diverge.
//!
//! ## The exactly-once rule is the sync answer
//!
//! An edit names an exact passage and requires it to occur exactly once. Zero and
//! several are refusals with distinct causes, and a near-miss is simply zero: there
//! is no fuzzy matching to place approximately. Because the anchor is content
//! rather than an offset, a note that changed between the caller's read and this
//! write fails to match and is refused. That is the whole of the conflict answer,
//! and the expected-base guard
//! ([`McpNoteWriter::overwrite_note`](super::intent::McpNoteWriter::overwrite_note))
//! closes the narrower race where the note changes between THIS read and THIS write.
//!
//! ## An edit cannot move a note, hide a note, or rewrite its frontmatter
//!
//! [`edit_moves_note`] compares the note's folder before and after, and
//! [`edit_hides_note`] compares its archive, trash, delete, template and conflict
//! markers. Both are checked here rather than trusted to the replacement text,
//! because the text is the caller's: an anchored edit whose replacement rewrote
//! `folder:` would be a move out of a granted folder with nothing reading where it
//! landed, and one that added `deleted:` would be a delete wearing an edit's name.
//! A move has its own verb, where the destination is a field the grant can be
//! checked against.

use serde::{Deserialize, Serialize};

use super::error::McpToolError;
use super::intent::{
    base_hash_hex, check_existing, edit_refusal, take_restore_point, Gate, McpNoteWriter,
    WriteAnswer,
};
use super::scope::ConnectionScope;
use super::tools::McpNoteSource;
use super::write_scope::{WriteRoute, WriteScope};
use crate::folder_key::canonical_input_folder;

/// `note_edit`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteEditRequest {
    /// The note to change.
    pub note_id: String,
    /// The exact text to find. Must occur exactly once.
    pub source: String,
    /// What replaces it.
    pub replacement: String,
}

/// `note_move`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteMoveRequest {
    /// The note to move.
    pub note_id: String,
    /// The destination folder. Must be inside the write grant.
    pub folder: String,
}

/// What an edit answered with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditedNote {
    /// The note that changed.
    pub note_id: String,
    /// The folder it lives in, canonical (`projects/`, the root as `""`).
    pub folder: String,
    /// The bytes the replacement added, so a caller that sent a large passage
    /// learns what it did rather than assuming.
    pub added_bytes: usize,
}

/// What a move answered with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedNote {
    /// The note that moved.
    pub note_id: String,
    /// The folder it came from, canonical.
    pub from: String,
    /// The folder it went to, canonical.
    pub to: String,
}

/// `note_edit`: replace one passage, located by its exact text.
pub async fn note_edit(
    read: &ConnectionScope,
    write: &WriteScope,
    request: NoteEditRequest,
    source: &dyn McpNoteSource,
    writer: &dyn McpNoteWriter,
) -> Result<WriteAnswer<EditedNote>, McpToolError> {
    read.require_granted()?;
    write.require_granted()?;
    let folder_key = match check_existing(read, write, &request.note_id, source).await? {
        Gate::Queued(folder) => return Ok(WriteAnswer::Queued { folder }),
        Gate::Writable(folder) => folder,
    };
    take_restore_point(&request.note_id, writer).await?;
    let current = source.read_body(&request.note_id).await?;
    let next = crate::plugins::agent::edit::place(&current, &request.source, &request.replacement)
        .map_err(|rejection| edit_refusal(&request.note_id, rejection))?;
    // The two clamps the agent path applies to every anchored edit, applied here for
    // the same reason: an edit that moves or hides a note is not an edit.
    if crate::plugins::agent::frontmatter::edit_moves_note(&current, &next) {
        return Err(McpToolError::EditWouldMove);
    }
    if crate::plugins::agent::hide::edit_hides_note(&current, &next) {
        return Err(McpToolError::EditWouldHide);
    }
    let added = next.len().saturating_sub(current.len());
    writer
        .overwrite_note(&request.note_id, &next, &base_hash_hex(&current))
        .await?;
    Ok(WriteAnswer::Applied(EditedNote {
        note_id: request.note_id,
        added_bytes: added,
        folder: folder_key,
    }))
}

/// `note_move`: a note and a destination folder, both inside the write grant.
///
/// **Both halves, not just the destination.** A move takes the note OUT of the
/// folder it was in, so a grant that named only the destination would let a client
/// empty a folder the user never gave it. The source folder is the note's own, read
/// from the index rather than from the caller.
pub async fn note_move(
    read: &ConnectionScope,
    write: &WriteScope,
    request: NoteMoveRequest,
    source: &dyn McpNoteSource,
    writer: &dyn McpNoteWriter,
) -> Result<WriteAnswer<MovedNote>, McpToolError> {
    read.require_granted()?;
    write.require_granted()?;
    let from = match check_existing(read, write, &request.note_id, source).await? {
        Gate::Queued(folder) => return Ok(WriteAnswer::Queued { folder }),
        Gate::Writable(folder) => folder,
    };
    // The destination is a separate decision from the source, so it is checked
    // separately: readable first (a note put where the connection cannot read is a
    // note it loses), then writable. A destination that is readable but not writable
    // is a proposal, exactly like a create into the same folder.
    let to = canonical_input_folder(&request.folder);
    if !read.covers_key(&to) {
        return Err(McpToolError::OutOfScopeFolder { folder: to });
    }
    match write.route(&to) {
        WriteRoute::Apply => {}
        WriteRoute::Queue => return Ok(WriteAnswer::Queued { folder: to }),
        WriteRoute::Refuse(error) => return Err(error),
    }
    // The restore point is taken AFTER the destination is settled, and the order is
    // the whole difference: a move into a folder the grant does not cover must cost
    // no snapshot, since nothing is written and the user is told nothing happened.
    take_restore_point(&request.note_id, writer).await?;
    let current = source.read_body(&request.note_id).await?;
    let next = crate::plugins::agent::edit::move_note(&current, &request.folder)
        .map_err(|rejection| edit_refusal(&request.note_id, rejection))?;
    writer
        .overwrite_note(&request.note_id, &next, &base_hash_hex(&current))
        .await?;
    Ok(WriteAnswer::Applied(MovedNote {
        note_id: request.note_id,
        from,
        to,
    }))
}
