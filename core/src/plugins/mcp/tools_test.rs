// SPDX-License-Identifier: AGPL-3.0-only
//! The four read tools, clamped per tool.
//!
//! One clamping test per tool rather than one for the family, because four
//! independent clamps are four independent chances to be wrong. The set-addressed
//! tools (search, list) are asserted to EXCLUDE what is outside the scope; the
//! note-addressed one (read) is asserted to REFUSE with a named cause.

use super::error::McpToolError;
use super::scope::{resolve_scope, ConnectionScope};
use super::tools::{
    attachment_list, attachment_read, calendar_read, call_tool, excerpt, note_facts_from_body,
    note_read, note_search, vault_list, vault_state, view_list, AttachmentListRequest,
    AttachmentReadRequest, CalendarReadRequest, CallInputs, FileRow, McpCallOutcome, McpNoteSource,
    NoteFacts, NoteReadRequest, NoteSearchRequest, ViewRow, WireCall, MAX_EXCERPT_BYTES,
    MAX_SEARCH_LIMIT,
};
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::calendar::CalendarRow;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::test_support::block_on;
use protocol::{McpConnectionGrant, McpScopeModel};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

// ── fixtures ────────────────────────────────────────────────────────────────

fn record(folder: Option<&str>, title: &str) -> NoteRecord {
    NoteRecord {
        title: Some(title.to_string()),
        folder: folder.map(|f| f.to_string()),
        ..Default::default()
    }
}

/// A grant in the model this build writes: the folders named here are the ones
/// the connection may NOT read.
fn grant(excluded: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: Vec::new(),
        disabled_verbs: Vec::new(),
    }
}

/// A grant in the RETIRED allow-list model, as a pre-downgrade build left it on
/// disk: `folders` is the connection's whole reach.
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

fn scope_for(name: &str, excluded: &[&str]) -> ConnectionScope {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(name.to_string(), grant(excluded));
    resolve_scope(name, &map)
}

/// The scope most tests use: everything readable except `Private`.
fn scope() -> ConnectionScope {
    scope_for("claude-desktop", &["Private"])
}

/// The existing folder set the fixtures describe, as the tools receive it.
fn existing() -> std::collections::BTreeSet<String> {
    [
        "".to_string(),
        "private/".to_string(),
        "projects/".to_string(),
    ]
    .into_iter()
    .collect()
}

/// A source over in-memory maps, recording the search limits it was asked for.
struct Source {
    records: BTreeMap<String, NoteRecord>,
    bodies: BTreeMap<String, String>,
    /// Ranked hits whose records are all in the map, in rank order.
    ranked: Vec<String>,
    limits: Mutex<Vec<usize>>,
    /// The attachments catalog, as `catalog_list` answers it.
    files: Vec<FileRow>,
    /// Extracted text by attachment id. A missing id is a file nothing was
    /// extracted from, which is `None` rather than an error.
    file_texts: BTreeMap<String, String>,
    /// The calendar the fake answers with, whatever window it is asked for.
    calendar_rows: Vec<CalendarRow>,
    /// Every window the fake was asked for, so a test can assert the bound.
    calendar_calls: Mutex<Vec<(String, String)>>,
    /// The stored views.
    views: Vec<ViewRow>,
}

impl Source {
    fn new(pairs: &[(&str, Option<&str>, &str)]) -> Self {
        let mut records = BTreeMap::new();
        let mut bodies = BTreeMap::new();
        for (id, folder, body) in pairs {
            records.insert(
                (*id).to_string(),
                record(*folder, &format!("title of {id}")),
            );
            bodies.insert((*id).to_string(), (*body).to_string());
        }
        Self {
            records,
            bodies,
            ranked: pairs.iter().map(|(id, _, _)| (*id).to_string()).collect(),
            limits: Mutex::new(Vec::new()),
            files: Vec::new(),
            file_texts: BTreeMap::new(),
            calendar_rows: Vec::new(),
            calendar_calls: Mutex::new(Vec::new()),
            views: Vec::new(),
        }
    }

    fn limits(&self) -> Vec<usize> {
        self.limits.lock().expect("limits lock").clone()
    }

    /// Simulate the state the door is in between a write and the WebView's next
    /// index pass: the note's bytes are there, the sidebar's record is not.
    fn hide_record(&mut self, id: &str) {
        self.records.remove(id);
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl McpNoteSource for Source {
    async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError> {
        Ok(self.records.clone())
    }

    /// The real adapter's rule, over the same helpers: a note the index has not
    /// seen is answered from its own bytes, and only a missing body is absence.
    async fn derived_note(&self, note_id: &str) -> Result<Option<NoteFacts>, McpToolError> {
        match self.read_body(note_id).await {
            Ok(body) => Ok(note_facts_from_body(&body)),
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

    async fn search(&self, _query: &str, limit: usize) -> Result<Vec<SearchHit>, McpToolError> {
        self.limits.lock().expect("limits lock").push(limit);
        Ok(self
            .ranked
            .iter()
            .take(limit)
            .map(|id| SearchHit {
                note_id: id.clone(),
                score: 1.0,
            })
            .collect())
    }

    async fn files(&self) -> Result<Vec<FileRow>, McpToolError> {
        Ok(self.files.clone())
    }

    async fn file_text(&self, attachment_id: &str) -> Result<Option<String>, McpToolError> {
        Ok(self.file_texts.get(attachment_id).cloned())
    }

    async fn calendar(&self, from: &str, to: &str) -> Result<Vec<CalendarRow>, McpToolError> {
        self.calendar_calls
            .lock()
            .expect("calendar lock")
            .push((from.to_string(), to.to_string()));
        Ok(self.calendar_rows.clone())
    }

    async fn views(&self) -> Result<Vec<ViewRow>, McpToolError> {
        Ok(self.views.clone())
    }
}

fn search(query: &str) -> NoteSearchRequest {
    NoteSearchRequest {
        query: query.to_string(),
        folder: None,
        limit: None,
    }
}

// ── the no-grant refusal, per tool ─────────────────────────────────────────

#[test]
fn every_tool_refuses_a_connection_with_no_grant() {
    // A grant EXISTS on this device, for another name: the refusal is about this
    // connection, not about an empty vault.
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert("claude-desktop".into(), grant(&["Projects"]));
    let none = resolve_scope("stranger", &map);
    let source = Source::new(&[("a", Some("Projects"), "body")]);

    assert_eq!(
        block_on(note_search(&none, search("x"), &source)).unwrap_err(),
        McpToolError::NoGrant
    );
    assert_eq!(
        block_on(note_read(
            &none,
            NoteReadRequest {
                note_id: "a".into()
            },
            &source
        ))
        .unwrap_err(),
        McpToolError::NoGrant
    );
    assert_eq!(
        block_on(vault_list(&none, &source)).unwrap_err(),
        McpToolError::NoGrant
    );
    assert_eq!(
        block_on(vault_state(&none, &existing(), &source)).unwrap_err(),
        McpToolError::NoGrant
    );
}

// ── one clamp per tool ─────────────────────────────────────────────────────

#[test]
fn search_excludes_a_note_outside_the_scope_even_when_it_ranks_first() {
    // `secret` is ranked first. A search that answered with it would leak its
    // existence (and its excerpt) to a connection that may not read it.
    let source = Source::new(&[
        ("secret", Some("Private"), "the private thing"),
        ("visible", Some("Projects"), "the visible thing"),
    ]);
    let rows = block_on(note_search(&scope(), search("thing"), &source)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].note_id, "visible");
}

#[test]
fn read_refuses_a_note_outside_the_scope_with_a_named_cause() {
    let source = Source::new(&[("secret", Some("Private"), "the private thing")]);
    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "secret".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "secret".into()
        }
    );
    assert_eq!(error.reason(), "out_of_scope");
}

#[test]
fn read_rechecks_the_folder_from_the_note_itself() {
    // The index says Projects; the note's own frontmatter says Private. The body
    // wins, because a move that landed after the snapshot is exactly the case
    // this tool can see and the index cannot.
    let source = Source::new(&[("moved", Some("Projects"), "---\nfolder: Private\n---\nx")]);
    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "moved".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert!(matches!(error, McpToolError::OutOfScopeNote { .. }));
}

#[test]
fn a_folder_value_two_readers_disagree_about_is_not_guessed_at() {
    // `fm_folder` keeps a trailing `# comment`, the field write's parser strips it,
    // and the judged reader is the app's YAML one: `Private`. Declining beats
    // placing a note outside the exclusion the user set.
    let facts = note_facts_from_body("---\nfolder: Private #x\n---\nx");
    assert!(
        facts.is_none(),
        "a disputed folder must derive nothing: {facts:?}"
    );
    // Both readers declining is not agreement either: a block scalar resolves to a
    // real folder in the app, and `None` here would mean the vault root.
    let facts = note_facts_from_body("---\nfolder: |-\n  Private\n---\nx");
    assert!(
        facts.is_none(),
        "an unreadable folder must derive nothing: {facts:?}"
    );
    // A value both readers agree on still derives, or the fallback would be dead.
    let facts = note_facts_from_body("---\nfolder: Projects\n---\nx")
        .expect("a plain folder value derives");
    assert_eq!(facts.folder.as_deref(), Some("Projects"));
}

#[test]
fn list_names_only_the_folders_in_scope_and_carries_no_note_text() {
    let source = Source::new(&[
        ("a", Some("Projects"), "body a"),
        ("b", Some("Projects"), "body b"),
        ("secret", Some("Private"), "body c"),
    ]);
    let rows = block_on(vault_list(&scope(), &source)).unwrap();
    assert_eq!(rows.len(), 1, "the Private folder is not listed at all");
    assert_eq!(rows[0].count, 2);

    // The wire shape is the contract: a title or an id here would be note
    // content the caller cannot read.
    let wire = serde_json::to_value(&rows).unwrap();
    let keys: Vec<&String> = wire[0].as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["count", "folder"], "got {wire}");
}

