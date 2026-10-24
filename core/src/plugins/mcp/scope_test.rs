// SPDX-License-Identifier: AGPL-3.0
//! The scope resolver, held to the four properties the approval screen and the
//! read tools depend on: the frozen unit is the folder set, a folder created
//! later starts outside it and is reported, a renamed folder falls out and is
//! reported, and a name with no grant resolves to nothing that refuses.

use super::error::McpToolError;
use super::scope::{existing_folders, resolve_scope, ConnectionScope};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::McpConnectionGrant;
use std::collections::{BTreeMap, BTreeSet};

// ── fixtures ────────────────────────────────────────────────────────────────

fn key_set(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|p| p.to_string()).collect()
}

fn grant(folders: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        folders: folders.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
    }
}

fn grants(pairs: &[(&str, &[&str])]) -> BTreeMap<String, McpConnectionGrant> {
    pairs
        .iter()
        .map(|(name, folders)| ((*name).to_string(), grant(folders)))
        .collect()
}

fn record(folder: Option<&str>) -> NoteRecord {
    NoteRecord {
        title: Some("a title".into()),
        folder: folder.map(|f| f.to_string()),
        ..Default::default()
    }
}

fn hidden(folder: Option<&str>) -> NoteRecord {
    NoteRecord {
        live: false,
        ..record(folder)
    }
}

