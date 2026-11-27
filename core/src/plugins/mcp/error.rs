// SPDX-License-Identifier: AGPL-3.0-only
//! Why an external connection's tool call was refused.
//!
//! Every variant here is a *decision the host made*, and each one is answered as
//! a value rather than as a failure the caller has to interpret from prose: an
//! agent relays this to a person verbatim, so the reason has to be a closed
//! label it can branch on and the sentence has to name the one next action.
//!
//! **A refusal is never a protocol error.** That is the shim's rule
//! (`mcp/src/errors.rs`) and it holds here for the same reason: a JSON-RPC error
//! reads to a client as a broken server and it reconnects, which is exactly the
//! failure the connection is built to survive.
//!
//! ## The label is wire-shaped
//!
//! [`McpToolError::reason`] returns the snake-case label the shim puts in
//! `structuredContent.reason`, and the shim validates that label as a wire value
//! before relaying it (`is_wire_label` in `mcp/src/errors.rs`: lower-case ASCII,
//! digits, underscores). The two are separate crates with no shared type by
//! design, so `every_reason_is_a_wire_label` below holds the shape rather than
//! leaving it to review.
//!
//! ## What no variant carries
//!
//! No note body, no folder contents, no path, no plaintext. A refusal may name
//! the note id or the folder the CALLER asked for, because the caller already
//! has it, and nothing else.

use serde::Serialize;