#[test]
fn state_counts_only_what_the_scope_covers_and_names_no_excluded_folder() {
    let source = Source::new(&[
        ("a", Some("Projects"), "body"),
        ("b", Some("Private"), "body"),
        ("c", None, "body"),
    ]);
    let state = block_on(vault_state(&scope(), &existing(), &source)).unwrap();
    assert_eq!(
        state.folder_count, 2,
        "the root and Projects are readable, Private is not"
    );
    assert_eq!(state.note_count, 2, "the Projects note and the root note");
    assert_eq!(
        state.excluded_folder_count, 1,
        "the Private folder exists and is excluded: a count, never a name"
    );
    assert_eq!(state.stale_exclusion_count, 0);
    assert!(state.unlocked && state.external_access);

    // The count is what the caller learns; the excluded folder's NAME is the
    // user's own text and travels nowhere near this payload.
    let wire = serde_json::to_value(&state).unwrap();
    assert!(
        !wire.to_string().contains("private"),
        "the state payload must not carry an excluded folder name: {wire}"
    );
}

// ── the search bounds ──────────────────────────────────────────────────────

#[test]
fn search_returns_an_excerpt_and_not_a_full_body() {
    let body = format!(
        "---\nfolder: Projects\n---\n{}needle{}",
        "a".repeat(400),
        "b".repeat(400)
    );
    let source = Source::new(&[("a", Some("Projects"), &body)]);
    let rows = block_on(note_search(&scope(), search("needle"), &source)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_ne!(rows[0].excerpt, body, "the excerpt is not the note");
    assert!(
        rows[0].excerpt.contains("needle"),
        "the excerpt must show the match: {}",
        rows[0].excerpt
    );
    assert!(
        !rows[0].excerpt.contains('\n'),
        "an excerpt is one line: a newline forges a line in the caller's transcript"
    );
}

#[test]
fn the_excerpt_is_bounded_against_a_note_far_larger_than_the_bound() {
    let mut body = String::from("---\nfolder: Projects\n---\n");
    body.push_str(&"x".repeat(200_000));
    body.push_str("needle");
    body.push_str(&"y".repeat(200_000));
    let source = Source::new(&[("a", Some("Projects"), &body)]);
    let rows = block_on(note_search(&scope(), search("needle"), &source)).unwrap();
    let excerpt = &rows[0].excerpt;
    assert!(
        excerpt.len() <= MAX_EXCERPT_BYTES,
        "{} bytes is over the {MAX_EXCERPT_BYTES}-byte cap",
        excerpt.len()
    );
    assert!(excerpt.contains("needle"));
    assert!(
        excerpt.starts_with('\u{2026}'),
        "a window cut at the front says so"
    );
}

#[test]
fn an_empty_query_is_refused_rather_than_enumerating_the_scope() {
    let source = Source::new(&[("a", Some("Projects"), "body")]);
    for query in ["", "   ", "\n\t"] {
        assert_eq!(
            block_on(note_search(&scope(), search(query), &source)).unwrap_err(),
            McpToolError::EmptyQuery
        );
    }
    assert!(
        source.limits().is_empty(),
        "a refused query never reaches the ranker"
    );
}

#[test]
fn the_result_limit_is_clamped_to_the_ceiling() {
    let ids: Vec<String> = (0..100).map(|i| format!("n{i}")).collect();
    let pairs: Vec<(&str, Option<&str>, &str)> = ids
        .iter()
        .map(|id| (id.as_str(), Some("Projects"), "body"))
        .collect();
    let source = Source::new(&pairs);
    let rows = block_on(note_search(
        &scope(),
        NoteSearchRequest {
            query: "body".into(),
            folder: None,
            limit: Some(10_000),
        },
        &source,
    ))
    .unwrap();
    assert_eq!(rows.len(), MAX_SEARCH_LIMIT);
}

#[test]
fn a_folder_argument_narrows_the_scope_and_cannot_widen_it() {
    let source = Source::new(&[
        ("a", Some("Projects"), "body"),
        ("b", Some("Projects/Deep"), "body"),
        ("c", Some("Private"), "body"),
    ]);
    // The folder argument can only narrow: `Private` is excluded, so asking for
    // it is refused rather than answered as an empty result.
    let scope = scope_for("a", &["Private"]);
    let narrowed = block_on(note_search(
        &scope,
        NoteSearchRequest {
            query: "body".into(),
            folder: Some("Projects/Deep".into()),
            limit: None,
        },
        &source,
    ))
    .unwrap();
    assert_eq!(
        narrowed
            .iter()
            .map(|r| r.note_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b"]
    );

    let error = block_on(note_search(
        &scope,
        NoteSearchRequest {
            query: "body".into(),
            folder: Some("Private".into()),
            limit: None,
        },
        &source,
    ))
    .unwrap_err();
    assert!(matches!(error, McpToolError::OutOfScopeFolder { .. }));
}

// ── the scope is never read from the payload ───────────────────────────────

#[test]
fn a_payload_cannot_carry_a_scope_of_its_own() {
    // `deny_unknown_fields` makes the attempt a malformed call rather than a
    // silently ignored field. Both rejected shapes are the two a client would
    // plausibly try: a folder list and a "read everywhere" marker.
    for payload in [
        json!({ "query": "x", "scope": ["Private"] }),
        json!({ "query": "x", "folders": ["/"] }),
        json!({ "query": "x", "read_anywhere": true }),
    ] {
        assert!(
            serde_json::from_value::<NoteSearchRequest>(payload.clone()).is_err(),
            "{payload} must not deserialize: the scope comes from the grant"
        );
    }
    assert!(serde_json::from_value::<NoteReadRequest>(json!({
        "note_id": "n",
        "scope": ["Private"]
    }))
    .is_err());

    // And the real refusal still holds for a note the caller names directly.
    let source = Source::new(&[("secret", Some("Private"), "x")]);
    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "secret".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert!(matches!(error, McpToolError::OutOfScopeNote { .. }));
}

// ── the granted folder grows with the vault's notes, not with the grant ────

#[test]
fn a_note_created_after_approval_is_readable_without_re_approval() {
    let mut source = Source::new(&[("old", Some("Projects"), "the old note")]);
    // The user writes a new note into the folder they already approved. Its
    // body carries the folder, as every real note in `Projects` does.
    source
        .records
        .insert("new".into(), record(Some("Projects"), "a new note"));
    source.bodies.insert(
        "new".into(),
        "---\nfolder: Projects\n---\nthe new note".into(),
    );

    let read = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "new".into(),
        },
        &source,
    ))
    .unwrap();
    assert!(read.body.ends_with("the new note"));
}

