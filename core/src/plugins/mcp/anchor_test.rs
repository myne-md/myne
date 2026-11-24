// SPDX-License-Identifier: AGPL-3.0-only
//! The anchored edit and the move, one refusal per named cause.
//!
//! The near-miss case is the one worth reading twice. There is no fuzzy matcher to
//! test for "refused rather than placed approximately", because the rule is that no
//! fuzzy matcher exists: the assertion is that a passage differing from the note by
//! one space or one letter case is `anchor_not_found`, which is the same answer as
//! text that came from another note entirely.

use super::anchor::{note_edit, note_move, NoteEditRequest, NoteMoveRequest};
use super::error::McpToolError;
use super::intent::{McpNoteWriter, RestorePoint, WriteAnswer};
use super::scope::{resolve_scope, ConnectionScope};
use super::tools::{FileRow, McpNoteSource, ViewRow};
use super::write_scope::{resolve_write_scope, WriteScope};
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::calendar::CalendarRow;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::test_support::block_on;
use protocol::{McpConnectionGrant, McpScopeModel};
use std::collections::BTreeMap;
use std::sync::Mutex;

// ── fixtures ────────────────────────────────────────────────────────────────

const NAME: &str = "claude-desktop";

fn grant(excluded: &[&str], write: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: write.iter().map(|f| f.to_string()).collect(),
        disabled_verbs: Vec::new(),
    }
}

/// Everything readable except `private/`, `projects/` and `archive/` named for
/// writing.
fn scopes() -> (ConnectionScope, WriteScope) {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(
        NAME.to_string(),
        grant(&["Private"], &["projects/", "archive/"]),
    );
    (resolve_scope(NAME, &map), resolve_write_scope(NAME, &map))
}

struct Source {
    records: BTreeMap<String, NoteRecord>,
    bodies: BTreeMap<String, String>,
}

impl Source {
    fn new(notes: &[(&str, &str, &str)]) -> Self {
        let mut records = BTreeMap::new();
        let mut bodies = BTreeMap::new();
        for (id, folder, body) in notes {
            records.insert(
                (*id).to_string(),
                NoteRecord {
                    title: Some((*id).to_string()),
                    folder: Some((*folder).to_string()),
                    ..Default::default()
                },
            );
            bodies.insert((*id).to_string(), (*body).to_string());
        }
        Self { records, bodies }
    }
}

#[async_trait::async_trait]
impl McpNoteSource for Source {
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError> {
        Ok(self.records.clone())
    }

    async fn read_body(&self, note_id: &str) -> Result<String, McpToolError> {
        self.bodies
            .get(note_id)
            .cloned()
            .ok_or_else(|| McpToolError::UnknownNote {
                note_id: note_id.to_string(),
            })
    }

    async fn search(&self, _query: &str, _limit: usize) -> Result<Vec<SearchHit>, McpToolError> {
        Ok(Vec::new())
    }

    async fn files(&self) -> Result<Vec<FileRow>, McpToolError> {
        Ok(Vec::new())
    }

    async fn file_text(&self, _attachment_id: &str) -> Result<Option<String>, McpToolError> {
        Ok(None)
    }

    async fn calendar(&self, _from: &str, _to: &str) -> Result<Vec<CalendarRow>, McpToolError> {
        Ok(Vec::new())
    }

    async fn views(&self) -> Result<Vec<ViewRow>, McpToolError> {
        Ok(Vec::new())
    }
}

/// A writer that records every call and keeps the plaintext it was asked to write,
/// so a test can assert what the note would have CONTAINED rather than only that a
/// refusal happened.
struct Writer {
    log: Mutex<Vec<String>>,
    written: Mutex<Option<String>>,
    snapshot: Result<RestorePoint, McpToolError>,
}

impl Writer {
    fn ok() -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            written: Mutex::new(None),
            snapshot: Ok(RestorePoint::Captured("snap".into())),
        }
    }

    fn failing_snapshot() -> Self {
        Self {
            snapshot: Err(McpToolError::RestorePointFailed),
            ..Self::ok()
        }
    }

    fn calls(&self) -> Vec<String> {
        self.log.lock().expect("writer log").clone()
    }

    fn written(&self) -> Option<String> {
        self.written.lock().expect("writer body").clone()
    }
}

#[async_trait::async_trait]
impl McpNoteWriter for Writer {
    async fn capture_restore_point(&self, note: &str) -> Result<RestorePoint, McpToolError> {
        self.log
            .lock()
            .expect("writer log")
            .push(format!("snapshot:{note}"));
        self.snapshot.clone()
    }

