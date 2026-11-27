// SPDX-License-Identifier: AGPL-3.0-only
//! The write verbs, over fakes that record the ORDER they were called in.
//!
//! ## Why the fakes record order
//!
//! Every acceptance criterion of task 14 except one is a property of a single
//! call, and would be green against a fake that answers fixed values. "A failed
//! snapshot blocks the write" is a property of the SEQUENCE, and it is the one the
//! contract exists for: a snapshot taken after the write keeps the new bytes, and a
//! test that only asserted the returned error would pass with the two calls swapped.
//! So [`Writer`] logs every call into a shared vector, and the assertions are about
//! what the log contains rather than only about what the verb returned.
//!
//! The disk-level half of that criterion (walk the vault afterwards) and the restore
//! half live in `src-tauri/src/cli_bridge/mcp_door_test.rs`, because they need a
//! real vault: a fake can prove the order, and only a real `snapshots/` directory
//! can prove that a restore returns the prior bytes.

use super::error::McpToolError;
use super::intent::{
    base_hash_hex, note_append, note_create, note_set_field, McpNoteWriter, NoteAppendRequest,
    NoteCreateRequest, NoteSetFieldRequest, RestorePoint, WriteAnswer,
};
use super::scope::{resolve_scope, ConnectionScope};
use super::tools::{note_facts_from_body, FileRow, McpNoteSource, NoteFacts, ViewRow};
use super::write_scope::resolve_write_scope;
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::calendar::CalendarRow;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::test_support::block_on;
use protocol::{McpConnectionGrant, McpScopeModel};
use std::collections::BTreeMap;
use std::sync::Mutex;

// ── fixtures ────────────────────────────────────────────────────────────────

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

/// A grant under the RETIRED allow-list model: it serves neither half.
fn legacy_grant(folders: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Folders,
        folders: folders.iter().map(|f| f.to_string()).collect(),
        excluded_folders: Vec::new(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: Vec::new(),
        disabled_verbs: Vec::new(),
    }
}

const NAME: &str = "claude-desktop";

/// The two scopes, resolved from one stored record, exactly as `call_tool` does it.
fn scopes(excluded: &[&str], write: &[&str]) -> (ConnectionScope, super::write_scope::WriteScope) {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(NAME.to_string(), grant(excluded, write));
    (resolve_scope(NAME, &map), resolve_write_scope(NAME, &map))
}