// ── the seams' own failure paths ───────────────────────────────────────────

#[test]
fn a_hit_whose_note_vanished_is_dropped_rather_than_failing_the_search() {
    let mut source = Source::new(&[
        ("gone", Some("Projects"), "x"),
        ("here", Some("Projects"), "y"),
    ]);
    // The index still lists `gone`, but the body is no longer readable: the note
    // was deleted between the snapshot and the read.
    source.bodies.remove("gone");
    let rows = block_on(note_search(&scope(), search("y"), &source)).unwrap();
    assert_eq!(
        rows.iter().map(|r| r.note_id.as_str()).collect::<Vec<_>>(),
        vec!["here"]
    );
}

#[test]
fn an_unknown_note_id_is_not_the_same_refusal_as_an_out_of_scope_one() {
    let source = Source::new(&[("a", Some("Projects"), "x")]);
    let unknown = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "nope".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert_eq!(
        unknown,
        McpToolError::UnknownNote {
            note_id: "nope".into()
        }
    );
    assert_ne!(unknown.reason(), McpToolError::NoGrant.reason());
}

#[test]
fn the_excerpt_of_a_note_shorter_than_the_bound_is_the_note_s_flattened_opening() {
    // Not an error state: a short note's excerpt IS its text. What the cap
    // promises is that the cost per hit is bounded, which is asserted above.
    let text = excerpt("first line\nsecond line", "second");
    assert!(text.len() <= MAX_EXCERPT_BYTES);
    assert!(!text.contains('\n'));
    assert!(text.contains("second line"));
}

#[test]
fn control_characters_never_reach_an_excerpt() {
    let text = excerpt("body\u{0}with\u{7}controls here", "controls");
    assert!(
        !text.chars().any(char::is_control),
        "a control character survived: {text:?}"
    );
}

// ── the working set: liveness, at the clamp rather than in the source ───────

#[test]
fn a_search_hides_a_note_outside_the_live_working_set() {
    // The index producer indexes every `.myn`, so a trashed note still has a
    // record and still ranks. It must not become a ROW: the sidebar does not show
    // it, and an external connection is a second surface over the same working
    // set, not a wider one.
    let mut source = Source::new(&[
        ("live", Some("Projects"), "alpha in a live note"),
        ("trashed", Some("Projects"), "alpha in a trashed note"),
    ]);
    source.records.get_mut("trashed").expect("record").live = false;

    let rows = block_on(note_search(&scope(), search("alpha"), &source)).expect("search");

    let ids: Vec<&str> = rows.iter().map(|row| row.note_id.as_str()).collect();
    assert_eq!(ids, vec!["live"], "a trashed note came back: {ids:?}");
}

#[test]
fn a_read_of_a_trashed_note_is_indistinguishable_from_an_unknown_one() {
    // Not `out_of_scope`: that would tell the caller the note exists. The CLI
    // door answers this same case as `not_found` for exactly this reason.
    let mut source = Source::new(&[("trashed", Some("Projects"), "body")]);
    source.records.get_mut("trashed").expect("record").live = false;

    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "trashed".into(),
        },
        &source,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::UnknownNote {
            note_id: "trashed".into()
        },
        "a trashed note must read as an unknown one, not as an out-of-scope one"
    );
}

/// The write half, for the tests that only care what the envelope looks like: the
/// gates have their own suites, this one drives every verb to an ANSWER.
struct Writer;

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
impl super::intent::McpNoteWriter for Writer {
    async fn capture_restore_point(
        &self,
        _note: &str,
    ) -> Result<super::intent::RestorePoint, McpToolError> {
        Ok(super::intent::RestorePoint::Captured("snap".into()))
    }

    async fn create_note(
        &self,
        _folder: &str,
        _title: &str,
        _body: &str,
    ) -> Result<String, McpToolError> {
        Ok("created".into())
    }

    async fn set_field(
        &self,
        _note: &str,
        _view: &str,
        _field: &str,
        _expected_value: Option<&str>,
        _value: &str,
    ) -> Result<(), McpToolError> {
        Ok(())
    }

    async fn overwrite_note(
        &self,
        _note: &str,
        _plaintext: &str,
        _expected_base_hash_hex: &str,
    ) -> Result<(), McpToolError> {
        Ok(())
    }
}

/// The same inputs, with a write surface behind them.
fn inputs_with_writer<'a>(
    grants: &'a BTreeMap<String, McpConnectionGrant>,
    connection: &'a str,
    tool: &'a str,
    arguments: &'a serde_json::Value,
    writer: &'a dyn super::intent::McpNoteWriter,
) -> CallInputs<'a> {
    CallInputs {
        writer: Some(writer),
        ..inputs(grants, connection, tool, arguments)
    }
}

// ── the index lags, the note does not ─────────────────────────────────────
//
// When the record map has no id, the note's own bytes answer the clamps
// (myne-md/myne#1230).

#[test]
fn a_note_the_index_has_not_seen_is_still_readable() {
    let mut source = Source::new(&[("fresh", Some("Projects"), "alpha body")]);
    source.hide_record("fresh");

    let answer = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "fresh".into(),
        },
        &source,
    ))
    .expect("a note on disk with no index record must still read");

    assert_eq!(answer.body, "alpha body");
}