    async fn create_note(
        &self,
        folder: &str,
        _title: &str,
        _body: &str,
    ) -> Result<String, McpToolError> {
        self.log
            .lock()
            .expect("writer log")
            .push(format!("create:{folder}"));
        Ok("new-note".into())
    }

    async fn overwrite_note(
        &self,
        note: &str,
        plaintext: &str,
        expected_base_hash_hex: &str,
    ) -> Result<(), McpToolError> {
        self.log
            .lock()
            .expect("writer log")
            .push(format!("overwrite:{note}:{expected_base_hash_hex}"));
        *self.written.lock().expect("writer body") = Some(plaintext.to_string());
        Ok(())
    }
}

fn edit(note_id: &str, source: &str, replacement: &str) -> NoteEditRequest {
    NoteEditRequest {
        note_id: note_id.to_string(),
        source: source.to_string(),
        replacement: replacement.to_string(),
    }
}

fn move_to(note_id: &str, folder: &str) -> NoteMoveRequest {
    NoteMoveRequest {
        note_id: note_id.to_string(),
        folder: folder.to_string(),
    }
}

const BODY: &str = "---\ntitle: Alpha\nfolder: Projects/\n---\nalpha beta gamma\n";

// ── the exactly-once rule ──────────────────────────────────────────────────

#[test]
fn mcp_anchor_an_edit_that_matches_exactly_once_applies() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let answer = block_on(note_edit(
        &read,
        &write,
        edit("n1", "beta", "BETA"),
        &source,
        &writer,
    ))
    .expect("a unique passage applies");
    match answer {
        WriteAnswer::Applied(edited) => assert_eq!(edited.note_id, "n1"),
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
    let written = writer.written().expect("the write happened");
    assert!(written.contains("alpha BETA gamma"), "{written}");
    // And the restore point came first.
    assert_eq!(writer.calls()[0], "snapshot:n1");
}

#[test]
fn mcp_anchor_zero_matches_refuses_with_its_own_cause() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "delta", "DELTA"),
        &source,
        &writer,
    ))
    .expect_err("text that is not in the note cannot be replaced");
    assert_eq!(error, McpToolError::AnchorNotFound);
    assert!(
        !writer.calls().iter().any(|c| c.starts_with("overwrite")),
        "{:?}",
        writer.calls()
    );
}

#[test]
fn mcp_anchor_multiple_matches_refuses_with_a_different_cause() {
    let (read, write) = scopes();
    // "alpha" twice, so replacing it would be a choice this surface will not make.
    let source = Source::new(&[("n1", "Projects/", "alpha one alpha two\n")]);
    let writer = Writer::ok();
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "alpha", "omega"),
        &source,
        &writer,
    ))
    .expect_err("an ambiguous passage is refused");
    assert_eq!(error, McpToolError::AnchorNotUnique);
    // A DIFFERENT cause from zero matches, which is the distinction a client acts
    // on: say more, versus look again.
    assert_ne!(
        McpToolError::AnchorNotUnique.reason(),
        McpToolError::AnchorNotFound.reason()
    );
}

#[test]
fn mcp_anchor_a_near_miss_is_refused_rather_than_placed() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    // Each differs from a passage the note carries by one character, and none of
    // them IS a passage the note carries: a fixture that accidentally matched would
    // make this test assert the opposite of its name.
    for near_miss in [
        // One letter of case.
        "Gamma",
        // One trailing space.
        "gamma ",
        // One character of punctuation.
        "gamma,",
        // The right words, wrong whitespace.
        "alpha  gamma",
    ] {
        let error = block_on(note_edit(
            &read,
            &write,
            edit("n1", near_miss, "X"),
            &source,
            &writer,
        ))
        .expect_err("a near miss is not a match");
        assert_eq!(
            error,
            McpToolError::AnchorNotFound,
            "{near_miss:?} must be refused, not placed approximately"
        );
    }
    assert!(writer.written().is_none(), "nothing may be written");
}

#[test]
fn mcp_anchor_an_empty_source_is_refused_rather_than_replacing_the_body() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "", "X"),
        &source,
        &writer,
    ))
    .expect_err("an empty anchor would match everywhere");
    assert_eq!(error, McpToolError::EmptySource);
    assert!(writer.written().is_none(), "nothing may be written");
}

#[test]
fn mcp_anchor_a_failed_restore_point_blocks_the_edit() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::failing_snapshot();
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "beta", "BETA"),
        &source,
        &writer,
    ))
    .expect_err("no restore point, no write");
    assert_eq!(error, McpToolError::RestorePointFailed);
    assert_eq!(writer.calls(), vec!["snapshot:n1"]);
    assert!(writer.written().is_none(), "nothing may be written");
}

