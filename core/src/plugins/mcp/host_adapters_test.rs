// SPDX-License-Identifier: AGPL-3.0-only
//! The live-vault source, and the door's call pipeline over it.
//!
//! Two properties are asserted here that the tool tests cannot reach, because
//! they are properties of the SOURCE rather than of a clamp:
//!
//! - a locked vault is an ERROR, not an empty vault (an empty index and an empty
//!   search result both read as "your vault has no notes"), and
//! - a search collapses one note's attachment documents into one hit, so a note
//!   whose embedded attachment matches does not occupy several of the caller's
//!   rows.
//!
//! The second one is asserted from both directions: the RAW index is checked to
//! hold two documents for the same note FIRST, so a fixture that could not reach
//! the duplicated state would fail here rather than pass and prove nothing.

use super::host_adapters::{door_call, DoorContext, VaultNoteSource};
use super::tools::{McpCallOutcome, McpNoteSource};
use crate::host::test_host::TestHost;
use crate::plugins::vault_indices::state::NoteRecord;
use crate::plugins::vault_indices::VaultIndicesState;
use crate::plugins::vault_unlock::state::{
    fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
};
use crate::search::SearchIndexState;
use crate::vault_io::StdVaultIo;
use serde_json::json;

/// A note record in the sidebar's shape: title, folder, and live.
fn record(folder: Option<&str>, title: &str) -> NoteRecord {
    NoteRecord {
        title: Some(title.to_string()),
        folder: folder.map(str::to_string),
        ..Default::default()
    }
}

/// An unlocked state over no vault directory at all. These tests never read a
/// note body, so nothing resolves a path: the index and the search index are
/// in RAM and the slot is the only thing either question checks.
fn unlocked_state() -> (VaultRuntimeState, tokio::runtime::Runtime) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime build");
    let state = VaultRuntimeState::default();
    rt.block_on(async {
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x51, 0x52, 3))
            .await;
    });
    (state, rt)
}

fn source<'a>(
    host: &'a TestHost,
    state: &'a VaultRuntimeState,
    indices: &'a VaultIndicesState,
    search: &'a SearchIndexState,
) -> VaultNoteSource<'a> {
    VaultNoteSource {
        host,
        state,
        indices,
        search,
        io: &StdVaultIo,
    }
}

// ── the lock is an error, never an empty answer ─────────────────────────────

#[test]
fn records_on_a_locked_vault_is_an_error_rather_than_an_empty_index() {
    let (state, rt) = unlocked_state();
    let host = TestHost::new(std::env::temp_dir());
    let indices = VaultIndicesState::default();
    indices.apply("a", record(Some("Projects"), "A"));
    let search = SearchIndexState::default();
    search.upsert("a", "A", "alpha");

    // While unlocked the index answers: this is the control, and it is what
    // makes the locked assertion below about the SLOT rather than about an
    // index that was empty all along.
    rt.block_on(async {
        let rows = source(&host, &state, &indices, &search)
            .records()
            .await
            .expect("an unlocked vault answers");
        assert_eq!(rows.len(), 1);
        state.take(test_vault_id()).await;
    });

    rt.block_on(async {
        assert_eq!(
            source(&host, &state, &indices, &search).records().await,
            Err(super::error::McpToolError::VaultUnavailable),
            "a locked vault must not answer with an empty index"
        );
    });
}

#[test]
fn search_on_a_locked_vault_is_an_error_rather_than_no_matches() {
    let (state, rt) = unlocked_state();
    let host = TestHost::new(std::env::temp_dir());
    let indices = VaultIndicesState::default();
    let search = SearchIndexState::default();
    search.upsert("a", "A", "alpha");

    rt.block_on(async {
        state.take(test_vault_id()).await;
        // The index still holds the document: nothing cleared it, because
        // clearing an index is the lock path's job, not this source's. That is
        // what makes the error below about the SLOT rather than about a genuine
        // no-match — a distinction `note_search_core` alone collapses, since it
        // degrades to an empty vector on a locked slot.
        assert!(!search.query("alpha").is_empty(), "the index still ranks");
        assert_eq!(
            source(&host, &state, &indices, &search)
                .search("alpha", 10)
                .await,
            Err(super::error::McpToolError::VaultUnavailable)
        );
    });
}

// ── one note, several index documents, one hit ──────────────────────────────

#[test]
fn search_collapses_one_notes_attachment_docs_into_one_hit() {
    let (state, rt) = unlocked_state();
    let host = TestHost::new(std::env::temp_dir());
    let indices = VaultIndicesState::default();
    let search = SearchIndexState::default();
    // The note's own body doc AND an extracted-attachment doc, both matching the
    // same term and both decoding to the same note id. The attachment id must be
    // the canonical 64 lowercase hex, or `parse_search_doc_id` treats the whole
    // `att:…` string as a plain note id and the fixture never reaches the
    // duplicated state (which is how the first version of this test passed while
    // proving nothing).
    search.upsert("note-a", "Ledger", "the quarterly ledger");
    let attachment_id = "b".repeat(64);
    search.set_note_attachments(
        "note-a",
        &[(
            attachment_id,
            "ledger.pdf".to_string(),
            "the quarterly ledger, attached".to_string(),
        )],
    );

    // The fixture can reach the duplicated state, asserted on the RAW index:
    // with only one matching document the dedupe below would be untested.
    let raw = search.query("quarterly");
    assert_eq!(
        raw.len(),
        2,
        "the fixture must hold two documents for one note, or the dedupe is untested"
    );

    rt.block_on(async {
        let hits = source(&host, &state, &indices, &search)
            .search("quarterly", 10)
            .await
            .expect("unlocked");
        assert_eq!(hits.len(), 1, "one note must come back as one hit");
        assert_eq!(hits[0].note_id, "note-a");
    });
}

#[test]
fn search_stops_at_the_limit_it_was_asked_for() {
    let (state, rt) = unlocked_state();
    let host = TestHost::new(std::env::temp_dir());
    let indices = VaultIndicesState::default();
    let search = SearchIndexState::default();
    for id in ["a", "b", "c"] {
        search.upsert(id, id, "shared term");
    }

    rt.block_on(async {
        let hits = source(&host, &state, &indices, &search)
            .search("shared", 2)
            .await
            .expect("unlocked");
        assert_eq!(hits.len(), 2, "the caller's over-fetch bound is honoured");
    });
}

// ── the door's own order: the lock is answered before prefs are read ────────

#[test]
fn door_call_answers_vault_locked_before_it_touches_prefs() {
    // No vault directory is created and no prefs blob exists: if the prefs read
    // ran first this would answer `Io`. `VaultLocked` is therefore proof that
    // the slot check comes first, which is what keeps a locked vault from being
    // reported as a failing disk.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current-thread runtime build");
    let host = TestHost::new(std::env::temp_dir());
    let state = VaultRuntimeState::default();
    let indices = VaultIndicesState::default();
    let search = SearchIndexState::default();
    let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
    let arguments = json!({ "query": "alpha" });

    rt.block_on(async {
        let registry = crate::plugins::live::LiveSessionRegistry::new();
        let outcome = door_call(
            DoorContext {
                host: &host,
                state: &state,
                indices: &indices,
                search: &search,
                hooks: &hooks,
                registry: &registry,
                io: &StdVaultIo,
            },
            super::tools::WireCall {
                connection: "claude-desktop",
                tool: "note_search",
                arguments: &arguments,
            },
        )
        .await;
        assert_eq!(outcome, McpCallOutcome::VaultLocked);
    });
}