#[test]
fn a_note_the_index_has_not_seen_is_still_findable() {
    // The body carries the folder: the record that would have is what is missing.
    let mut source = Source::new(&[(
        "fresh",
        Some("Projects"),
        "---\ntitle: Fresh report\nfolder: Projects\n---\n\nalpha body",
    )]);
    source.hide_record("fresh");

    let rows = block_on(note_search(&scope(), search("alpha"), &source)).expect("search");

    let ids: Vec<&str> = rows.iter().map(|row| row.note_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["fresh"],
        "the agent's own note was dropped from its own search: {ids:?}"
    );
    assert_eq!(
        rows[0].folder.as_deref(),
        Some("Projects"),
        "the row's folder is the note's own, in the shape an indexed row carries it"
    );
    assert_eq!(
        rows[0].title.as_deref(),
        Some("Fresh report"),
        "the row's title is the note's own `title:`, not a blank"
    );
}

#[test]
fn a_note_the_index_has_not_seen_but_the_note_says_is_trashed_is_unknown() {
    // The derived arm owes the indexed one's answer: a note the index has not seen
    // must not become a way to read what the sidebar hid.
    let mut source = Source::new(&[(
        "gone",
        Some("Projects"),
        "---\ntrashed: 2026-08-16T10:00:00Z\n---\n\nalpha body",
    )]);
    source.hide_record("gone");

    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "gone".into(),
        },
        &source,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::UnknownNote {
            note_id: "gone".into()
        },
        "a trashed note the index has not seen must read as unknown, not as a note"
    );
}

#[test]
fn a_note_the_index_has_not_seen_is_clamped_by_its_own_folder() {
    // `Private` is the folder the grant leaves out. The index cannot say so here, so
    // the frontmatter has to — or the exclusion would apply to everything except
    // the notes nobody had indexed yet.
    let mut source = Source::new(&[(
        "hidden",
        Some("Private"),
        "---\nfolder: Private\n---\n\nalpha body",
    )]);
    source.hide_record("hidden");

    let error = block_on(note_read(
        &scope(),
        NoteReadRequest {
            note_id: "hidden".into(),
        },
        &source,
    ))
    .unwrap_err();

    assert_eq!(
        error,
        McpToolError::OutOfScopeNote {
            note_id: "hidden".into()
        },
        "an unindexed note in a left-out folder must be refused, not read"
    );
}

// ── the call surface: one entry point, four ordered decisions ──────────────

fn grants(pairs: &[(&str, &[&str])]) -> BTreeMap<String, McpConnectionGrant> {
    pairs
        .iter()
        .map(|(name, folders)| ((*name).to_string(), grant(folders)))
        .collect()
}

fn inputs<'a>(
    grants: &'a BTreeMap<String, McpConnectionGrant>,
    connection: &'a str,
    tool: &'a str,
    arguments: &'a serde_json::Value,
) -> CallInputs<'a> {
    CallInputs {
        call: WireCall {
            connection,
            tool,
            arguments,
        },
        grants,
        deliberate_folders: &[],
        archived_folders: &[],
        quiet_folders: &[],
        writer: None,
        // Each call gets its OWN ledger, leaked on purpose: a shared one would make
        // every test in this file spend the same budget and a test that reads a note
        // twice would depend on how many tests ran before it. A test that wants to
        // see the budget refuse builds an exhausted ledger itself.
        // A fixed reading: the tests drive the budget arithmetic themselves, and a
        // real clock here would make the window tests time-dependent.
        now_ms: 0,
        budget: Box::leak(Box::new(std::sync::Mutex::new(
            super::budget::BudgetLedger::default(),
        ))),
    }
}

#[test]
fn a_connection_with_no_grant_is_refused_before_the_vault_is_read() {
    // The source below panics on every question, so an empty `records` answer
    // cannot hide the ordering: `no_grant` has to come from the grants map alone.
    struct Unreachable;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl McpNoteSource for Unreachable {
        async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError> {
            panic!("a connection with no grant must not read the index");
        }
        async fn read_body(&self, _note_id: &str) -> Result<String, McpToolError> {
            panic!("a connection with no grant must not read a note");
        }
        async fn search(
            &self,
            _query: &str,
            _limit: usize,
        ) -> Result<Vec<SearchHit>, McpToolError> {
            panic!("a connection with no grant must not search");
        }

        async fn files(&self) -> Result<Vec<FileRow>, McpToolError> {
            panic!("a connection with no grant must not read the attachments catalog");
        }
        async fn file_text(&self, _attachment_id: &str) -> Result<Option<String>, McpToolError> {
            panic!("a connection with no grant must not read a file");
        }
        async fn calendar(&self, _from: &str, _to: &str) -> Result<Vec<CalendarRow>, McpToolError> {
            panic!("a connection with no grant must not read the calendar");
        }
        async fn views(&self) -> Result<Vec<ViewRow>, McpToolError> {
            panic!("a connection with no grant must not read the views");
        }
    }

    let map = grants(&[("claude-desktop", &["Projects"])]);
    let arguments = json!({ "query": "alpha" });
    // `unnamed-client` is what the shim sends for a client configured by hand
    // with no `MYNE_MCP_CONNECTION`: a name no approval can produce by accident.
    for name in ["unnamed-client", "", "claude-desktop-2"] {
        assert_eq!(
            block_on(call_tool(
                inputs(&map, name, "note_search", &arguments),
                &Unreachable
            )),
            McpCallOutcome::Refused(McpToolError::NoGrant),
            "{name} was not refused"
        );
    }
}

#[test]
fn an_unimplemented_verb_is_version_skew_rather_than_a_scope_refusal() {
    let map = grants(&[("claude-desktop", &["Projects"])]);
    let source = Source::new(&[("a", Some("Projects"), "alpha")]);
    // Verbs this build does not serve at all: a name a NEWER shim could send once a
    // fourteenth verb lands there, a verb the surface will never have, and garbage.
    // A shim newer than its host is version skew, and skew is not a scope refusal.
    for tool in ["note_delete", "delete", ""] {
        let arguments = json!({ "body": "x" });
        assert_eq!(
            block_on(call_tool(
                inputs(&map, "claude-desktop", tool, &arguments),
                &source
            )),
            McpCallOutcome::UnknownTool,
            "{tool} was not reported as an unknown verb"
        );
    }
    // And the four that ARE served are not version skew, whatever else they answer:
    // parse_arguments runs after the verb lookup, so a served verb with wrong
    // arguments is `Malformed` and never `UnknownTool`.
    for tool in ["note_create", "note_append", "note_edit", "note_move"] {
        let arguments = json!({ "body": "x" });
        assert_eq!(
            block_on(call_tool(
                inputs(&map, "claude-desktop", tool, &arguments),
                &source
            )),
            McpCallOutcome::Malformed,
            "{tool} must be served as malformed rather than as version skew"
        );
    }
}