/// The scopes the common case uses: everything readable except `private/`, and
/// `projects/` named for writing.
fn readable_except_private_writable_projects() -> (ConnectionScope, super::write_scope::WriteScope)
{
    scopes(&["Private"], &["projects/"])
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

    async fn derived_note(&self, note_id: &str) -> Result<Option<NoteFacts>, McpToolError> {
        match self.read_body(note_id).await {
            Ok(body) => Ok(Some(note_facts_from_body(&body))),
            Err(McpToolError::UnknownNote { .. }) => Ok(None),
            Err(other) => Err(other),
        }
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

/// A writer that logs every call, in order, and answers what the test told it to.
struct Writer {
    /// `snapshot:<note>`, `create:<folder>`, `overwrite:<note>:<hash>` per call.
    log: Mutex<Vec<String>>,
    /// The plaintext the last overwrite was asked to write, so a test can assert
    /// what the note would have CONTAINED rather than only that it was written.
    written: Mutex<Option<String>>,
    /// What `capture_restore_point` answers. `None` is a capture that failed.
    snapshot: Result<RestorePoint, McpToolError>,
    /// What `overwrite_note` answers.
    overwrite: Result<(), McpToolError>,
}

impl Writer {
    fn ok() -> Self {
        Self {
            log: Mutex::new(Vec::new()),
            written: Mutex::new(None),
            snapshot: Ok(RestorePoint::Captured("snap".into())),
            overwrite: Ok(()),
        }
    }

    fn failing_snapshot() -> Self {
        Self {
            snapshot: Err(McpToolError::RestorePointFailed),
            ..Self::ok()
        }
    }

    fn changed_note() -> Self {
        Self {
            overwrite: Err(McpToolError::NoteChanged {
                note_id: "n1".into(),
            }),
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

    async fn set_field(
        &self,
        note: &str,
        view: &str,
        field: &str,
        expected_value: Option<&str>,
        value: &str,
    ) -> Result<(), McpToolError> {
        self.log.lock().expect("writer log").push(format!(
            "set_field:{note}:{view}:{field}={value}:expected={expected_value:?}"
        ));
        Ok(())
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
        self.overwrite.clone()
    }
}

fn create(folder: &str, title: &str) -> NoteCreateRequest {
    NoteCreateRequest {
        folder: folder.to_string(),
        title: title.to_string(),
        body: "Body text.".to_string(),
    }
}

fn append(note_id: &str, markdown: &str) -> NoteAppendRequest {
    NoteAppendRequest {
        note_id: note_id.to_string(),
        markdown: markdown.to_string(),
    }
}

// ── create ──────────────────────────────────────────────────────────────────

#[test]
fn mcp_intent_create_writes_into_a_folder_named_for_writing() {
    let (read, write) = readable_except_private_writable_projects();
    let writer = Writer::ok();
    let answer = block_on(note_create(
        &read,
        &write,
        create("Projects", "Quarterly"),
        &writer,
    ))
    .expect("a writable folder must apply");
    match answer {
        WriteAnswer::Applied(created) => {
            assert_eq!(created.note_id, "new-note");
            // The caller's own spelling, not the canonical key: the key decides
            // whether the write may happen, the spelling is what the note carries.
            assert_eq!(created.folder, "Projects/");
        }
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
    assert_eq!(writer.calls(), vec!["create:Projects/"]);
}

#[test]
fn mcp_intent_create_queues_a_folder_that_is_readable_but_not_named_for_writing() {
    let (read, write) = readable_except_private_writable_projects();
    let writer = Writer::ok();
    let answer = block_on(note_create(&read, &write, create("Inbox", "x"), &writer))
        .expect("a readable folder must queue, not refuse");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "inbox/".into()
        }
    );
    // Nothing was created: a queued proposal is a proposal.
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_create_refuses_a_folder_the_connection_cannot_read() {
    let (read, write) = readable_except_private_writable_projects();
    let writer = Writer::ok();
    let error = block_on(note_create(&read, &write, create("Private", "x"), &writer))
        .expect_err("a folder outside the read scope must be refused");
    assert_eq!(
        error,
        McpToolError::OutOfScopeFolder {
            folder: "private/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_create_refuses_when_the_write_grant_is_empty() {
    // The read scope covers everything; the write grant names nothing. This is the
    // state every connection starts in, and the one where reading this scope by
    // analogy with the deny list would grant writes to the whole vault.
    let (read, write) = scopes(&[], &[]);
    let writer = Writer::ok();
    let answer = block_on(note_create(&read, &write, create("Projects", "x"), &writer))
        .expect("a readable folder with no write grant queues");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "projects/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_create_refuses_a_legacy_grant_before_anything_else() {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(NAME.to_string(), legacy_grant(&["projects/"]));
    let read = resolve_scope(NAME, &map);
    let write = resolve_write_scope(NAME, &map);
    let writer = Writer::ok();
    let error = block_on(note_create(&read, &write, create("Projects", "x"), &writer))
        .expect_err("a retired grant serves neither half");
    assert_eq!(error, McpToolError::ReapprovalRequired);
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_create_refuses_an_empty_title() {
    let (read, write) = readable_except_private_writable_projects();
    let writer = Writer::ok();
    let error = block_on(note_create(
        &read,
        &write,
        create("Projects", "   "),
        &writer,
    ))
    .expect_err("a note with no title cannot be found again");
    assert_eq!(error, McpToolError::EmptyTitle);
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

// ── append ──────────────────────────────────────────────────────────────────

#[test]
fn mcp_intent_append_snapshots_before_it_writes() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "First line.\n")]);
    let writer = Writer::ok();
    let answer = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect("an append inside the grant applies");
    match answer {
        WriteAnswer::Applied(appended) => assert!(appended.appended_bytes > 0),
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
    let calls = writer.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(
        calls[0].starts_with("snapshot:n1"),
        "the restore point must come FIRST: {calls:?}"
    );
    assert!(calls[1].starts_with("overwrite:n1:"), "{calls:?}");
}

#[test]
fn mcp_intent_append_works_against_a_note_the_index_has_not_seen() {
    // The state a note is in between a create and the WebView's next index pass:
    // its bytes are on disk, the sidebar's record map has never heard of it. The
    // gate reads the note's own `folder:` instead, so the write verbs work in
    // sequence rather than only on notes somebody had already opened.
    let (read, write) = readable_except_private_writable_projects();
    let mut source = Source::new(&[(
        "n1",
        "Projects/",
        "---\nfolder: Projects/\n---\n\nFirst line.\n",
    )]);
    source.records.clear();
    let writer = Writer::ok();

    let answer = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect("an append to a note the index has not seen must still be gated and applied");

    match answer {
        WriteAnswer::Applied(appended) => assert!(appended.appended_bytes > 0),
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
}

#[test]
fn mcp_intent_an_unindexed_note_still_routes_by_its_own_folder() {
    let (read, write) = readable_except_private_writable_projects();
    // Readable, not named for writing: the answer is a proposal, and it is the
    // proposal for the folder the NOTE says it is in.
    let mut source = Source::new(&[("n1", "Inbox/", "---\nfolder: Inbox/\n---\n\nFirst line.\n")]);
    source.records.clear();
    let writer = Writer::ok();

    let answer = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect("an unindexed note in a readable folder is a proposal, not a refusal");

    match answer {
        WriteAnswer::Queued { folder } => assert_eq!(folder, "inbox/"),
        WriteAnswer::Applied(_) => panic!("a folder not named for writing must not apply"),
    }
    assert!(
        writer.calls().is_empty(),
        "a queued proposal wrote something: {:?}",
        writer.calls()
    );
}

#[test]
fn mcp_intent_an_unindexed_note_in_a_left_out_folder_is_refused() {
    // The exclusion must not have a hole exactly where the index has one.
    let (read, write) = readable_except_private_writable_projects();
    let mut source = Source::new(&[(
        "n1",
        "Private/",
        "---\nfolder: Private/\n---\n\nSecret line.\n",
    )]);
    source.records.clear();
    let writer = Writer::ok();

    let error = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "n1".into()
        },
        "a note in a left-out folder must be refused even when the index cannot say so"
    );
    assert!(writer.calls().is_empty(), "a refused write wrote something");
}

fn set_field(note_id: &str, view: &str, field: &str, value: &str) -> NoteSetFieldRequest {
    NoteSetFieldRequest {
        note_id: note_id.to_string(),
        view_id: view.to_string(),
        field: field.to_string(),
        value: value.to_string(),
        expected_value: None,
    }
}

#[test]
fn mcp_intent_set_field_snapshots_before_it_writes() {
    // The order is the security property the write half exists for: an external
    // write the user cannot undo is the one outcome this path may not produce, and
    // the host command captures its own snapshot only when its coalescing window
    // allows, so the forced one has to come first.
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "---\nfolder: Projects/\n---\n\nBody.\n")]);
    let writer = Writer::ok();

    let answer = block_on(note_set_field(
        &read,
        &write,
        set_field("n1", "view-1", "status", "done"),
        &source,
        &writer,
    ))
    .expect("a field write inside the grant applies");

    match answer {
        WriteAnswer::Applied(set) => {
            assert_eq!(set.field, "status");
            assert_eq!(set.folder, "projects/");
        }
        WriteAnswer::Queued { folder } => panic!("expected an apply, queued {folder}"),
    }
    let calls = writer.calls();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(
        calls[0].starts_with("snapshot:n1"),
        "the restore point must come FIRST: {calls:?}"
    );
    assert_eq!(
        calls[1], "set_field:n1:view-1:status=done:expected=None",
        "the view, the field and the absent-field precondition must reach the host: {calls:?}"
    );
}

#[test]
fn mcp_intent_set_field_refuses_a_folder_write_before_it_reads_the_note() {
    // Without this the verb is a move with only the note's CURRENT folder checked:
    // `folder` is not in the host's reserved list, so a view could declare it.
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "---\nfolder: Projects/\n---\n\nBody.\n")]);
    let writer = Writer::ok();

    let error = block_on(note_set_field(
        &read,
        &write,
        set_field("n1", "view-1", "folder", "Private/"),
        &source,
        &writer,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::EditWouldMove,
        "a folder field is a move, and note_move is the verb that checks the destination"
    );
    assert!(
        writer.calls().is_empty(),
        "a refused request took a snapshot or wrote: {:?}",
        writer.calls()
    );
}

