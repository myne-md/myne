// SPDX-License-Identifier: AGPL-3.0-only
//! The write verbs, as host-validated intents with a restore point
//! (external-mcp-connection tasks 14 to 16; `decisions/ai/0752`).
//!
//! ## An intent, not a call
//!
//! The read tools take a scope and answer; a write verb takes a scope, a
//! [`McpNoteWriter`] and an intent, and the host decides in a fixed order. The
//! order is the whole security property, so it is stated once here and never
//! re-derived at a call site:
//!
//! 1. **A servable grant**, else [`McpToolError::NoGrant`] or
//!    [`McpToolError::ReapprovalRequired`] before any note is read.
//! 2. **The READ scope**, because a folder a connection cannot read is a folder
//!    it cannot write: a note it could put somewhere and never find again is a
//!    note it should not have written.
//! 3. **The WRITE scope**, which routes to apply, queue or refuse
//!    ([`WriteRoute`]). A folder that is readable but not named for writing is a
//!    proposal for a person, not a refusal for the client.
//! 4. **A restore point**, taken before anything is written and never coalesced
//!    away. A capture that fails refuses the write: an external agent's edit the
//!    user cannot undo is the one outcome this path may not produce. A **create**
//!    is the one verb with no step 4, because its pre-write state is the note's
//!    absence and a snapshot copies an existing blob; the note's id does not exist
//!    until the write returns either.
//! 5. **The write itself**, through the ordinary note path with its existing
//!    per-note format. There is no second write path in this module and no new
//!    on-disk shape: a note an external client created is byte-shaped like one a
//!    person typed.
//!
//! ## What no verb can do
//!
//! No delete, no rename, no attachment access, no whole-body replacement. Delete
//! and rename are absent from the catalog by decision (`mcp/src/tool_list.rs`
//! says why); whole-body replacement is absent because two devices' splices both
//! survive a merge and the note comes back containing itself twice. An append is
//! the only way to add prose at the end, and the anchored edit
//! ([`super::anchor`]) is the only way to change prose that is already there.
//!
//! ## A note the person has open is refused, not merged
//!
//! While a live co-editing session owns a note it is that session's single
//! durable writer (`SYNC-33`). The stateless save refuses, and this path reports
//! that refusal as [`McpToolError::NoteOpenInEditor`] rather than retrying: an
//! external agent's write disappearing into a merge the person cannot see is
//! worse than a refusal that says which note to close.

use serde::{Deserialize, Serialize};

use super::error::McpToolError;
use super::scope::ConnectionScope;
use super::tools::McpNoteSource;
use super::write_scope::{WriteRoute, WriteScope};
use crate::folder_key::canonical_input_folder;

/// `note_create`'s arguments, exactly as the compiled catalog declares them.
///
/// `deny_unknown_fields` for the reason every request type here carries it: a
/// payload that tries to name a scope, a note id or a path has no field to put it
/// in, and inventing one is refused rather than ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteCreateRequest {
    /// The folder the new note goes in. Must be inside the write grant.
    pub folder: String,
    /// The note's title, written into its frontmatter.
    pub title: String,
    /// The note's markdown body.
    pub body: String,
}

/// `note_append`'s arguments.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteAppendRequest {
    /// The note to append to.
    pub note_id: String,
    /// Markdown to add at the end.
    pub markdown: String,
}

/// What a create answered with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedNote {
    /// The new note's id, so the caller can read it back.
    pub note_id: String,
    /// The folder it landed in, canonical (`projects/`, the root as `""`).
    pub folder: String,
}

/// What an append answered with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendedNote {
    /// The note that grew.
    pub note_id: String,
    /// The folder it lives in, canonical (`projects/`, the root as `""`).
    pub folder: String,
    /// The bytes added, so a caller that sent a long block learns what landed.
    pub appended_bytes: usize,
}

/// What a write verb decided when it did not fail.
///
/// Two outcomes and not one, because "applied" and "queued for a person" are
/// different answers to the caller and only one of them changed the vault. A
/// refusal is the `Err` half, so a caller cannot read a queued proposal as a
/// write that landed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteAnswer<T> {
    /// The write was applied; carries the verb's own answer.
    Applied(T),
    /// The folder is readable but not named for writing, so nothing was applied
    /// and the door records a proposal for the person to accept or discard.
    Queued {
        /// The folder the write named, canonical.
        folder: String,
    },
}

/// A restore point as the writer reports it.
///
/// Two outcomes rather than one, because a note that does not exist yet has
/// nothing to restore and that is not a failure. Folding them into `Err` would
/// make a create impossible; folding them into `Ok` would make "the snapshot
/// failed" indistinguishable from "there was nothing to snapshot".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestorePoint {
    /// The note existed and its pre-write bytes are recoverable.
    Captured(String),
    /// The note did not exist, so there was no prior state to keep.
    NothingToRestore,
}

