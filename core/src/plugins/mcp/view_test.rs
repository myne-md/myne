// SPDX-License-Identifier: AGPL-3.0
//! The Settings views, held to what the screen may claim: the counts a row states
//! are the resolver's, the delta is the set the add action would write, and the
//! approval preview counts the folder set the grant would actually freeze.

use super::view::{external_access_view, grant_preview};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::{McpConnectionGrant, PrefsView};
use std::collections::BTreeMap;

// ── fixtures ────────────────────────────────────────────────────────────────

fn record(folder: Option<&str>) -> NoteRecord {
    NoteRecord {
        title: Some("a title".into()),
        folder: folder.map(|f| f.to_string()),
        ..Default::default()
    }
}

fn index(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, NoteRecord> {
    pairs
        .iter()
        .map(|(id, folder)| ((*id).to_string(), record(*folder)))
        .collect()
}

fn grant(folders: &[&str], last_used_at: Option<u64>) -> McpConnectionGrant {
    McpConnectionGrant {
        folders: folders.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at,
    }
}

fn prefs_with(pairs: &[(&str, McpConnectionGrant)]) -> PrefsView {
    let mut prefs = PrefsView::default();
    for (name, grant) in pairs {
        prefs
            .mcp_connections
            .insert((*name).to_string(), grant.clone());
    }
    prefs
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ── the section's view ─────────────────────────────────────────────────────

#[test]
fn a_connection_view_states_the_counts_the_resolver_produced() {
    let records = index(&[
        ("one", Some("Projects")),
        ("two", Some("Projects")),
        ("three", Some("Projects/Deep")),
        ("out", Some("Elsewhere")),
    ]);
    let prefs = prefs_with(&[(
        "claude-desktop",
        grant(&["Projects", "Projects/Deep"], Some(1_700_000_600)),
    )]);

    let view = external_access_view(&prefs, &records);
    assert_eq!(view.connections.len(), 1);
    let row = &view.connections[0];
    assert_eq!(row.name, "claude-desktop");
    assert_eq!(row.read_folders, strings(&["projects/", "projects/deep/"]));
    assert_eq!(
        row.note_count, 3,
        "two notes directly in Projects plus one in Projects/Deep"
    );
    assert_eq!(row.approved_at, 1_700_000_000);
    assert_eq!(row.last_used_at, Some(1_700_000_600));
    assert!(
        row.write_folders.is_empty(),
        "no write grant exists yet, so the row may not claim one"
    );
    assert!(
        row.missing_folders.is_empty(),
        "every granted path still exists"
    );
    assert_eq!(
        row.delta_folders,
        strings(&["elsewhere/"]),
        "the folder the grant does not name is the delta, and it is not readable"
    );
    assert_eq!(view.note_count, 4, "the vault's own live note count");
    assert_eq!(
        view.folders,
        strings(&["elsewhere/", "projects/", "projects/deep/"]),
        "the approval screen is offered every folder the sidebar shows"
    );
}

#[test]
fn a_folder_created_after_approval_appears_in_that_connections_delta() {
    let records = index(&[("one", Some("Projects")), ("two", Some("Projects/New"))]);
    let prefs = prefs_with(&[("cursor", grant(&["Projects"], None))]);

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];
    assert_eq!(
        row.delta_folders,
        strings(&["projects/new/"]),
        "the delta is the list the row's add action writes, not a count alone"
    );
    assert_eq!(
        row.note_count, 1,
        "the note in the new folder is outside the frozen set"
    );
    assert!(row.last_used_at.is_none(), "never used since approval");
}

#[test]
fn a_renamed_folder_is_reported_as_missing_rather_than_as_shared() {
    let records = index(&[("one", Some("Archive"))]);
    let prefs = prefs_with(&[("cursor", grant(&["Projects"], None))]);

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];
    assert!(row.read_folders.is_empty());
    assert_eq!(row.missing_folders, strings(&["projects/"]));
    assert_eq!(row.delta_folders, strings(&["archive/"]));
    assert_eq!(row.note_count, 0);
}

#[test]
fn a_revoked_connection_is_absent_from_the_view() {
    // Revocation removes the grant, so the row is gone rather than greyed. The
    // section lists approvals, and there is no longer one.
    let records = index(&[("one", Some("Projects"))]);
    let prefs = prefs_with(&[]);
    let view = external_access_view(&prefs, &records);
    assert!(view.connections.is_empty());
    assert_eq!(view.folders, strings(&["projects/"]));
}