#[test]
fn mcp_intent_set_field_refuses_every_working_set_marker() {
    // The host reserves three of the five; `template` and `conflict` are not in that
    // list, so the surface refuses all five for "no verb here can hide a note".
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "---\nfolder: Projects/\n---\n\nBody.\n")]);
    for field in crate::plugins::agent::hide::WORKING_SET_FIELDS {
        let writer = Writer::ok();
        let error = block_on(note_set_field(
            &read,
            &write,
            set_field("n1", "view-1", field, "true"),
            &source,
            &writer,
        ))
        .unwrap_err();
        assert_eq!(
            error,
            McpToolError::FieldReserved {
                field: field.to_string()
            },
            "{field} is a working-set marker and no verb here may set one"
        );
        assert!(writer.calls().is_empty(), "{field} reached the writer");
    }
}

#[test]
fn mcp_intent_a_write_to_a_hidden_note_the_index_has_not_seen_is_unknown() {
    // The read verbs answer `unknown_note` for a note the sidebar hides; the write
    // gate owes the same answer.
    let (read, write) = readable_except_private_writable_projects();
    let mut source = Source::new(&[(
        "gone",
        "Projects/",
        "---\nfolder: Projects/\ntrashed: 2026-08-16T10:00:00Z\n---\n\nBody.\n",
    )]);
    source.records.clear();
    let writer = Writer::ok();

    let error = block_on(note_append(
        &read,
        &write,
        append("gone", "more"),
        &source,
        &writer,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::UnknownNote {
            note_id: "gone".into()
        },
        "a trashed note the index has not seen must read as unknown here too"
    );
    assert!(writer.calls().is_empty(), "a hidden note was written to");
}

#[test]
fn mcp_intent_set_field_queues_a_readable_folder_not_named_for_writing() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Inbox/", "---\nfolder: Inbox/\n---\n\nBody.\n")]);
    let writer = Writer::ok();

    let answer = block_on(note_set_field(
        &read,
        &write,
        set_field("n1", "view-1", "status", "done"),
        &source,
        &writer,
    ))
    .expect("a readable folder is a proposal, not a refusal");

    match answer {
        WriteAnswer::Queued { folder } => assert_eq!(folder, "inbox/"),
        WriteAnswer::Applied(_) => panic!("a folder not named for writing must not apply"),
    }
    assert!(
        writer.calls().is_empty(),
        "a queued proposal wrote something: {:?}",
        writer.calls()
    );
}

