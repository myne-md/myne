// SPDX-License-Identifier: AGPL-3.0
//! The Settings views, held to what the screen may claim: every count a row states
//! is the resolver's own answer, the excluded set is what the tools actually
//! enforce, a grant under the retired model is reported as needing re-approval
//! rather than as a working one, and the approval preview counts what the
//! exclusion list would leave readable before anything is written.

use super::view::{external_access_view, grant_preview};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::{McpConnectionGrant, McpScopeModel, PrefsView};
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

/// A grant in the model this build writes: the folders named here are the ones
/// the connection may NOT read.
fn grant(excluded: &[&str], last_used_at: Option<u64>) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at,
        write_folders: Vec::new(),
        disabled_verbs: Vec::new(),
    }
}

/// A grant in the retired allow-list model, as the released build stored it.
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
    let prefs = prefs_with(&[("claude-desktop", grant(&["Elsewhere"], Some(1_700_000_600)))]);

    let view = external_access_view(&prefs, &records);
    assert_eq!(view.connections.len(), 1);
    let row = &view.connections[0];
    assert_eq!(row.name, "claude-desktop");
    assert!(!row.legacy, "a fresh approval needs no re-approval");
    assert_eq!(row.excluded_folders, strings(&["elsewhere/"]));
    assert_eq!(
        row.note_count, 3,
        "two notes directly in Projects plus one in Projects/Deep"
    );
    assert_eq!(
        row.folder_count, 2,
        "projects/ and projects/deep/; elsewhere/ is excluded"
    );
    assert_eq!(row.approved_at, 1_700_000_000);
    assert_eq!(row.last_used_at, Some(1_700_000_600));
    assert!(
        row.write_folders.is_empty(),
        "no write grant exists yet, so the row may not claim one"
    );
    assert!(
        row.stale_excluded_folders.is_empty(),
        "the excluded folder still exists"
    );
    assert!(
        row.legacy_folders.is_empty(),
        "the retired allow list travels only on a row that has one"
    );
    assert_eq!(view.note_count, 4, "the vault's own live note count");
    assert_eq!(
        view.folders,
        strings(&["elsewhere/", "projects/", "projects/deep/"]),
        "the approval screen is offered every folder the sidebar shows"
    );
}

#[test]
fn a_folder_created_after_approval_is_covered_and_the_row_does_not_pretend_otherwise() {
    // The whole point of the deny list, asserted at the surface the user reads: a
    // new folder is inside the approval, so the row's counts grow with the vault.
    // There is no delta to offer, because there is nothing left out.
    let records = index(&[("one", Some("Projects")), ("two", Some("Projects/New"))]);
    let prefs = prefs_with(&[("cursor", grant(&["Private"], None))]);

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];
    assert_eq!(
        row.note_count, 2,
        "the note in the folder created after approval is covered"
    );
    assert_eq!(row.folder_count, 2);
    assert!(row.last_used_at.is_none(), "never used since approval");
}

#[test]
fn an_exclusion_naming_a_folder_that_no_longer_exists_is_reported_as_stale() {
    // The exclusion is preserved (a folder that comes back is still excluded) but
    // it is not counted as one that takes something away, and the row says which
    // of its entries are in that state.
    let records = index(&[("one", Some("Archive"))]);
    let prefs = prefs_with(&[("cursor", grant(&["Projects", "Archive"], None))]);

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];
    assert_eq!(row.excluded_folders, strings(&["archive/", "projects/"]));
    assert_eq!(
        row.stale_excluded_folders,
        strings(&["projects/"]),
        "the folder the user excluded is gone; archive/ is still excluded"
    );
    assert_eq!(
        row.note_count, 0,
        "Archive is the only folder and it is out"
    );
}