/// One refusal an MCP read may produce, with the cause as data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum McpToolError {
    /// The declared connection name has no grant on this device. The resolved
    /// scope is therefore empty and every tool refuses, rather than answering as
    /// an empty vault (which would read as "your vault has no notes").
    #[serde(rename = "no_grant")]
    NoGrant,
    /// The connection was approved under the retired allow-list scope model, so
    /// this build cannot serve it without guessing what the user meant.
    ///
    /// A distinct reason rather than `no_grant`, because the caller's next action
    /// differs: nothing is wrong with the client, and the human has to re-approve
    /// a connection that is listed on screen under a model that no longer exists.
    #[serde(rename = "reapproval_required")]
    ReapprovalRequired,
    /// The search query was empty. Refused rather than answered because an empty
    /// query is a request to enumerate the whole scope, and the search tool is
    /// the one verb a caller can loop to approximate reading everything.
    #[serde(rename = "empty_query")]
    EmptyQuery,
    /// The id is not in the vault index at all.
    #[serde(rename = "unknown_note")]
    UnknownNote { note_id: String },
    /// The note exists but sits in a folder the user left out.
    #[serde(rename = "out_of_scope")]
    OutOfScopeNote { note_id: String },
    /// The id is not in the attachments catalog at all.
    ///
    /// A separate reason from `unknown_note` because the caller's next action is
    /// different: a note id is found with `note_search`, and a file id is found
    /// with `attachment_list`. Collapsing them would send a model looking for a
    /// file in the note search and concluding the file does not exist.
    #[serde(rename = "unknown_file")]
    UnknownFile { attachment_id: String },
    /// The file exists but is filed in a folder the user left out.
    #[serde(rename = "out_of_scope_file")]
    OutOfScopeFile { attachment_id: String },
    /// A calendar window wider than the bound this surface accepts.
    ///
    /// The same 366-day bound `vault_indices::calendar` enforces, reported with the
    /// number so a caller can narrow rather than guess. Asking unbounded would put
    /// the whole calendar inside one call, which is the shape the bound exists to
    /// make unexpressible.
    #[serde(rename = "calendar_window_too_wide")]
    CalendarWindowTooWide { max_days: u32 },
    /// A calendar window whose bounds the calendar could not read: `from` later
    /// than `to`, or a bound that is not a date the app parses.
    ///
    /// Separate from [`Self::VaultUnavailable`] for one reason: that reason tells a
    /// caller to unlock the vault and try again, which is the wrong next action for
    /// a reversed range and sends it round a loop it cannot leave. The host had the
    /// distinction already (`VaultIndicesError::CalendarWindowUnreadable`) and this
    /// door threw it away in a catch-all, so every such call answered
    /// `vault_unavailable` and read as a locked vault (myne-md/myne#1231).
    #[serde(rename = "calendar_window_unreadable")]
    CalendarWindowUnreadable,
    /// The saved view a field write named is not approved on this device, or it
    /// is approved at a different version than the one stored. Both read the same
    /// way, because nothing approved THIS definition.
    #[serde(rename = "view_not_approved")]
    ViewNotApproved { view_id: String },
    /// The approved view does not declare this field as writable, so the write has
    /// no authority behind it. The caller's next action is to name a field the
    /// view offers, or a view that offers this one.
    #[serde(rename = "field_not_writable")]
    FieldNotWritable { field: String },
    /// The field is one of the working-set markers. Refused even when a view
    /// declares it: this surface has no delete, and a property write that can hide
    /// a note is a delete wearing another name.
    #[serde(rename = "field_reserved")]
    FieldReserved { field: String },
    /// The field name is not a plain YAML key, so no reader could find it again.
    #[serde(rename = "invalid_field")]
    InvalidField { field: String },
    /// The value would push the note past the plaintext cap. The disk is fine; the
    /// value is what does not fit.
    #[serde(rename = "value_too_large")]
    ValueTooLarge,
    /// A write named a title that is empty once trimmed. Refused rather than
    /// written, because a note with no title has no name in the sidebar and the
    /// caller cannot find it again to fix it.
    #[serde(rename = "empty_title")]
    EmptyTitle,
    /// An append whose markdown is empty once trimmed, for the same reason: the
    /// note would not change, and a caller told otherwise would go looking for an
    /// edit that never happened.
    #[serde(rename = "empty_append")]
    EmptyAppend,
    /// The passage an edit named does not occur in the note at all.
    ///
    /// Named separately from a unique-match failure because the caller's next action
    /// differs: nothing is found means the text came from somewhere else (an older
    /// read, another note), and several matches means it has to say MORE.
    #[serde(rename = "anchor_not_found")]
    AnchorNotFound,
    /// The passage occurs more than once, so placing the replacement would be a
    /// choice this surface refuses to make for the user.
    #[serde(rename = "anchor_not_unique")]
    AnchorNotUnique,
    /// An edit carried no source passage. Refused rather than treated as a
    /// whole-body replace, which is the verb this surface deliberately lacks.
    #[serde(rename = "empty_source")]
    EmptySource,
    /// The replacement would rewrite the note's `folder:` line, which is a move
    /// wearing an edit's clothes: the destination would never be checked against
    /// the write grant.
    #[serde(rename = "edit_would_move")]
    EditWouldMove,
    /// The replacement would add an archive, trash, delete, template or conflict
    /// marker, which is how an edit would hide a note this surface has no verb to
    /// delete.
    #[serde(rename = "edit_would_hide")]
    EditWouldHide,
    /// The title or the folder carries a character this verb cannot write
    /// faithfully into the note's frontmatter.
    ///
    /// The app reads frontmatter with js-yaml and the excluded-folder clamp reads
    /// it with a Rust scalar reader (`myne-md/myne#848`), so a value one of them
    /// re-types is a value that reads differently in two places. The rule is the
    /// agent edit path's own (`yaml_folder_scalar`), not a second opinion, and the
    /// refusal names what to send instead rather than quoting badly.
    #[serde(rename = "unwritable_title")]
    UnwritableTitle,
    /// The restore point could not be taken, so the write was refused and
    /// nothing was applied.
    ///
    /// A refusal of its own rather than `vault_unavailable`, because the caller's
    /// next action is different and it is not the caller's fault: the person has
    /// to clear space or unlock whatever the snapshot store needs, and the client
    /// retries the identical call successfully afterwards.
    #[serde(rename = "restore_point_failed")]
    RestorePointFailed,
    /// The note changed between the caller's read and this write, so the write
    /// was refused rather than applied against stale text.
    #[serde(rename = "note_changed")]
    NoteChanged { note_id: String },
    /// A live co-editing session owns this note, so this build cannot write it
    /// from an external connection (`SYNC-33`).
    ///
    /// Named rather than collapsed into a generic refusal because the person can
    /// act on it: closing the note in the editor releases the session and the
    /// retry succeeds.
    #[serde(rename = "note_open_in_editor")]
    NoteOpenInEditor { note_id: String },
    /// The `folder` argument to a search is in a folder the user left out, so
    /// narrowing to it would be a request to read where it may not look.
    #[serde(rename = "out_of_scope_folder")]
    OutOfScopeFolder { folder: String },
    /// The write named a folder the connection may read but not write, so it was
    /// **not applied** and became a proposal in Myne's review card for the person
    /// to accept or discard.
    ///
    /// A reason of its own rather than a plain refusal, because the two are
    /// different outcomes for the caller: a refusal is answered by giving up, and
    /// a queued proposal is answered by telling the person it is waiting. Without
    /// the distinction a client retries what it may not write, and a retrying
    /// client is indistinguishable from a probing one.
    #[serde(rename = "write_queued_for_review")]
    WriteQueuedForReview { folder: String },
    /// The connection may not call this verb: the person turned it off on the
    /// approval screen (mcp external access rework, myne-md/myne#1052).
    ///
    /// Its own reason rather than `no_grant`, because the caller's next action
    /// differs and it is not the connection: this one is approved and readable, and
    /// the person has to switch the verb back on if they want it used. A plain
    /// refusal here would read to the model as a scope bug and it would retry.
    #[serde(rename = "verb_disabled")]
    VerbDisabled { verb: String },
    /// The connection has spent its note budget for this window (mcp external
    /// access rework, myne-md/myne#1052).
    ///
    /// A distinct reason from a scope refusal because the caller's next action is
    /// to wait, not to ask the user for anything: the folder is readable, the verb
    /// is on, and the only thing that changed is how much has already been taken.
    /// Answered as a refusal rather than an empty result, because an empty result
    /// would read to the model as "your vault is empty" and it would search again.
    #[serde(rename = "budget_exhausted")]
    BudgetExhausted { retry_after_seconds: u64 },
    /// The host could not read the index or the note. Collapsed into one label on
    /// purpose: the internal cause is an IO or decode detail that must not cross
    /// to a process Myne does not ship (`core/AGENTS.md` "Error modelling").
    #[serde(rename = "vault_unavailable")]
    VaultUnavailable,
}