#[test]
fn one_connections_scope_never_shows_up_on_another() {
    let records = index(&[("one", Some("Projects")), ("two", Some("Inbox"))]);
    let prefs = prefs_with(&[
        ("claude-desktop", grant(&["Projects"], None)),
        ("lm-studio", grant(&["Inbox"], None)),
    ]);
    let view = external_access_view(&prefs, &records);
    let claude = view
        .connections
        .iter()
        .find(|row| row.name == "claude-desktop")
        .expect("the first connection");
    let lm = view
        .connections
        .iter()
        .find(|row| row.name == "lm-studio")
        .expect("the second connection");
    assert_eq!(claude.read_folders, strings(&["projects/"]));
    assert_eq!(lm.read_folders, strings(&["inbox/"]));
    assert_eq!(claude.note_count, 1);
    assert_eq!(lm.note_count, 1);
}

// ── the approval preview ───────────────────────────────────────────────────

#[test]
fn the_preview_counts_every_folder_until_one_is_excluded() {
    let records = index(&[("one", Some("Projects")), ("two", Some("Inbox"))]);
    let prefs = PrefsView::default();

    let all = grant_preview(&prefs, &records, &[]);
    assert_eq!(all.folder_count, 2);
    assert_eq!(all.note_count, 2);
    assert_eq!(all.excluded_count, 0);

    let narrowed = grant_preview(&prefs, &records, &strings(&["Projects"]));
    assert_eq!(narrowed.folder_count, 1);
    assert_eq!(narrowed.note_count, 1);
    assert_eq!(narrowed.excluded_count, 1);
}

#[test]
fn excluding_a_folder_takes_what_is_inside_it_too() {
    // The grant matches paths exactly, so this is a decision rather than an
    // inherited rule: the exclusion is applied once, here, and the stored grant
    // is the explicit list this returns.
    let records = index(&[
        ("one", Some("Projects")),
        ("two", Some("Projects/Deep")),
        ("three", Some("Inbox")),
    ]);
    let prefs = PrefsView::default();
    let preview = grant_preview(&prefs, &records, &strings(&["Projects"]));
    assert_eq!(preview.folder_count, 1, "only Inbox is left");
    assert_eq!(preview.note_count, 1);
    assert_eq!(
        preview.excluded_count, 1,
        "the parent counts once even though it took a child with it"
    );
}

#[test]
fn excluding_the_root_takes_the_root_notes_and_not_the_vault() {
    // `""` is the root FOLDER in this model, not a prefix over everything (the
    // same reading `scope.rs` records). The distinction is the whole reason this
    // test exists: the opposite rule would make one pick "share nothing".
    let records = index(&[("root", None), ("in-folder", Some("Projects"))]);
    let prefs = PrefsView::default();
    let preview = grant_preview(&prefs, &records, &strings(&[""]));
    assert_eq!(preview.folder_count, 1, "Projects/ is still shared");
    assert_eq!(preview.note_count, 1, "the root note is not");
    assert_eq!(preview.excluded_count, 1);
}

#[test]
fn an_exclusion_that_names_no_folder_counts_as_nothing() {
    let records = index(&[("one", Some("Projects"))]);
    let prefs = PrefsView::default();
    let preview = grant_preview(&prefs, &records, &strings(&["Nonexistent"]));
    assert_eq!(preview.folder_count, 1);
    assert_eq!(preview.note_count, 1);
    assert_eq!(
        preview.excluded_count, 0,
        "counting it would tell the user they had excluded something they had not"
    );
}

#[test]
fn the_preview_leaves_out_hidden_notes_and_archived_folders() {
    // The candidate set is the sidebar's derivation, so a folder the user cannot
    // see is not offered and a trashed note is not counted.
    let mut records = index(&[("live", Some("Projects"))]);
    records.insert(
        "trashed".into(),
        NoteRecord {
            live: false,
            ..record(Some("Projects"))
        },
    );
    let prefs = PrefsView {
        deliberate_folders: strings(&["Old"]),
        archived_folders: strings(&["Old"]),
        ..PrefsView::default()
    };

    let preview = grant_preview(&prefs, &records, &[]);
    assert_eq!(
        preview.folder_count, 1,
        "the archived folder is not offered"
    );
    assert_eq!(preview.note_count, 1, "the trashed note is not counted");
}