#[test]
fn mcp_intent_set_field_refuses_a_note_outside_the_read_grant() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Private/", "---\nfolder: Private/\n---\n\nBody.\n")]);
    let writer = Writer::ok();

    let error = block_on(note_set_field(
        &read,
        &write,
        set_field("n1", "view-1", "status", "done"),
        &source,
        &writer,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "n1".into()
        },
        "a folder the connection cannot read is a folder it cannot write"
    );
    assert!(writer.calls().is_empty(), "a refused write wrote something");
}

#[test]
fn mcp_intent_a_failed_snapshot_blocks_the_write() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "First line.\n")]);
    let writer = Writer::failing_snapshot();
    let error = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect_err("a write the user cannot undo must not happen");
    assert_eq!(error, McpToolError::RestorePointFailed);
    // The assertion that matters: no overwrite was attempted. A test that only
    // checked the returned error would pass with the two calls in the wrong order.
    assert_eq!(writer.calls(), vec!["snapshot:n1"]);
}

#[test]
fn mcp_intent_the_base_hash_is_the_hash_of_the_bytes_that_were_read() {
    let (read, write) = readable_except_private_writable_projects();
    let body = "First line.\n";
    let source = Source::new(&[("n1", "Projects/", body)]);
    let writer = Writer::ok();
    block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect("applies");
    let calls = writer.calls();
    assert_eq!(
        calls[1],
        format!("overwrite:n1:{}", base_hash_hex(body)),
        "the guard must be over the bytes this call read, not the bytes it writes"
    );
}