#[test]
fn malformed_arguments_are_refused_before_the_vault_is_read() {
    struct Unreachable;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl McpNoteSource for Unreachable {
        async fn records(&self) -> Result<BTreeMap<String, NoteRecord>, McpToolError> {
            panic!("malformed arguments must not read the index");
        }
        async fn read_body(&self, _note_id: &str) -> Result<String, McpToolError> {
            panic!("malformed arguments must not read a note");
        }
        async fn search(
            &self,
            _query: &str,
            _limit: usize,
        ) -> Result<Vec<SearchHit>, McpToolError> {
            panic!("malformed arguments must not search");
        }

        async fn files(&self) -> Result<Vec<FileRow>, McpToolError> {
            panic!("a connection with no grant must not read the attachments catalog");
        }
        async fn file_text(&self, _attachment_id: &str) -> Result<Option<String>, McpToolError> {
            panic!("a connection with no grant must not read a file");
        }
        async fn calendar(&self, _from: &str, _to: &str) -> Result<Vec<CalendarRow>, McpToolError> {
            panic!("a connection with no grant must not read the calendar");
        }
        async fn views(&self) -> Result<Vec<ViewRow>, McpToolError> {
            panic!("a connection with no grant must not read the views");
        }
    }

    let map = grants(&[("claude-desktop", &["Projects"])]);
    // Each of these is a caller bug, not a scope decision: an unknown field (the
    // requests are `deny_unknown_fields`, so a payload cannot smuggle a folder
    // list), a missing required field, a wrong type, and a null arguments object.
    for (tool, arguments) in [
        (
            "note_search",
            json!({ "query": "a", "scope": ["Private/"] }),
        ),
        ("note_search", json!({})),
        ("note_read", json!({ "note_id": 7 })),
        ("vault_state", json!(null)),
        ("vault_list", json!({ "anything": true })),
    ] {
        assert_eq!(
            block_on(call_tool(
                inputs(&map, "claude-desktop", tool, &arguments),
                &Unreachable
            )),
            McpCallOutcome::Malformed,
            "{tool} accepted {arguments}"
        );
    }
}

#[test]
fn a_search_through_the_call_surface_returns_in_scope_rows_and_excludes_the_rest() {
    // Everything readable EXCEPT `Private`: the deny list this build writes.
    let map = grants(&[("claude-desktop", &["Private"])]);
    let source = Source::new(&[
        ("in", Some("Projects"), "the quarterly alpha report"),
        ("out", Some("Private"), "the alpha plan nobody approved"),
    ]);
    let arguments = json!({ "query": "alpha" });

    let outcome = block_on(call_tool(
        inputs(&map, "claude-desktop", "note_search", &arguments),
        &source,
    ));
    let McpCallOutcome::Result(result) = outcome else {
        panic!("expected a result, got {outcome:?}");
    };

    assert_eq!(result["isError"], false);
    assert!(
        result["content"][0]["text"].is_string(),
        "the text half must be present: {result}"
    );
    // The list is nested under `items`, because `structuredContent` has to be a
    // JSON object: a client SDK types it as a dictionary and refuses the call
    // outright when a list arrives there (myne-md/myne#1106).
    let rows = result["structuredContent"]["items"]
        .as_array()
        .expect("structuredContent.items is the row array");
    assert_eq!(rows.len(), 1, "the out-of-scope note came back: {rows:?}");
    assert_eq!(rows[0]["noteId"], "in");
    assert_eq!(rows[0]["folder"], "Projects");
    assert!(
        rows[0]["excerpt"]
            .as_str()
            .is_some_and(|e| e.contains("alpha")),
        "an excerpt must carry the match: {rows:?}"
    );
}

#[test]
fn a_read_through_the_call_surface_hands_the_note_over_as_markdown() {
    // Everything readable EXCEPT `Private`: the deny list this build writes.
    let map = grants(&[("claude-desktop", &["Private"])]);
    let source = Source::new(&[("in", Some("Projects"), "---\nfolder: Projects\n---\nbody")]);
    let arguments = json!({ "note_id": "in" });

    let McpCallOutcome::Result(result) = block_on(call_tool(
        inputs(&map, "claude-desktop", "note_read", &arguments),
        &source,
    )) else {
        panic!("expected a result");
    };
    assert_eq!(
        result["content"][0]["text"],
        "---\nfolder: Projects\n---\nbody"
    );
    assert_eq!(result["structuredContent"]["noteId"], "in");
}

#[test]
fn an_out_of_scope_read_is_refused_with_its_reason_and_one_sentence() {
    // Everything readable EXCEPT `Private`: the deny list this build writes.
    let map = grants(&[("claude-desktop", &["Private"])]);
    let source = Source::new(&[("out", Some("Private"), "x")]);
    let arguments = json!({ "note_id": "out" });

    let outcome = block_on(call_tool(
        inputs(&map, "claude-desktop", "note_read", &arguments),
        &source,
    ));
    let McpCallOutcome::Refused(error) = outcome else {
        panic!("expected a refusal, got {outcome:?}");
    };
    assert_eq!(error.reason(), "out_of_scope");
    assert!(error.message().contains("Myne"));
}

#[test]
fn the_two_no_argument_tools_answer_only_the_empty_object() {
    // Everything readable EXCEPT `Private`: the deny list this build writes.
    let map = grants(&[("claude-desktop", &["Private"])]);
    let source = Source::new(&[("a", Some("Projects"), "alpha")]);
    let arguments = json!({});
    // `vault_list` answers with its rows under `items` and `vault_state` with the
    // fields themselves, so each is read through the shape it actually carries
    // rather than through one invented here.
    let McpCallOutcome::Result(list) = block_on(call_tool(
        inputs(&map, "claude-desktop", "vault_list", &arguments),
        &source,
    )) else {
        panic!("vault_list refused an empty argument object");
    };
    assert_eq!(list["structuredContent"]["items"][0]["folder"], "projects/");

    let McpCallOutcome::Result(state) = block_on(call_tool(
        inputs(&map, "claude-desktop", "vault_state", &arguments),
        &source,
    )) else {
        panic!("vault_state refused an empty argument object");
    };
    assert_eq!(state["structuredContent"]["noteCount"], 1);
    assert_eq!(state["structuredContent"]["unlocked"], true);
}

#[test]
fn a_grant_written_under_the_allow_list_model_is_refused_rather_than_read_as_a_deny_list() {
    // The failure this prevents is silent and total. A stored allow list of
    // `["Private"]` means "Private only"; read as a deny list it means
    // "everything except Private", which is the opposite consent with no visible
    // sign in the bytes. So the answer is a refusal that says so, on EVERY tool
    // including the two no-argument ones: a client that called `vault_state`
    // first must be told to re-approve rather than shown an empty vault it would
    // report as one the user has nothing in.
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert("claude-desktop".to_string(), legacy_grant(&["Private"]));
    let source = Source::new(&[
        ("in", Some("Private"), "secret"),
        ("out", Some("Projects"), "alpha"),
    ]);

    for (tool, arguments) in [
        ("note_read", json!({ "note_id": "in" })),
        ("note_search", json!({ "query": "alpha" })),
        ("vault_list", json!({})),
        ("vault_state", json!({})),
    ] {
        let outcome = block_on(call_tool(
            inputs(&map, "claude-desktop", tool, &arguments),
            &source,
        ));
        let McpCallOutcome::Refused(error) = outcome else {
            panic!("{tool} served a legacy grant: {outcome:?}");
        };
        assert_eq!(
            error.reason(),
            "reapproval_required",
            "{tool} must name the reason a re-approval is needed"
        );
        assert!(
            error.message().contains("Myne"),
            "{tool}: a sentence a human reads must name the product"
        );
    }
}