#[test]
fn a_legacy_grant_is_reported_as_needing_reapproval_rather_than_as_shared() {
    // A row that showed counts for a rule this build no longer enforces would be
    // the overstatement this screen exists to avoid: the numbers would describe
    // access the tools refuse.
    let records = index(&[("one", Some("Projects"))]);
    let prefs = prefs_with(&[("cursor", legacy_grant(&["Projects", "Inbox"]))]);

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];
    assert!(row.legacy, "the row must carry the reason, not just zeroes");
    assert_eq!(
        row.legacy_folders,
        strings(&["Projects", "Inbox"]),
        "what the old grant named, so the user can see what they re-approve"
    );
    assert!(row.excluded_folders.is_empty());
    assert_eq!(
        row.note_count, 0,
        "as served by this build, nothing is readable"
    );
    assert_eq!(row.folder_count, 0);
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
        ("claude-desktop", grant(&["Inbox"], None)),
        ("lm-studio", grant(&["Projects"], None)),
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
    assert_eq!(claude.excluded_folders, strings(&["inbox/"]));
    assert_eq!(lm.excluded_folders, strings(&["projects/"]));
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
    assert!(
        all.excluded_folders.is_empty(),
        "an approval with nothing excluded shares the whole vault"
    );

    let narrowed = grant_preview(&prefs, &records, &strings(&["Projects"]));
    assert_eq!(narrowed.folder_count, 1);
    assert_eq!(narrowed.note_count, 1);
    assert_eq!(narrowed.excluded_count, 1);
    assert_eq!(
        narrowed.excluded_folders,
        strings(&["projects/"]),
        "the preview carries the SET its counts describe, so the approval writes \
         the number the user read rather than re-deriving it"
    );
}

#[test]
fn excluding_a_folder_takes_what_is_inside_it_too() {
    // The exclusion is a prefix rule and it is the SAME rule the resolver applies
    // on every call, so the count here and the access there cannot differ.
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
    assert_eq!(preview.folder_count, 1, "projects/ is still shared");
    assert_eq!(preview.note_count, 1, "the root note is not");
    assert_eq!(preview.excluded_count, 1);
}

#[test]
fn the_preview_drops_an_exclusion_that_names_nothing() {
    // Counting it would tell the user they had left out a folder the vault does
    // not have, and writing it would store a decision about nothing.
    let records = index(&[("one", Some("Projects"))]);
    let prefs = PrefsView::default();
    let preview = grant_preview(&prefs, &records, &strings(&["Nope", "Projects"]));
    assert_eq!(preview.excluded_count, 1);
    assert_eq!(preview.excluded_folders, strings(&["projects/"]));
    assert_eq!(preview.folder_count, 0);
}

#[test]
fn the_preview_canonicalizes_what_it_counts_and_writes() {
    let records = index(&[("one", Some("Projects"))]);
    let prefs = PrefsView::default();
    let preview = grant_preview(&prefs, &records, &strings(&["  PROJECTS  "]));
    assert_eq!(preview.excluded_folders, strings(&["projects/"]));
    assert_eq!(preview.excluded_count, 1);
}

#[test]
fn the_preview_never_reads_a_note_body_or_a_title() {
    // The preview runs on every keystroke in the approval dialog, so its inputs
    // are metadata only. Asserted by giving the fixture a title and proving no
    // payload field carries it.
    let mut records = index(&[("one", Some("Projects"))]);
    records.get_mut("one").expect("the record").title = Some("a secret title".into());
    let prefs = PrefsView::default();
    let wire = serde_json::to_string(&grant_preview(&prefs, &records, &[])).unwrap();
    assert!(
        !wire.contains("secret"),
        "the payload carried a title: {wire}"
    );
}

// ── the folders other AI surfaces were already kept out of ──────────────────