impl McpToolError {
    /// The machine-readable reason, stable across releases.
    ///
    /// Snake case, because this value becomes the shim's `reason` field and the
    /// shim refuses anything that is not a wire label.
    pub fn reason(&self) -> &'static str {
        match self {
            McpToolError::NoGrant => "no_grant",
            McpToolError::ReapprovalRequired => "reapproval_required",
            McpToolError::EmptyQuery => "empty_query",
            McpToolError::UnknownNote { .. } => "unknown_note",
            McpToolError::OutOfScopeNote { .. } => "out_of_scope",
            McpToolError::UnknownFile { .. } => "unknown_file",
            McpToolError::OutOfScopeFile { .. } => "out_of_scope_file",
            McpToolError::CalendarWindowTooWide { .. } => "calendar_window_too_wide",
            McpToolError::CalendarWindowUnreadable => "calendar_window_unreadable",
            McpToolError::ViewNotApproved { .. } => "view_not_approved",
            McpToolError::FieldNotWritable { .. } => "field_not_writable",
            McpToolError::FieldReserved { .. } => "field_reserved",
            McpToolError::InvalidField { .. } => "invalid_field",
            McpToolError::ValueTooLarge => "value_too_large",
            McpToolError::EmptyTitle => "empty_title",
            McpToolError::EmptyAppend => "empty_append",
            McpToolError::AnchorNotFound => "anchor_not_found",
            McpToolError::AnchorNotUnique => "anchor_not_unique",
            McpToolError::EmptySource => "empty_source",
            McpToolError::EditWouldMove => "edit_would_move",
            McpToolError::EditWouldHide => "edit_would_hide",
            McpToolError::UnwritableTitle => "unwritable_title",
            McpToolError::RestorePointFailed => "restore_point_failed",
            McpToolError::NoteChanged { .. } => "note_changed",
            McpToolError::NoteOpenInEditor { .. } => "note_open_in_editor",
            McpToolError::OutOfScopeFolder { .. } => "out_of_scope_folder",
            McpToolError::WriteQueuedForReview { .. } => "write_queued_for_review",
            McpToolError::VerbDisabled { .. } => "verb_disabled",
            McpToolError::BudgetExhausted { .. } => "budget_exhausted",
            McpToolError::VaultUnavailable => "vault_unavailable",
        }
    }

    /// One actionable sentence, for a human the agent is talking to.
    ///
    /// Every arm names what the person can do next, in the WORDS OF THE MODEL THIS
    /// BUILD SHIPS. The two read-scope arms used to say "ask the user to add its
    /// folder to the connection's scope", which the deny-list reversal made false:
    /// there is no add-to-scope control left, so the remedy is to take the folder
    /// off the leave-out list. A remedy the software does not have is worse than no
    /// remedy, because the agent relays it and the user hunts for a control that was
    /// removed. None of them repeats the note id: the caller already has it, and a
    /// refusal is not the place to echo vault content back.
    pub fn message(&self) -> &'static str {
        match self {
            McpToolError::NoGrant => {
                "This connection has no approved scope in Myne: approve it under Settings, AI in \
                 the Myne app, then call this tool again."
            }
            McpToolError::ReapprovalRequired => {
                "This connection was approved under an older scope model in Myne: open Settings, \
                 AI and approve it again, then call this tool again."
            }
            McpToolError::EmptyQuery => {
                "The search had no query text: send the words to look for, since an empty search \
                 is a request to Myne to list everything this connection may read."
            }
            McpToolError::UnknownNote { .. } => {
                "No note with that id exists in this vault: call note_search to find the note's \
                 id, then read that id."
            }
            McpToolError::OutOfScopeNote { .. } => {
                "That note is in a folder the user left out of this connection's approval: ask \
                 the user to stop leaving that folder out, under Settings, AI, in the Myne app."
            }
            McpToolError::UnknownFile { .. } => {
                "No file with that id exists in this vault: call attachment_list to find the \
                 file's id, then read that id."
            }
            McpToolError::OutOfScopeFile { .. } => {
                "That file is in a folder the user left out of this connection's approval: ask \
                 the user to stop leaving that folder out, under Settings, Connections, in the \
                 Myne app."
            }
            McpToolError::CalendarWindowTooWide { .. } => {
                "That date range is wider than Myne reads in one call: ask for a shorter \
                 range, at most a year at a time."
            }
            McpToolError::CalendarWindowUnreadable => {
                "That date range could not be read: the start has to be on or before the end, \
                 both as dates, and nothing about the vault is wrong, so unlocking Myne will \
                 not help."
            }
            McpToolError::OutOfScopeFolder { .. } => {
                "That folder is one the user left out of this connection's approval: ask the user \
                 to stop leaving it out, under Settings, AI, in the Myne app."
            }
            McpToolError::ViewNotApproved { .. } => {
                "That saved view is not approved on this device, or its definition changed: ask \
                 the user to approve it under Settings, AI, in the Myne app, or call view_list for \
                 a view that is already approved."
            }
            McpToolError::FieldNotWritable { .. } => {
                "The view does not declare that field as writable: call view_list to see the \
                 views this vault has, and set a field the approved view writes."
            }
            McpToolError::FieldReserved { .. } => {
                "That field is one of the markers that move a note out of Myne's note list, and no \
                 tool here may set one: a property write must not be able to hide a note."
            }
            McpToolError::InvalidField { .. } => {
                "That field name is not one Myne can write and read back: send a plain key made of \
                 letters, digits, underscores and dashes."
            }
            McpToolError::ValueTooLarge => {
                "That value is too large for one note in Myne: send a shorter value."
            }
            McpToolError::EmptyTitle => {
                "The new note had no title: send a title with the create, since a note that cannot \
                 be named in Myne's note list cannot be found again to fix."
            }
            McpToolError::EmptyAppend => {
                "The append carried no text: send the markdown to add, since an empty append would \
                 leave the note exactly as it was and Myne would report a change that did not \
                 happen."
            }
            McpToolError::AnchorNotFound => {
                "That exact passage is not in the note now: read the note again and copy the \
                 passage out of what it currently says, since Myne refuses a near-miss rather \
                 than placing it approximately."
            }
            McpToolError::AnchorNotUnique => {
                "That passage occurs more than once in the note, so Myne will not choose which \
                 one to replace: send a longer passage that includes enough of the surroundings to \
                 occur exactly once."
            }
            McpToolError::EmptySource => {
                "The edit named no passage to replace, and Myne cannot rewrite a whole note \
                 body: send the exact existing text to change and what replaces it, or use \
                 note_append to add text instead."
            }
            McpToolError::EditWouldMove => {
                "The replacement would change the note's folder line, and a folder is not \
                 something an edit may set: call note_move instead, where Myne checks the \
                 destination against the write grant."
            }
            McpToolError::EditWouldHide => {
                "The replacement would add an archive, trash, delete, template or conflict \
                 marker, which puts the note out of the user's sight: Myne offers no tool that \
                 hides a note, so this edit was refused."
            }
            McpToolError::UnwritableTitle => {
                "The title or folder carries a quote, a backslash, a line break or surrounding \
                 space, and Myne will not write it when two readers would then disagree about the \
                 value: send it again without those characters."
            }
            McpToolError::RestorePointFailed => {
                "Myne could not keep a copy of the note before changing it, so it refused the \
                 write and nothing was applied: free some disk space in the vault, then call this \
                 tool again."
            }
            McpToolError::NoteChanged { .. } => {
                "The note changed after this connection read it, so Myne refused the write rather \
                 than applying it to text that has moved on: read the note again and repeat the \
                 change against what it now says."
            }
            McpToolError::NoteOpenInEditor { .. } => {
                "The note is open in Myne's editor, which owns writing it while it is open, so the \
                 write was refused and nothing was applied: ask the user to close the note, then \
                 call this tool again."
            }
            McpToolError::WriteQueuedForReview { .. } => {
                "That folder is readable but not one the user named for writing, so nothing was \
                 written: Myne queued the change as a proposal in its review card, and the user \
                 can accept it there."
            }
            McpToolError::VerbDisabled { verb } => {
                // The verb is a WIRE name the caller already sent, so naming it
                // echoes nothing it does not have. The remedy names where the switch
                // is, because the connection tab is one tab in a panel the agent
                // cannot see.
                match verb.as_str() {
                    "note_create" | "note_append" | "note_edit" | "note_move" => {
                        "That change was switched off for this connection in Myne: ask the user to \
                         turn it back on under Settings, AI, External access, then call this tool \
                         again."
                    }
                    _ => {
                        "Reading through that tool was switched off for this connection in Myne: \
                         ask the user to turn it back on under Settings, AI, External access, then \
                         call this tool again."
                    }
                }
            }
            McpToolError::BudgetExhausted {
                retry_after_seconds,
            } => {
                // The number is minutes rather than seconds because the reader is a
                // person the agent relays this to, and the window is a quarter of an
                // hour: a second count of nine hundred is not something anyone can
                // act on. Rounded up, so the sentence never promises a wait shorter
                // than the one that is actually left.
                if *retry_after_seconds >= 120 {
                    "This connection has read as many notes as Myne allows in one window, so nothing \
                     was returned: ask the user whether to wait for the budget to refill after \
                     Settings, AI, External access, or to read fewer notes per call."
                } else {
                    "This connection has read as many notes as Myne allows in one window, so nothing \
                     was returned: wait for the budget to refill, then call this tool again."
                }
            }
            McpToolError::VaultUnavailable => {
                "Myne could not read the vault for this call: unlock the vault in the Myne app \
                 and call this tool again."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every variant, so a new one cannot skip the shape checks below by never
    /// being listed.
    fn all() -> Vec<McpToolError> {
        vec![
            McpToolError::NoGrant,
            McpToolError::ReapprovalRequired,
            McpToolError::EmptyQuery,
            McpToolError::UnknownNote {
                note_id: "n".into(),
            },
            McpToolError::OutOfScopeNote {
                note_id: "n".into(),
            },
            McpToolError::UnknownFile {
                attachment_id: "aa".into(),
            },
            McpToolError::OutOfScopeFile {
                attachment_id: "aa".into(),
            },
            McpToolError::CalendarWindowTooWide { max_days: 366 },
            McpToolError::CalendarWindowUnreadable,
            McpToolError::ViewNotApproved {
                view_id: "v1".into(),
            },
            McpToolError::FieldNotWritable {
                field: "status".into(),
            },
            McpToolError::FieldReserved {
                field: "trashed".into(),
            },
            McpToolError::InvalidField {
                field: "a b".into(),
            },
            McpToolError::ValueTooLarge,
            McpToolError::EmptyTitle,
            McpToolError::EmptyAppend,
            McpToolError::AnchorNotFound,
            McpToolError::AnchorNotUnique,
            McpToolError::EmptySource,
            McpToolError::EditWouldMove,
            McpToolError::EditWouldHide,
            McpToolError::UnwritableTitle,
            McpToolError::RestorePointFailed,
            McpToolError::NoteChanged {
                note_id: "n".into(),
            },
            McpToolError::NoteOpenInEditor {
                note_id: "n".into(),
            },
            McpToolError::OutOfScopeFolder {
                folder: "Private".into(),
            },
            McpToolError::WriteQueuedForReview {
                folder: "Projects".into(),
            },
            McpToolError::VerbDisabled {
                verb: "note_edit".into(),
            },
            McpToolError::BudgetExhausted {
                retry_after_seconds: 900,
            },
            McpToolError::VaultUnavailable,
        ]
    }

    #[test]
    fn the_roster_covers_every_variant() {
        // A property test is only as good as its roster, and this one had silently
        // fallen four variants behind the enum: the calendar pair and the two file
        // reasons were never checked, so a bad label there would have shipped as a
        // generic `refused`. The length is a literal on purpose — a variant added
        // without adding it here fails this count rather than quietly going
        // unchecked.
        assert_eq!(
            all().len(),
            30,
            "the roster and the enum disagree: add the new variant to both"
        );
        let mut reasons: Vec<&str> = all().iter().map(McpToolError::reason).collect();
        reasons.sort_unstable();
        let unique = reasons.len();
        reasons.dedup();
        assert_eq!(
            unique,
            reasons.len(),
            "two variants share one wire label, so a client cannot tell them apart"
        );
    }

    #[test]
    fn every_reason_is_a_wire_label() {
        // The shim's rule, restated: lower-case ASCII, digits, underscores, at
        // most 64 characters, not starting with a digit. A reason that failed
        // this would be relayed as the generic `refused` and the caller would
        // lose the distinction this enum exists for.
        for error in all() {
            let reason = error.reason();
            let mut chars = reason.chars();
            assert!(
                chars.next().is_some_and(|c| c.is_ascii_lowercase()),
                "{reason} must start with a lower-case letter"
            );
            assert!(
                reason.len() <= 64
                    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{reason} is not a wire label"
            );
        }
    }

    #[test]
    fn reasons_are_distinct() {
        let mut reasons: Vec<&str> = all().iter().map(McpToolError::reason).collect();
        let total = reasons.len();
        reasons.sort_unstable();
        reasons.dedup();
        assert_eq!(reasons.len(), total, "two variants share a reason");
    }

    #[test]
    fn every_message_is_one_actionable_sentence() {
        for error in all() {
            let message = error.message();
            assert!(
                message.ends_with('.'),
                "{:?} must end in a full stop: {message}",
                error.reason()
            );
            assert!(
                !message.trim_end_matches('.').contains(". "),
                "{:?} is more than one sentence: {message}",
                error.reason()
            );
            // "Names the product, or the call it can make next." The second half
            // used to be spelled `message.contains("note_search")`, which is true of
            // exactly one sentence's worth of advice: `unknown_file` says "call
            // attachment_list" and failed a rule that meant to allow it, so the
            // narrower rule would have pushed copy towards the one tool name it
            // recognised. Asking the catalog instead is the rule the doc states.
            let names_a_tool = crate::plugins::mcp::tools::CATALOG_VERBS
                .iter()
                .any(|verb| message.contains(verb));
            assert!(
                message.contains("Myne") || names_a_tool,
                "{:?} must name the product or the next call: {message}",
                error.reason()
            );
            assert!(
                !message.contains('\n') && !message.contains('\u{2014}'),
                "{:?} carries a newline or an em dash",
                error.reason()
            );
            // The shim bounds a relayed message at 240 bytes
            // (`mcp/src/errors.rs::MAX_RELAYED_MESSAGE_BYTES`); a sentence that
            // exceeds it would be cut before the reader gets the action.
            assert!(
                message.len() <= 240,
                "{:?} is {} bytes, over the shim's relay cap",
                error.reason(),
                message.len()
            );
        }
    }

    /// The serde `kind` and [`McpToolError::reason`] are two spellings of one
    /// label, so they have to agree: the shim relays `reason`, and the host's
    /// door refusal carries the serialized `kind`. Two spellings that drifted
    /// would make the same refusal identifiable by one label on one path and a
    /// different one on the other.
    #[test]
    fn the_serialised_kind_is_the_reason() {
        for error in all() {
            let value = serde_json::to_value(&error).unwrap();
            assert_eq!(
                value["kind"],
                error.reason(),
                "{error:?} serialises under a label its reason() does not return"
            );
        }
    }

    #[test]
    fn a_refusal_serialises_with_the_reason_and_the_cause_as_data() {
        let value = serde_json::to_value(McpToolError::OutOfScopeNote {
            note_id: "abc".into(),
        })
        .unwrap();
        assert_eq!(value["kind"], "out_of_scope");
        assert_eq!(value["detail"]["note_id"], "abc");
        let bare = serde_json::to_value(McpToolError::NoGrant).unwrap();
        assert_eq!(bare["kind"], "no_grant");
    }
}