fn index(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, NoteRecord> {
    pairs
        .iter()
        .map(|(id, folder)| ((*id).to_string(), record(*folder)))
        .collect()
}

fn resolve(name: &str, folders: &[&str], existing: &[&str]) -> ConnectionScope {
    let map = grants(&[(name, folders)]);
    resolve_scope(name, &map, &key_set(existing))
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ── the frozen unit is the folder set ───────────────────────────────────────

#[test]
fn a_folder_created_after_approval_is_out_of_scope_and_reported_in_the_delta() {
    // Approved when only `Projects` existed.
    let at_approval = resolve("claude-desktop", &["Projects"], &["projects/"]);
    assert!(at_approval.covers_folder("Projects"));
    assert_eq!(
        at_approval.note_count(&index(&[("a", Some("Projects"))])),
        1
    );
    assert!(at_approval.delta().is_empty());

    // The user then creates `Projects/New`, which nobody was asked about.
    let now = resolve(
        "claude-desktop",
        &["Projects"],
        &["projects/", "projects/new/"],
    );
    assert!(
        !now.covers_folder("Projects/New"),
        "a folder created after approval starts outside the scope"
    );
    assert_eq!(
        now.folders(),
        &key_set(&["projects/"]),
        "the granted set did not move"
    );
    assert_eq!(
        now.delta(),
        ["projects/new/".to_string()],
        "the delta is what Settings reports and offers to add"
    );
}

#[test]
fn a_renamed_folder_falls_out_of_scope_and_is_reported() {
    // The grant stores PATHS, so a rename is a disappearance plus an appearance.
    let now = resolve("cursor", &["Projects"], &["archive/"]);
    assert!(
        !now.covers_folder("Projects"),
        "the old path no longer exists"
    );
    assert!(
        !now.covers_folder("Archive"),
        "the new path was never granted"
    );
    assert_eq!(now.missing(), &["projects/".to_string()]);
    assert_eq!(now.delta(), &["archive/".to_string()]);
}

#[test]
fn a_note_created_after_approval_inside_a_granted_folder_is_in_scope() {
    // The frozen unit is the folder set, so a new NOTE is not a new decision.
    // This is the deliberate difference from the agent's note-id grant: freezing
    // notes would make the grant decay as the user writes.
    let scope = resolve("lm-studio", &["Projects"], &["projects/"]);
    let before = index(&[("old", Some("Projects"))]);
    let after = index(&[("old", Some("Projects")), ("new", Some("Projects"))]);
    assert_eq!(scope.note_count(&before), 1);
    assert_eq!(
        scope.note_count(&after),
        2,
        "a note written into a granted folder is inside the grant"
    );
}

#[test]
fn moving_a_note_out_of_a_granted_folder_takes_it_out_of_the_scope() {
    let scope = resolve("lm-studio", &["Projects"], &["projects/", "elsewhere/"]);
    let moved = index(&[("a", Some("Elsewhere"))]);
    assert_eq!(scope.note_count(&moved), 0);
}

#[test]
fn the_grant_holds_folders_and_never_notes() {
    // Nothing in the fixture can express a note id, which is the point: a second
    // name with a different folder list resolves to a different scope.
    let map = grants(&[("claude-desktop", &["Projects"]), ("cursor", &["Inbox"])]);
    let existing = key_set(&["projects/", "inbox/"]);
    let claude = resolve_scope("claude-desktop", &map, &existing);
    let cursor = resolve_scope("cursor", &map, &existing);
    assert!(claude.covers_folder("Projects") && !claude.covers_folder("Inbox"));
    assert!(cursor.covers_folder("Inbox") && !cursor.covers_folder("Projects"));
}

// ── a name with no grant ────────────────────────────────────────────────────

#[test]
fn an_unknown_connection_name_resolves_to_an_empty_scope_that_refuses() {
    let map = grants(&[("claude-desktop", &["Projects"])]);
    let scope = resolve_scope("never-approved", &map, &key_set(&["projects/"]));
    assert!(!scope.is_granted());
    assert!(scope.folders().is_empty());
    assert!(
        scope.delta().is_empty(),
        "there is no scope, so there is no delta to report against it"
    );
    assert_eq!(scope.require_granted(), Err(McpToolError::NoGrant));
    assert_eq!(scope.name(), "never-approved");
}

#[test]
fn a_revoked_name_is_the_same_case_as_one_never_approved() {
    // Revocation removes the entry, so both arrive here as "no grant" and the
    // caller gets the same refusal. Nothing about the history is readable.
    let map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    let scope = resolve_scope("claude-desktop", &map, &key_set(&["projects/"]));
    assert!(!scope.is_granted());
    assert_eq!(scope.require_granted(), Err(McpToolError::NoGrant));
}

#[test]
fn a_granted_name_is_granted_even_when_every_folder_it_names_has_gone() {
    // Distinct from no-grant: the approval exists, the folders do not. The tools
    // answer "empty scope" rather than "unknown connection", because the second
    // would tell the user to re-approve something they already approved.
    let scope = resolve("claude-desktop", &["Deleted"], &["projects/"]);
    assert!(scope.is_granted());
    assert!(scope.folders().is_empty());
    assert_eq!(scope.missing(), &["deleted/".to_string()]);
    assert_eq!(scope.require_granted(), Ok(()));
}

// ── the root is one folder, not a wildcard ──────────────────────────────────

#[test]
fn the_root_is_a_folder_like_any_other() {
    let all = index(&[("root", None), ("in-folder", Some("Projects"))]);
    let root_granted = resolve("a", &[""], &["", "projects/"]);
    assert!(root_granted.covers_folder(""), "the root note is covered");
    assert!(
        !root_granted.covers_folder("Projects"),
        "the root is not the whole vault"
    );
    assert_eq!(root_granted.note_count(&all), 1);

    let folder_granted = resolve("b", &["Projects"], &["", "projects/"]);
    assert!(
        !folder_granted.covers_folder(""),
        "a folder grant does not reach the root"
    );
    assert_eq!(folder_granted.note_count(&all), 1);
}

// ── canonical on both sides ─────────────────────────────────────────────────

#[test]
fn matching_is_case_and_diacritic_insensitive_and_still_exact() {
    let scope = resolve("a", &["Özel"], &["özel/", "özel/alt/"]);
    assert!(scope.covers_folder("ÖZEL"));
    assert!(scope.covers_folder("özel/"));
    assert!(
        !scope.covers_folder("Özel/Alt"),
        "case-insensitive is not the same as prefix-matching"
    );

    // A decomposed grant matches an NFC folder list.
    let decomposed = resolve("b", &["Cafe\u{301}"], &["caf\u{e9}/"]);
    assert!(decomposed.covers_folder("Café"));
    assert!(decomposed.missing().is_empty());
}

#[test]
fn the_resolved_set_does_not_follow_the_folder_list() {
    let map = grants(&[("a", &["Projects"])]);
    let before = resolve_scope("a", &map, &key_set(&["projects/"]));
    let after = resolve_scope("a", &map, &key_set(&["projects/", "projects/new/"]));
    assert_eq!(
        before.folders(),
        after.folders(),
        "a second resolve may report a new delta but may not widen the set"
    );
    assert!(before.delta().is_empty() && after.delta().len() == 1);
}

// ── what "exists now" means ────────────────────────────────────────────────

#[test]
fn existing_folders_synthesizes_ancestors_and_drops_archived_ones() {
    let mut records = index(&[("deep", Some("Projects/Deep")), ("root", None)]);
    records.insert("trashed".into(), hidden(Some("Trash")));
    let existing = existing_folders(
        &records,
        &strings(&["Empty", "Done"]),
        &strings(&["Done", "Projects/Deep/Old"]),
    );
    assert_eq!(
        existing,
        key_set(&["", "projects/", "projects/deep/", "empty/"]),
        "ancestors are synthesized, the archived folder and its children are gone, \
         and a trashed note's folder is not a folder the sidebar shows"
    );
}

#[test]
fn an_archived_folder_is_not_reported_as_outside_the_scope() {
    // Settings offers the delta to be added. Offering a folder the sidebar hides
    // would send the user looking for a folder they cannot see.
    let records = index(&[("a", Some("Projects"))]);
    let existing = existing_folders(&records, &strings(&["Old"]), &strings(&["Old"]));
    let scope = resolve_scope("a", &grants(&[("a", &["Projects"])]), &existing);
    assert!(scope.delta().is_empty());
}

// ── the per-folder counts ──────────────────────────────────────────────────

#[test]
fn folder_counts_list_every_granted_folder_including_an_empty_one() {
    let scope = resolve(
        "a",
        &["Projects", "Projects/Deep", "Empty"],
        &["projects/", "projects/deep/", "empty/"],
    );
    let records = index(&[
        ("one", Some("Projects")),
        ("two", Some("Projects")),
        ("three", Some("Projects/Deep")),
        ("out", Some("Elsewhere")),
        ("root", None),
    ]);
    let rows = scope.folder_counts(&records);
    let pairs: Vec<(Option<String>, usize)> = rows
        .iter()
        .map(|row| (row.folder.clone(), row.count))
        .collect();
    assert_eq!(
        pairs,
        vec![
            (Some("empty/".to_string()), 0),
            (Some("projects/".to_string()), 2),
            (Some("projects/deep/".to_string()), 1),
        ],
        "counted directly, not at-or-under: a note has exactly one folder"
    );
}