/// The ROW the person reads states the reach a call is actually served under, so a
/// folder already excluded from Myne's own AI is not counted as readable and is not
/// offered as a write target.
///
/// The failure this prevents is a row that says "412 notes across 38 folders" about
/// an account where a chunk of those notes are out of reach, and a grant dialog that
/// offers to write into a folder the call-time subset check refuses.
#[test]
fn the_row_counts_the_ai_and_cli_exclusions_out_of_the_reach() {
    let records = index(&[
        ("a", Some("Notes")),
        ("b", Some("Notes")),
        ("c", Some("Journal")),
        ("d", Some("Journal/2026")),
    ]);
    let prefs = PrefsView {
        ai_excluded_folders: strings(&["Journal/"]),
        cli_excluded_folders: strings(&["Journal/2026/"]),
        ..prefs_with(&[("cursor", grant(&[], None))])
    };

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];

    assert_eq!(row.note_count, 2, "only the two readable notes are counted");
    assert_eq!(
        row.folder_count, 1,
        "the excluded subtree is not counted as reachable: {:?}",
        row.excluded_folders
    );
    assert!(
        row.excluded_folders
            .iter()
            .any(|folder| folder == "journal/"),
        "the row names the exclusion the user did not tick here: {:?}",
        row.excluded_folders
    );
    assert!(
        row.excluded_folders
            .iter()
            .any(|folder| folder == "journal/2026/"),
        "the CLI exclusion is in the same list: {:?}",
        row.excluded_folders
    );
}

/// The approval screen's count is the same count. A preview that ignored the quiet
/// set would give the person a number to approve that no call is served under.
#[test]
fn the_preview_counts_the_ai_and_cli_exclusions_out_of_the_reach() {
    let records = index(&[("a", Some("Notes")), ("b", Some("Journal"))]);
    let prefs = PrefsView {
        ai_excluded_folders: strings(&["Journal/"]),
        ..PrefsView::default()
    };

    let preview = grant_preview(&prefs, &records, &[]);

    assert_eq!(preview.note_count, 1);
    assert!(preview
        .excluded_folders
        .iter()
        .any(|folder| folder == "journal/"));
}

// ── an archived folder's exclusion is still an exclusion ────────────────────
//
// Archiving a folder hides it from the sidebar; it does not delete a note and it
// does not stop the deny list from matching. So an exclusion naming an archived
// folder is still enforced, and both halves of this surface used to disagree with
// that: the approval preview dropped the entry (an approval act that WIDENS the
// scope past what the person was shown) and the row called it stale (telling them
// a protection they still had was gone).

#[test]
fn the_preview_keeps_an_exclusion_on_an_archived_folder() {
    let records = index(&[("a", Some("Archive/")), ("b", Some("Inbox/"))]);
    let prefs = PrefsView {
        archived_folders: vec!["Archive/".into()],
        ..Default::default()
    };

    let preview = grant_preview(&prefs, &records, &["archive/".to_string()]);

    // The dialog writes `excluded_folders` back verbatim on approve, so an entry
    // missing here is an entry erased from the grant.
    assert_eq!(preview.excluded_folders, vec!["archive/".to_string()]);
    assert_eq!(preview.excluded_count, 1);
    // And the count of what stays readable excludes what the exclusion takes, which
    // is the whole point of showing the number.
    assert_eq!(preview.note_count, 1);
}

#[test]
fn the_preview_still_drops_an_exclusion_that_names_nothing() {
    // The other direction, because the fix above is a filter change: an exclusion
    // over a folder this vault does not have excludes nothing and is dropped rather
    // than stored. Without this, "keep everything" would be indistinguishable from
    // "keep what still excludes something" in the tests.
    let records = index(&[("a", Some("Inbox/"))]);
    let prefs = PrefsView::default();

    let preview = grant_preview(&prefs, &records, &["ghost/".to_string()]);

    assert!(preview.excluded_folders.is_empty());
    assert_eq!(preview.excluded_count, 0);
}

#[test]
fn the_row_does_not_call_an_archived_exclusion_stale() {
    let records = index(&[("a", Some("Archive/")), ("b", Some("Inbox/"))]);
    let mut prefs = prefs_with(&[("claude-desktop", grant(&["archive/"], None))]);
    prefs.archived_folders = vec!["Archive/".into()];

    let view = external_access_view(&prefs, &records);
    let row = &view.connections[0];

    assert_eq!(row.excluded_folders, vec!["archive/".to_string()]);
    assert!(
        row.stale_excluded_folders.is_empty(),
        "an archived folder is still a folder: {:?}",
        row.stale_excluded_folders
    );
}
