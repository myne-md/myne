// SPDX-License-Identifier: AGPL-3.0
//! The four read tools, clamped per tool.
//!
//! One clamping test per tool rather than one for the family, because four
//! independent clamps are four independent chances to be wrong. The set-addressed
//! tools (search, list) are asserted to EXCLUDE what is outside the scope; the
//! note-addressed one (read) is asserted to REFUSE with a named cause.

use super::error::McpToolError;
use super::scope::{resolve_scope, ConnectionScope};
use super::tools::{
    call_tool, excerpt, note_read, note_search, vault_list, vault_state, CallInputs,
    McpCallOutcome, McpNoteSource, NoteReadRequest, NoteSearchRequest, WireCall, MAX_EXCERPT_BYTES,
    MAX_SEARCH_LIMIT,
};
use crate::plugins::agent::tools::SearchHit;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::test_support::block_on;
use protocol::McpConnectionGrant;
use serde_json::json;
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

fn grant(folders: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        folders: folders.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
    }
}

fn scope_for(name: &str, folders: &[&str], existing: &[&str]) -> ConnectionScope {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(name.to_string(), grant(folders));
    let existing = existing.iter().map(|f| f.to_string()).collect();
    resolve_scope(name, &map, &existing)
}

/// The scope most tests use: `Projects` readable, `Private` not.
fn scope() -> ConnectionScope {
    scope_for("claude-desktop", &["Projects"], &["projects/", "private/"])
}

/// A source over in-memory maps, recording the search limits it was asked for.
struct Source {
    records: BTreeMap<String, NoteRecord>,
    bodies: BTreeMap<String, String>,
    /// Ranked hits whose records are all in the map, in rank order.
    ranked: Vec<String>,
    limits: Mutex<Vec<usize>>,
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
        }
    }

    fn limits(&self) -> Vec<usize> {
        self.limits.lock().expect("limits lock").clone()
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
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
    let existing = ["projects/".to_string()].into_iter().collect();
    let none = resolve_scope("stranger", &map, &existing);
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
        block_on(vault_state(&none, &source)).unwrap_err(),
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
fn state_counts_only_the_notes_inside_the_scope_and_reports_the_delta() {
    let source = Source::new(&[
        ("a", Some("Projects"), "body"),
        ("b", Some("Private"), "body"),
        ("c", None, "body"),
    ]);
    let state = block_on(vault_state(&scope(), &source)).unwrap();
    assert_eq!(state.folder_count, 1);
    assert_eq!(state.note_count, 1);
    assert_eq!(
        state.outside_folder_count, 1,
        "the Private folder exists and is outside the scope: a count, never a name"
    );
    assert_eq!(state.missing_folder_count, 0);
    assert!(state.unlocked && state.external_access);
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
    let scope = scope_for(
        "a",
        &["Projects", "Projects/Deep"],
        &["projects/", "projects/deep/", "private/"],
    );
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
    let arguments = json!({ "body": "x" });
    for tool in [
        "note_create",
        "note_append",
        "note_set_field",
        "note_move",
        "note_edit",
        "delete",
        "",
    ] {
        assert_eq!(
            block_on(call_tool(
                inputs(&map, "claude-desktop", tool, &arguments),
                &source
            )),
            McpCallOutcome::UnknownTool,
            "{tool} was not reported as an unknown verb"
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
    let map = grants(&[("claude-desktop", &["Projects"])]);
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
    let rows = result["structuredContent"]
        .as_array()
        .expect("structuredContent is the row array");
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
    let map = grants(&[("claude-desktop", &["Projects"])]);
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
    let map = grants(&[("claude-desktop", &["Projects"])]);
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
    let map = grants(&[("claude-desktop", &["Projects"])]);
    let source = Source::new(&[("a", Some("Projects"), "alpha")]);
    let arguments = json!({});
    // `vault_list` answers with the row array itself and `vault_state` with an
    // object, so each is read through the field it actually carries rather than
    // through a shape invented here.
    let McpCallOutcome::Result(list) = block_on(call_tool(
        inputs(&map, "claude-desktop", "vault_list", &arguments),
        &source,
    )) else {
        panic!("vault_list refused an empty argument object");
    };
    assert_eq!(list["structuredContent"][0]["folder"], "projects/");

    let McpCallOutcome::Result(state) = block_on(call_tool(
        inputs(&map, "claude-desktop", "vault_state", &arguments),
        &source,
    )) else {
        panic!("vault_state refused an empty argument object");
    };
    assert_eq!(state["structuredContent"]["noteCount"], 1);
    assert_eq!(state["structuredContent"]["unlocked"], true);
}