// ── the verb switches and the read budget (myne-md/myne#1052) ──────────────

/// A grant with some verbs switched off, in the exclusion model.
fn grant_with_disabled(excluded: &[&str], disabled: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: Vec::new(),
        disabled_verbs: disabled.iter().map(|v| v.to_string()).collect(),
    }
}

#[test]
fn a_switched_off_verb_is_refused_with_its_own_reason_and_the_others_still_serve() {
    // The switch is the whole feature: disabling one verb must not disable the
    // connection, and the refusal has to be distinguishable from "no grant",
    // because the caller's next action differs (stop, versus ask the user).
    let mut map = BTreeMap::new();
    map.insert(
        "claude-desktop".to_string(),
        grant_with_disabled(&[], &["note_read"]),
    );
    let source = Source::new(&[("live", Some("Projects"), "alpha body")]);
    let search_args = serde_json::json!({ "query": "alpha" });
    let read_args = serde_json::json!({ "note_id": "live" });
    let mut read_inputs = inputs(&map, "claude-desktop", "note_read", &read_args);
    read_inputs.budget = Box::leak(Box::new(Mutex::new(
        crate::plugins::mcp::budget::BudgetLedger::default(),
    )));

    let searched = block_on(call_tool(
        inputs(&map, "claude-desktop", "note_search", &search_args),
        &source,
    ));
    assert!(
        matches!(searched, McpCallOutcome::Result(_)),
        "an enabled read verb must still serve: {searched:?}"
    );

    let refused = block_on(call_tool(read_inputs, &source));
    match refused {
        McpCallOutcome::Refused(error) => {
            assert_eq!(
                error,
                McpToolError::VerbDisabled {
                    verb: "note_read".into()
                }
            );
            assert_ne!(error.reason(), McpToolError::NoGrant.reason());
            assert_ne!(
                error.reason(),
                McpToolError::BudgetExhausted {
                    retry_after_seconds: 0
                }
                .reason()
            );
        }
        other => panic!("a switched-off verb must be refused, not served: {other:?}"),
    }
}

#[test]
fn a_verb_name_the_build_does_not_know_disables_nothing() {
    // A grant written by a newer build (or hand-edited) carries a verb this one
    // has never heard of. It can never match, so it must not refuse anything:
    // the alternative is a stored name that turns into a policy.
    let mut map = BTreeMap::new();
    map.insert(
        "claude-desktop".to_string(),
        grant_with_disabled(&[], &["note_teleport"]),
    );
    let source = Source::new(&[("live", Some("Projects"), "alpha body")]);
    let args = serde_json::json!({ "query": "alpha" });
    let outcome = block_on(call_tool(
        inputs(&map, "claude-desktop", "note_search", &args),
        &source,
    ));
    assert!(
        matches!(outcome, McpCallOutcome::Result(_)),
        "an unknown disabled verb must not refuse a real one: {outcome:?}"
    );
}

#[test]
fn an_exhausted_budget_refuses_a_note_read_and_does_not_refuse_the_folder_list() {
    // The budget counts notes, not calls, so the verbs that return no note text
    // keep working: structure is still available to an agent that has read its
    // fill, and that is what keeps the refusal from looking like a broken server.
    let mut map = BTreeMap::new();
    map.insert("claude-desktop".to_string(), grant_with_disabled(&[], &[]));
    let source = Source::new(&[("live", Some("Projects"), "alpha body")]);
    let ledger: &'static Mutex<crate::plugins::mcp::budget::BudgetLedger> = Box::leak(Box::new(
        Mutex::new(crate::plugins::mcp::budget::BudgetLedger::default()),
    ));
    ledger.lock().unwrap().charge(
        "claude-desktop",
        0,
        crate::plugins::mcp::budget::NOTES_PER_WINDOW,
    );

    let read_args = serde_json::json!({ "note_id": "live" });
    let mut read_inputs = inputs(&map, "claude-desktop", "note_read", &read_args);
    read_inputs.budget = ledger;
    let refused = block_on(call_tool(read_inputs, &source));
    match refused {
        McpCallOutcome::Refused(McpToolError::BudgetExhausted {
            retry_after_seconds,
        }) => assert_eq!(
            retry_after_seconds,
            crate::plugins::mcp::budget::WINDOW_MS / 1000
        ),
        other => panic!("an over-budget read must be refused: {other:?}"),
    }

    let list_args = serde_json::json!({});
    let mut list_inputs = inputs(&map, "claude-desktop", "vault_list", &list_args);
    list_inputs.budget = ledger;
    let listed = block_on(call_tool(list_inputs, &source));
    assert!(
        matches!(listed, McpCallOutcome::Result(_)),
        "the structure verbs return no note text, so an empty budget must not stop them: {listed:?}"
    );
}

#[test]
fn a_served_note_is_charged_to_the_budget_and_a_refusal_is_not() {
    // The charge is what makes the budget real, and the "refusal costs nothing"
    // half is what stops a retry loop from spending a connection's window.
    let mut map = BTreeMap::new();
    map.insert("claude-desktop".to_string(), grant_with_disabled(&[], &[]));
    let source = Source::new(&[("live", Some("Projects"), "alpha body")]);
    let ledger: &'static Mutex<crate::plugins::mcp::budget::BudgetLedger> = Box::leak(Box::new(
        Mutex::new(crate::plugins::mcp::budget::BudgetLedger::default()),
    ));

    let read_args = serde_json::json!({ "note_id": "live" });
    let mut read_inputs = inputs(&map, "claude-desktop", "note_read", &read_args);
    read_inputs.budget = ledger;
    assert!(matches!(
        block_on(call_tool(read_inputs, &source)),
        McpCallOutcome::Result(_)
    ));
    assert_eq!(
        ledger.lock().unwrap().remaining("claude-desktop", 0),
        crate::plugins::mcp::budget::NOTES_PER_WINDOW - 1
    );

    // A refused read (an id that is not there) leaves the budget untouched.
    let missing = serde_json::json!({ "note_id": "nope" });
    let mut missing_inputs = inputs(&map, "claude-desktop", "note_read", &missing);
    missing_inputs.budget = ledger;
    assert!(matches!(
        block_on(call_tool(missing_inputs, &source)),
        McpCallOutcome::Refused(_)
    ));
    assert_eq!(
        ledger.lock().unwrap().remaining("claude-desktop", 0),
        crate::plugins::mcp::budget::NOTES_PER_WINDOW - 1
    );
}

// ── the four reads that joined in myne-md/myne#1077 ─────────────────────────

fn file(id: &str, folder: Option<&str>, name: &str) -> FileRow {
    FileRow {
        attachment_id: id.to_string(),
        filename: Some(name.to_string()),
        folder: folder.map(str::to_string),
    }
}

#[test]
fn file_list_drops_a_file_in_an_excluded_folder() {
    // The clamp is the file's OWN folder, not the folder of any note that embeds
    // it: the library files a file once, and a note that links it is a reference.
    let mut source = Source::new(&[]);
    source.files = vec![
        file("aa", Some("Private"), "taxes.pdf"),
        file("bb", Some("Projects"), "plan.pdf"),
        file("cc", None, "root.pdf"),
    ];
    let rows = block_on(attachment_list(
        &scope(),
        AttachmentListRequest { folder: None },
        &source,
    ))
    .unwrap();
    let ids: Vec<&str> = rows.iter().map(|row| row.attachment_id.as_str()).collect();
    assert_eq!(ids, vec!["bb", "cc"]);
}