#[test]
fn mcp_intent_a_note_that_changed_between_the_read_and_the_write_is_refused() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "First line.\n")]);
    let writer = Writer::changed_note();
    let error = block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect_err("a stale base must be refused");
    assert_eq!(
        error,
        McpToolError::NoteChanged {
            note_id: "n1".into()
        }
    );
}

#[test]
fn mcp_intent_append_refuses_a_note_outside_the_read_scope() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Private/", "Secret.\n")]);
    let writer = Writer::ok();
    let error = block_on(note_append(
        &read,
        &write,
        append("n1", "more"),
        &source,
        &writer,
    ))
    .expect_err("a note the connection cannot read is not one it can write");
    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "n1".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_append_queues_a_readable_folder_that_is_not_writable() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Inbox/", "Hello.\n")]);
    let writer = Writer::ok();
    let answer = block_on(note_append(
        &read,
        &write,
        append("n1", "more"),
        &source,
        &writer,
    ))
    .expect("readable but not writable queues");
    assert_eq!(
        answer,
        WriteAnswer::Queued {
            folder: "inbox/".into()
        }
    );
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

#[test]
fn mcp_intent_append_refuses_an_unknown_note() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[]);
    let writer = Writer::ok();
    let error = block_on(note_append(
        &read,
        &write,
        append("gone", "more"),
        &source,
        &writer,
    ))
    .expect_err("an unknown note is refused before the scope");
    assert_eq!(
        error,
        McpToolError::UnknownNote {
            note_id: "gone".into()
        }
    );
}

#[test]
fn mcp_intent_append_refuses_an_empty_markdown() {
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "First.\n")]);
    let writer = Writer::ok();
    let error = block_on(note_append(
        &read,
        &write,
        append("n1", "  \n "),
        &source,
        &writer,
    ))
    .expect_err("an append that changes nothing reports a change that did not happen");
    assert_eq!(error, McpToolError::EmptyAppend);
    assert!(writer.calls().is_empty(), "{:?}", writer.calls());
}

// ── the append shape, and the hash both sides agree on ─────────────────────

#[test]
fn mcp_intent_an_append_is_separated_from_the_existing_text_by_one_blank_line() {
    // The separation rule belongs to `agent::edit::append`, which this verb calls
    // rather than reimplements, so what is asserted here is that the RULE reaches the
    // write: one blank line, never a paragraph glued onto the last one.
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "First line.\n")]);
    let writer = Writer::ok();
    block_on(note_append(
        &read,
        &write,
        append("n1", "Second line."),
        &source,
        &writer,
    ))
    .expect("applies");
    let written = writer.written().expect("the write happened");
    assert_eq!(written, "First line.\n\nSecond line.\n");
}

#[test]
fn mcp_intent_an_append_lands_after_the_frontmatter_and_never_authors_it() {
    // The hazard a hand-written append re-opens: text pushed onto the end of the
    // FILE rather than the end of the BODY. A note that already has frontmatter must
    // still have exactly the same block after an append that itself looks like one.
    let (read, write) = readable_except_private_writable_projects();
    let source = Source::new(&[("n1", "Projects/", "---\ntitle: Alpha\n---\nBody.\n")]);
    let writer = Writer::ok();
    block_on(note_append(
        &read,
        &write,
        append("n1", "---\ntitle: Appended\n---\nMore."),
        &source,
        &writer,
    ))
    .expect("applies");
    let written = writer.written().expect("the write happened");
    assert!(
        written.starts_with("---\ntitle: Alpha\n---\n"),
        "the note's own block must be untouched and still first: {written}"
    );
    assert!(
        written.contains("Body.\n\n---\ntitle: Appended"),
        "the appended text must land in the body, after the existing block: {written}"
    );
}

#[test]
fn mcp_intent_the_base_hash_is_the_sha256_the_client_computes() {
    // Same value `src/notes/baseHash.ts` produces with `crypto.subtle.digest`:
    // SHA-256 over the plaintext's UTF-8 bytes, lowercase hex. The two must agree
    // or every guarded write is refused as a stale base.
    assert_eq!(
        base_hash_hex(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        base_hash_hex("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    // A multi-byte character hashes as its UTF-8 bytes, not as its code points.
    assert_eq!(
        base_hash_hex("ı"),
        "544bc1a8b6aad8d7553a578c8602fb5ea913a8a118c13900fa2a36c80880899a"
    );
}