/// The host's write surface, as the verbs need it.
///
/// Three methods, each one thing the verbs cannot do themselves: the snapshot has
/// to reach `snapshots/`, the create has to go through the notes plugin's own
/// creation hook, and the overwrite has to carry the expected-base guard that
/// closes the read-then-write race. A trait rather than free functions so the
/// unit tests drive the verbs against a fake that records the ORDER (snapshot
/// before write), which is the property a green test would otherwise never hold.
#[async_trait::async_trait]
pub trait McpNoteWriter: Send + Sync {
    /// Keep the note's pre-write bytes, or report that they could not be kept.
    async fn capture_restore_point(&self, note: &str) -> Result<RestorePoint, McpToolError>;
    /// Create a note in `folder` and answer with its id.
    async fn create_note(
        &self,
        folder: &str,
        title: &str,
        body: &str,
    ) -> Result<String, McpToolError>;
    /// Overwrite a note's plaintext, refusing when its bytes are no longer
    /// `expected_base_hash_hex`.
    async fn overwrite_note(
        &self,
        note: &str,
        plaintext: &str,
        expected_base_hash_hex: &str,
    ) -> Result<(), McpToolError>;
}

/// `note_create`: a new note in a folder the connection may write to.
pub async fn note_create(
    read: &ConnectionScope,
    write: &WriteScope,
    request: NoteCreateRequest,
    writer: &dyn McpNoteWriter,
) -> Result<WriteAnswer<CreatedNote>, McpToolError> {
    read.require_granted()?;
    write.require_granted()?;
    let folder_key = canonical_input_folder(&request.folder);
    // The read half first, because it is the wider bound: a folder outside the
    // read scope is refused as a read refusal, and a folder inside it but not
    // named for writing is queued. Reporting the narrow condition first would
    // tell the caller "not writable" about a folder it also cannot read.
    if !read.covers_key(&folder_key) {
        return Err(McpToolError::OutOfScopeFolder { folder: folder_key });
    }
    match write.route(&folder_key) {
        WriteRoute::Apply => {}
        WriteRoute::Queue => return Ok(WriteAnswer::Queued { folder: folder_key }),
        WriteRoute::Refuse(error) => return Err(error),
    }
    if request.title.trim().is_empty() {
        return Err(McpToolError::EmptyTitle);
    }
    // A create has no prior state, so no restore point is taken: the note id
    // exists only after the write, and the prior state is its absence. Nothing
    // here can remove it again, because delete is not a verb this surface has.
    //
    // **The SPELLING goes into the note; the KEY only decides whether the write may
    // happen.** Canonicalising the folder this note carries would put `projects/`
    // into a vault whose notes say `Projects/`, and the sidebar shows the
    // frontmatter value: the folder guard is case-insensitive, the note's own
    // folder line is not. This is the same rule the app's own create follows.
    let mut folder_display = request.folder.trim().to_string();
    if !folder_display.is_empty() && !folder_display.ends_with('/') {
        // The shape the app writes and the sidebar reads, without touching the
        // case it was given.
        folder_display.push('/');
    }
    let note_id = writer
        .create_note(&folder_display, request.title.trim(), &request.body)
        .await?;
    Ok(WriteAnswer::Applied(CreatedNote {
        note_id,
        folder: folder_display,
    }))
}

/// `note_append`: markdown onto the end of an existing note.
///
/// The read is the caller's own read: the note is located in the index, its
/// folder is checked against BOTH scopes, and its current bytes are hashed as the
/// expected base. A note that changed between this read and the write is refused
/// by the guard rather than overwritten with an append computed from stale text,
/// which is why this verb needs no conflict machinery of its own.
pub async fn note_append(
    read: &ConnectionScope,
    write: &WriteScope,
    request: NoteAppendRequest,
    source: &dyn McpNoteSource,
    writer: &dyn McpNoteWriter,
) -> Result<WriteAnswer<AppendedNote>, McpToolError> {
    read.require_granted()?;
    write.require_granted()?;
    if request.markdown.trim().is_empty() {
        return Err(McpToolError::EmptyAppend);
    }
    let folder_key = match gate_existing(read, write, &request.note_id, source, writer).await? {
        Gate::Queued(folder) => return Ok(WriteAnswer::Queued { folder }),
        Gate::Writable(folder) => folder,
    };
    // Read the CURRENT bytes, which is what the base hash is computed over.
    let current = source.read_body(&request.note_id).await?;
    // **The agent path's own append, not a second one.** Its doc records the two
    // frontmatter hazards a hand-written append re-opens: text pushed after an
    // unclosed `---` becomes frontmatter, and text glued onto the closer stops the
    // closer closing. Both are properties of the RESULT, so only this function
    // checks them.
    let next = super::super::agent::edit::append(&current, &request.markdown)
        .map_err(|rejection| edit_refusal(&request.note_id, rejection))?;
    let appended = next.len().saturating_sub(current.len());
    writer
        .overwrite_note(&request.note_id, &next, &base_hash_hex(&current))
        .await?;
    Ok(WriteAnswer::Applied(AppendedNote {
        note_id: request.note_id,
        appended_bytes: appended,
        folder: folder_key,
    }))
}

/// What the shared gate decided about a write that targets an EXISTING note.
pub(super) enum Gate {
    /// Both scopes allow it and a restore point was taken.
    Writable(String),
    /// Readable but not named for writing: the caller answers with a proposal.
    Queued(String),
}