#[test]
fn file_list_narrows_to_a_folder_and_refuses_one_left_out() {
    let mut source = Source::new(&[]);
    source.files = vec![
        file("aa", Some("Private"), "taxes.pdf"),
        file("bb", Some("Projects"), "plan.pdf"),
        file("dd", Some("Projects/Sub"), "deep.pdf"),
    ];
    let rows = block_on(attachment_list(
        &scope(),
        AttachmentListRequest {
            folder: Some("Projects".into()),
        },
        &source,
    ))
    .unwrap();
    // The folder argument names ONE folder, which is the rule `note_search`
    // already follows (`&key != narrow`): a caller that wants a subtree asks for
    // each folder, because "Projects" silently meaning "and everything under it"
    // is a widening nobody typed.
    let ids: Vec<&str> = rows.iter().map(|row| row.attachment_id.as_str()).collect();
    assert_eq!(ids, vec!["bb"]);

    let error = block_on(attachment_list(
        &scope(),
        AttachmentListRequest {
            folder: Some("Private".into()),
        },
        &source,
    ))
    .unwrap_err();
    assert_eq!(
        error,
        McpToolError::OutOfScopeFolder {
            folder: "Private".into()
        }
    );
}

#[test]
fn file_read_names_an_unknown_id_and_a_left_out_file_differently() {
    // Two refusals with two different next actions: an unknown id sends the caller
    // to `attachment_list`, and a left-out file sends the user to the leave-out
    // list. Collapsing them would send a model to the wrong place.
    let mut source = Source::new(&[]);
    source.files = vec![file("aa", Some("Private"), "taxes.pdf")];
    source.file_texts.insert("aa".into(), "redacted".into());

    let unknown = block_on(attachment_read(
        &scope(),
        AttachmentReadRequest {
            attachment_id: "zz".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert_eq!(
        unknown,
        McpToolError::UnknownFile {
            attachment_id: "zz".into()
        }
    );

    let excluded = block_on(attachment_read(
        &scope(),
        AttachmentReadRequest {
            attachment_id: "aa".into(),
        },
        &source,
    ))
    .unwrap_err();
    assert_eq!(
        excluded,
        McpToolError::OutOfScopeFile {
            attachment_id: "aa".into()
        }
    );
}

#[test]
fn file_read_answers_none_for_a_file_nothing_was_extracted_from() {
    // A video is not an empty file, and a caller told "empty" would stop looking.
    let mut source = Source::new(&[]);
    source.files = vec![file("aa", Some("Projects"), "clip.mp4")];
    let text = block_on(attachment_read(
        &scope(),
        AttachmentReadRequest {
            attachment_id: "aa".into(),
        },
        &source,
    ))
    .unwrap();
    assert_eq!(text, None);
}

fn calendar_row(note_id: &str, folder: Option<&str>, start: &str) -> CalendarRow {
    CalendarRow {
        note_id: note_id.to_string(),
        title: Some(format!("title of {note_id}")),
        folder: folder.map(str::to_string),
        calendar: None,
        start: start.to_string(),
        end: None,
        all_day: true,
        occurrence_of: None,
        occurrence_date: None,
        conflicts: false,
        repeat: None,
        remind: None,
        repeat_unrecognized: false,
        uid: None,
        skip: Vec::new(),
    }
}

#[test]
fn calendar_read_keeps_only_the_events_of_notes_in_scope() {
    let source = Source::new(&[
        ("secret", Some("Private"), "a private day"),
        ("visible", Some("Projects"), "a visible day"),
    ]);
    let mut source = source;
    source.calendar_rows = vec![
        calendar_row("secret", Some("Private"), "2026-11-20"),
        calendar_row("visible", Some("Projects"), "2026-11-20"),
    ];
    let rows = block_on(calendar_read(
        &scope(),
        CalendarReadRequest {
            from: "2026-11-01".into(),
            to: "2026-11-30".into(),
        },
        &source,
    ))
    .unwrap();
    let ids: Vec<&str> = rows.iter().map(|row| row.note_id.as_str()).collect();
    assert_eq!(ids, vec!["visible"]);
    // The window the caller named is the window the calendar was asked for: a
    // widened one here would read days the caller never asked about.
    let calls = source.calendar_calls.lock().expect("calendar lock").clone();
    assert_eq!(
        calls,
        vec![("2026-11-01".to_string(), "2026-11-30".to_string())]
    );
}

#[test]
fn calendar_read_drops_a_row_whose_note_left_the_index() {
    // A row for a note the index no longer has cannot be clamped, so it is not
    // served: the safe answer is the one that reveals nothing.
    let mut source = Source::new(&[("visible", Some("Projects"), "a visible day")]);
    source.calendar_rows = vec![
        calendar_row("gone", None, "2026-11-20"),
        calendar_row("visible", Some("Projects"), "2026-11-20"),
    ];
    let rows = block_on(calendar_read(
        &scope(),
        CalendarReadRequest {
            from: "2026-11-01".into(),
            to: "2026-11-30".into(),
        },
        &source,
    ))
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].note_id, "visible");
}

#[test]
fn view_list_answers_the_stored_rows_and_runs_no_filter() {
    // Listing is not evaluating: the filter AST is the front end's to run, and a
    // second evaluator here would be a second answer to "which notes does this
    // view match".
    let mut source = Source::new(&[]);
    source.views = vec![ViewRow {
        view_id: "v1".into(),
        name: "Reading".into(),
        view_type: "table".into(),
        approved: true,
        write_fields: vec!["status".into()],
    }];
    let rows = block_on(view_list(&scope(), &source)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Reading");
    // The two facts `note_set_field`'s refusals send the caller here for: without
    // them a client told "not approved" or "field not declared" would get the same
    // undecorated list back and retry the same ids.
    assert!(rows[0].approved, "the approval state must reach the caller");
    assert_eq!(
        rows[0].write_fields,
        vec!["status".to_string()],
        "the declared fields must reach the caller"
    );
    assert_eq!(rows[0].view_type, "table");
}

#[test]
fn every_new_read_refuses_a_connection_with_no_grant() {
    // The same ordering claim the older verbs carry, one population over: a
    // connection nobody approved learns nothing, not even whether the vault has
    // files, a calendar or a view.
    let map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    let cases = [
        ("attachment_list", json!({})),
        ("attachment_read", json!({ "attachment_id": "aa" })),
        (
            "calendar_read",
            json!({ "from": "2026-11-01", "to": "2026-11-30" }),
        ),
        ("view_list", json!({})),
    ];
    let source = Source::new(&[]);
    for (tool, arguments) in cases {
        let outcome = block_on(call_tool(
            inputs(&map, "claude-desktop", tool, &arguments),
            &source,
        ));
        assert_eq!(
            outcome,
            McpCallOutcome::Refused(McpToolError::NoGrant),
            "{tool} answered a connection with no grant"
        );
    }
}

/// `structuredContent` must be a JSON OBJECT, and a client SDK refuses the call
/// before reading it otherwise (myne-md/myne#1106). Every read verb is driven once
/// and the WIRE shape asserted, not the Rust type: `attachment_read` answers with
/// `Option<String>`, so it had the same defect as the list verbs while looking
/// nothing like them.
#[test]
fn every_read_answer_carries_an_object_in_structured_content() {
    let map = grants(&[("claude-desktop", &["Private"])]);
    let mut source = Source::new(&[("in", Some("Projects"), "the quarterly alpha report")]);
    source.files.push(FileRow {
        attachment_id: "aa".to_string(),
        filename: Some("scan.png".to_string()),
        folder: Some("Projects".to_string()),
    });
    source
        .file_texts
        .insert("aa".to_string(), "text from the scan".to_string());
    source.views.push(ViewRow {
        view_id: "v1".to_string(),
        name: "Reading".to_string(),
        view_type: "table".to_string(),
        approved: true,
        write_fields: vec!["status".to_string()],
    });

    // The verbs whose answer IS a list.
    let list_verbs = [
        "note_search",
        "vault_list",
        "attachment_list",
        "calendar_read",
        "view_list",
    ];
    let cases = [
        ("note_search", json!({ "query": "alpha" })),
        ("note_read", json!({ "note_id": "in" })),
        ("vault_list", json!({})),
        ("vault_state", json!({})),
        ("attachment_list", json!({})),
        ("attachment_read", json!({ "attachment_id": "aa" })),
        (
            "calendar_read",
            json!({ "from": "2030-01-01", "to": "2030-01-31" }),
        ),
        ("view_list", json!({})),
    ];
    for (tool, arguments) in cases {
        let outcome = block_on(call_tool(
            inputs(&map, "claude-desktop", tool, &arguments),
            &source,
        ));
        let McpCallOutcome::Result(result) = outcome else {
            panic!("{tool} refused an in-scope call: {outcome:?}");
        };
        let structured = &result["structuredContent"];
        assert!(
            structured.is_object(),
            "{tool} answered structuredContent as {}: {result}",
            match structured {
                Value::Null => "null",
                Value::Bool(_) => "a boolean",
                Value::Number(_) => "a number",
                Value::String(_) => "a string",
                Value::Array(_) => "an array",
                Value::Object(_) => "an object",
            }
        );
        if list_verbs.contains(&tool) {
            assert!(
                structured["items"].is_array(),
                "{tool} answers with a list, so it belongs under `items`: {result}"
            );
            // The text half keeps the bare list, so a text-only client parses what
            // it always parsed.
            let text = result["content"][0]["text"].as_str().unwrap_or_default();
            assert!(
                serde_json::from_str::<Value>(text).is_ok_and(|parsed| parsed.is_array()),
                "{tool}'s text block must stay a bare list: {text}"
            );
        }
    }
}

/// Every served verb, driven to an ANSWER and checked against what a client parses.
///
/// `structuredContent` must be an OBJECT — an SDK refuses the call when it is not,
/// which is how myne-md/myne#1106 reached a real client — and `content` is an array
/// of typed blocks. The read verbs had this; the write verbs did not, so a create
/// could have handed back a bare string with every test green. Walks
/// [`super::tools::CATALOG_VERBS`], so a thirteenth verb is covered the day it lands.
#[test]
fn every_served_verb_answers_a_call_tool_result_a_client_can_parse() {
    let writer = Writer;
    let mut connect = grants(&[("claude-desktop", &["Private"])]);
    // The connection may write `Projects`, so the write verbs ANSWER rather than
    // propose: a queued proposal is a legitimate outcome, but not the one this test
    // is about.
    connect
        .get_mut("claude-desktop")
        .expect("the fixture's connection")
        .write_folders = vec!["Projects/".to_string()];

    let mut source = Source::new(&[("in", Some("Projects"), "the quarterly alpha report")]);
    source.files.push(FileRow {
        attachment_id: "aa".to_string(),
        filename: Some("scan.png".to_string()),
        folder: Some("Projects".to_string()),
    });
    source.file_texts.insert("aa".into(), "text".into());
    source.views.push(ViewRow {
        view_id: "v1".into(),
        name: "Reading".into(),
        view_type: "table".into(),
        approved: true,
        write_fields: vec!["status".into()],
    });

    let cases = [
        ("note_search", json!({ "query": "alpha" })),
        ("note_read", json!({ "note_id": "in" })),
        ("vault_list", json!({})),
        ("vault_state", json!({})),
        (
            "note_create",
            json!({ "folder": "Projects/", "title": "T", "body": "b" }),
        ),
        (
            "note_append",
            json!({ "note_id": "in", "markdown": "more" }),
        ),
        (
            "note_set_field",
            json!({ "note_id": "in", "view_id": "v1", "field": "status", "value": "done" }),
        ),
        (
            "note_edit",
            json!({ "note_id": "in", "source": "alpha", "replacement": "beta" }),
        ),
        (
            "note_move",
            json!({ "note_id": "in", "folder": "Projects/" }),
        ),
        ("attachment_list", json!({})),
        ("attachment_read", json!({ "attachment_id": "aa" })),
        (
            "calendar_read",
            json!({ "from": "2030-01-01", "to": "2030-01-31" }),
        ),
        ("view_list", json!({})),
    ];
    // The roster and the cases are the same SET: a verb with no case here would
    // silently lose the assertion. Sorted rather than in catalog order, because the
    // order is the catalog's business and this test's business is coverage.
    let mut driven: Vec<&str> = cases.iter().map(|(tool, _)| *tool).collect();
    driven.sort_unstable();
    let mut catalog: Vec<&str> = super::tools::CATALOG_VERBS.to_vec();
    catalog.sort_unstable();
    assert_eq!(
        driven, catalog,
        "every catalog verb needs a case in this test"
    );

    for (tool, arguments) in cases {
        let outcome = block_on(call_tool(
            inputs_with_writer(&connect, "claude-desktop", tool, &arguments, &writer),
            &source,
        ));
        let McpCallOutcome::Result(result) = outcome else {
            panic!("{tool} refused an in-scope call: {outcome:?}");
        };
        let content = result["content"]
            .as_array()
            .unwrap_or_else(|| panic!("{tool} answered no content blocks: {result}"));
        assert_eq!(
            content.len(),
            1,
            "{tool} answered {} content blocks; one answer is one block: {result}",
            content.len()
        );
        assert_eq!(content[0]["type"], "text", "{tool}: {result}");
        assert!(
            content[0]["text"].is_string(),
            "{tool} answered a text block that is not a string: {result}"
        );
        assert_eq!(
            result["isError"], false,
            "{tool} answered a result that calls itself an error: {result}"
        );
        assert!(
            result["structuredContent"].is_object(),
            "{tool} answered structuredContent as {}: a client SDK refuses the call before \
             reading it (myne-md/myne#1106): {result}",
            kind_name(&result["structuredContent"])
        );
        // The two halves must agree that the call worked: a client that reads only
        // the text block and one that reads only the object must not disagree.
        let text = content[0]["text"].as_str().unwrap_or_default();
        assert!(
            !text.is_empty(),
            "{tool} answered an empty text block, which reads as a broken server: {result}"
        );
    }
}

/// The JSON type of a value, for assertion messages that have to say what arrived.
fn kind_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}