// ── an edit is not a move and not a delete ─────────────────────────────────

#[test]
fn mcp_anchor_an_edit_that_rewrites_the_folder_line_is_refused() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    // The passage is the note's own folder line, and the replacement walks the note
    // into a folder the grant never named. Without the clamp this would be a move
    // that no scope check ever saw.
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "folder: Projects/", "folder: Private/"),
        &source,
        &writer,
    ))
    .expect_err("an edit may not move a note");
    assert_eq!(error, McpToolError::EditWouldMove);
    assert!(writer.written().is_none(), "nothing may be written");
}

#[test]
fn mcp_anchor_an_edit_that_hides_the_note_is_refused() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    // Adding a trash marker is how an edit would delete a note through a surface
    // that has no delete verb.
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "title: Alpha", "trashed: 2026-10-30T00:00:00Z"),
        &source,
        &writer,
    ))
    .expect_err("an edit may not hide a note");
    assert_eq!(error, McpToolError::EditWouldHide);
    assert!(writer.written().is_none(), "nothing may be written");
}

// ── scope ──────────────────────────────────────────────────────────────────

#[test]
fn mcp_anchor_an_edit_outside_the_read_scope_is_refused() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Private/", BODY)]);
    let writer = Writer::ok();
    let error = block_on(note_edit(
        &read,
        &write,
        edit("n1", "beta", "BETA"),
        &source,
        &writer,
    ))
    .expect_err("a note the connection cannot read is not one it can edit");
    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "n1".into()
        }
    );
    assert!(writer.calls().is_empty());
}

#[test]
fn mcp_anchor_an_edit_in_a_readable_but_unwritable_folder_is_queued() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Inbox/", BODY)]);
    let writer = Writer::ok();
    let answer = block_on(note_edit(
        &read,
        &write,
        edit("n1", "beta", "BETA"),
        &source,
        &writer,
    ))
    .expect("readable but not writable is a proposal");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "inbox/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

// ── move ───────────────────────────────────────────────────────────────────

#[test]
fn mcp_anchor_a_move_rewrites_the_folder_line_inside_the_grant() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let answer = block_on(note_move(
        &read,
        &write,
        move_to("n1", "Archive"),
        &source,
        &writer,
    ))
    .expect("both folders are named for writing");
    match answer {
        WriteAnswer::Applied(moved) => {
            assert_eq!(moved.from, "projects/");
            assert_eq!(moved.to, "archive/");
        }
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
    let written = writer.written().expect("the write happened");
    // The shared move writes the folder without a trailing slash, which is the
    // shape every other note in the vault carries.
    assert!(written.contains("folder: Archive\n"), "{written}");
    // The body is untouched by a move.
    assert!(written.contains("alpha beta gamma"), "{written}");
}

#[test]
fn mcp_anchor_a_move_refuses_a_destination_outside_the_write_grant() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let answer = block_on(note_move(
        &read,
        &write,
        move_to("n1", "Inbox"),
        &source,
        &writer,
    ))
    .expect("a readable destination is a proposal");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "inbox/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_anchor_a_move_refuses_a_destination_the_connection_cannot_read() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let error = block_on(note_move(
        &read,
        &write,
        move_to("n1", "Private"),
        &source,
        &writer,
    ))
    .expect_err("a move into a folder it cannot read loses the note");
    assert_eq!(
        error,
        McpToolError::OutOfScopeFolder {
            folder: "private/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_anchor_a_move_refuses_a_source_folder_outside_the_write_grant() {
    // The note is READABLE but its current folder was not named for writing, so
    // taking it out of that folder is a write into the folder it leaves. The
    // destination is perfectly writable, which is what makes this case worth its own
    // test: a check on the destination alone would pass it.
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Inbox/", BODY)]);
    let writer = Writer::ok();
    let answer = block_on(note_move(
        &read,
        &write,
        move_to("n1", "Archive"),
        &source,
        &writer,
    ))
    .expect("the source folder is the one that decides");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "inbox/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_anchor_a_move_to_the_same_folder_is_refused() {
    let (read, write) = scopes();
    let source = Source::new(&[("n1", "Projects/", BODY)]);
    let writer = Writer::ok();
    let error = block_on(note_move(
        &read,
        &write,
        move_to("n1", "projects/"),
        &source,
        &writer,
    ))
    .expect_err("a move that moves nothing is a caller bug");
    // The shared module's own answer for it, mapped rather than invented here.
    assert_eq!(error, McpToolError::VaultUnavailable);
    assert!(writer.written().is_none(), "nothing may be written");
}