/// The gates every write against an existing note passes, in the one order the
/// module documents.
///
/// **One function, because the order is the security property.** A verb that
/// re-derived these five steps could get them right, and the second verb would be
/// the one that took the restore point after the write. Takes the snapshot on the
/// way through, so "a snapshot before the write" is not something a caller
/// remembers.
/// Steps 1 to 3 for a write against an existing note: the note, the read scope and
/// the write route. Takes no restore point, so a verb with more to check before
/// writing (a move's destination) can refuse without having spent one.
pub(super) async fn check_existing(
    read: &ConnectionScope,
    write: &WriteScope,
    note_id: &str,
    source: &dyn McpNoteSource,
) -> Result<Gate, McpToolError> {
    let records = source.records().await?;
    // The same seam the read verbs use: the index when it carries the note, the
    // note itself when it does not. Without it a write against a note created a
    // moment ago by another connection (or by `myne new`, or by a sync pull)
    // answered `unknown_note`, which turned the write surface into a set of verbs
    // that only worked on notes somebody had already opened in the editor.
    let Some(facts) = super::tools::facts_for(&records, source, note_id).await? else {
        return Err(McpToolError::UnknownNote {
            note_id: note_id.to_string(),
        });
    };
    let folder_key = facts.folder_key();
    if !read.covers_key(&folder_key) {
        return Err(McpToolError::OutOfScopeNote {
            note_id: note_id.to_string(),
        });
    }
    match write.route(&folder_key) {
        WriteRoute::Apply => Ok(Gate::Writable(folder_key)),
        WriteRoute::Queue => Ok(Gate::Queued(folder_key)),
        WriteRoute::Refuse(error) => Err(error),
    }
}

/// Step 4: the restore point, taken before the first byte changes and fatal if it
/// cannot be taken.
///
/// Not a warning, and not best-effort: the interface tells the user an external
/// write is undoable, and a write with no snapshot makes that false. The one outcome
/// that is not a failure is [`RestorePoint::NothingToRestore`], which means the note
/// does not exist and is a different refusal entirely.
pub(super) async fn take_restore_point(
    note_id: &str,
    writer: &dyn McpNoteWriter,
) -> Result<(), McpToolError> {
    if matches!(
        writer.capture_restore_point(note_id).await?,
        RestorePoint::NothingToRestore
    ) {
        // The note exists (the index and the caller's own read both say so), so "no
        // prior state" means it vanished between them.
        return Err(McpToolError::UnknownNote {
            note_id: note_id.to_string(),
        });
    }
    Ok(())
}

/// [`check_existing`] then [`take_restore_point`]: the whole gate for the verbs whose
/// only subject is one existing note.
pub(super) async fn gate_existing(
    read: &ConnectionScope,
    write: &WriteScope,
    note_id: &str,
    source: &dyn McpNoteSource,
    writer: &dyn McpNoteWriter,
) -> Result<Gate, McpToolError> {
    let gate = check_existing(read, write, note_id, source).await?;
    if let Gate::Writable(_) = gate {
        take_restore_point(note_id, writer).await?;
    }
    Ok(gate)
}

/// Map the shared edit module's refusal onto a closed reason for a caller.
///
/// The agent path's `EditRejection` is richer than a client can act on, and two of
/// its variants are the ones this surface exists to keep true: `AnchorNotFound` and
/// `AnchorAmbiguous` are the exactly-once rule, and `UnsafeFrontmatter` is a value
/// the two frontmatter readers would resolve differently.
pub(super) fn edit_refusal(
    note_id: &str,
    rejection: crate::plugins::agent::error::EditRejection,
) -> McpToolError {
    use crate::plugins::agent::error::EditRejection as Rejection;
    match rejection {
        Rejection::AnchorNotFound => McpToolError::AnchorNotFound,
        Rejection::AnchorAmbiguous => McpToolError::AnchorNotUnique,
        Rejection::AnchorEmpty => McpToolError::EmptySource,
        Rejection::AppendEmpty => McpToolError::EmptyAppend,
        Rejection::UnsafeFrontmatter => McpToolError::UnwritableTitle,
        // The shared module's own scope refusal, which cannot fire here (the scope
        // was checked before this call) and is answered as the read refusal for the
        // note this call named rather than invented as an internal error.
        Rejection::OutOfScope => McpToolError::OutOfScopeNote {
            note_id: note_id.to_string(),
        },
        // Everything else is a state this surface cannot produce (a note that was
        // never proposed, a create that failed, a removal needing its own act), and
        // is answered as an internal failure rather than as a refusal a client would
        // retry.
        _ => McpToolError::VaultUnavailable,
    }
}

/// SHA-256 of the plaintext, lowercase hex: the `expectedBaseHashHex` the
/// `note_update` guard is written against (`baseHash.ts` computes the same value
/// on the client).
pub fn base_hash_hex(plaintext: &str) -> String {
    use sha2::Digest as _;
    use std::fmt::Write as _;
    let digest = sha2::Sha256::digest(plaintext.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing into a String cannot fail, and the alternative (a `format!`
        // per byte) allocates a String per byte for the same answer.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}
