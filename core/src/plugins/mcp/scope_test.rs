// SPDX-License-Identifier: AGPL-3.0
//! The scope resolver, held to the properties the approval screen and the read
//! tools depend on under the DENY-list model: the whole vault is readable except
//! the folders the user took away, an exclusion takes its subtree with it, the
//! root is one folder, a folder created later is covered without a second
//! approval, and a grant written under the retired allow-list model refuses
//! instead of being read under the opposite rule.

use super::error::McpToolError;
use super::scope::{existing_folders, resolve_scope, resolve_scope_with_quiet, ConnectionScope};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::{McpConnectionGrant, McpScopeModel};
use std::collections::{BTreeMap, BTreeSet};

// ── fixtures ────────────────────────────────────────────────────────────────

fn key_set(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|p| p.to_string()).collect()
}

/// A grant in the model this build writes: an exclusion list, so an empty slice
/// means the whole vault.
fn exclusion_grant(excluded: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: Vec::new(),
    }
}

/// A grant in the released model: an allow list, frozen at approval.
fn legacy_grant(folders: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Folders,
        folders: folders.iter().map(|f| f.to_string()).collect(),
        excluded_folders: Vec::new(),
        approved_at: 1_700_000_000,
        last_used_at: None,
        write_folders: Vec::new(),
    }
}

fn grants(pairs: &[(&str, McpConnectionGrant)]) -> BTreeMap<String, McpConnectionGrant> {
    pairs
        .iter()
        .map(|(name, grant)| ((*name).to_string(), grant.clone()))
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

fn resolve(name: &str, excluded: &[&str]) -> ConnectionScope {
    resolve_scope(name, &grants(&[(name, exclusion_grant(excluded))]))
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ── the whole vault is the default ──────────────────────────────────────────

#[test]
fn an_approval_with_no_exclusions_reads_every_folder_including_the_root() {
    let scope = resolve("claude-desktop", &[]);
    assert!(scope.is_granted());
    assert!(scope.excluded().is_empty());
    for folder in ["", "Inbox", "Projects", "Projects/2026/Deep", "Archive"] {
        assert!(scope.covers_folder(folder), "{folder} must be readable");
    }
    assert_eq!(
        scope.note_count(&index(&[("a", Some("Projects")), ("b", None)])),
        2
    );
}

#[test]
fn a_folder_created_after_approval_is_covered_without_a_second_approval() {
    // The property that comes with a deny list, and the one the old model did not
    // have: consent is "everything except what I ticked", so a new folder is
    // inside it. Stated as a test because it is the whole reason to prefer this
    // model, and the cost (no delta row to offer) is stated in the module doc.
    let scope = resolve("claude-desktop", &["Private"]);
    let before = index(&[("a", Some("Projects"))]);
    let after = index(&[
        ("a", Some("Projects")),
        ("b", Some("Projects/New")),
        ("c", Some("Brand New")),
    ]);
    assert_eq!(scope.note_count(&before), 1);
    assert_eq!(scope.note_count(&after), 3);
}

// ── an exclusion takes its subtree, and a sibling is not one ───────────────

#[test]
fn excluding_a_folder_excludes_everything_under_it() {
    let scope = resolve("a", &["Private"]);
    assert!(!scope.covers_folder("Private"));
    assert!(
        !scope.covers_folder("Private/2026"),
        "a user who excludes a folder means the things in it"
    );
    assert!(!scope.covers_folder("private/2026/q1/"));
    assert!(scope.covers_folder("Projects"));
}

#[test]
fn a_shared_prefix_is_not_a_subtree() {
    // The failure this prevents: `private/` excluding `PrivateStuff`, which would
    // take away a folder the user never ticked. The trailing slash in the
    // canonical key is what makes one prefix test correct in both directions.
    let scope = resolve("a", &["Private"]);
    assert!(scope.covers_folder("PrivateStuff"));
    assert!(scope.covers_folder("Private Stuff"));
    assert!(scope.covers_folder("Privateish/Deep"));
}

#[test]
fn an_exclusion_written_in_any_casing_or_composition_still_matches() {
    // The stored set is canonicalized on the way in, so a grant hand-edited or
    // written by another build cannot quietly stop excluding.
    let scope = resolve("a", &["ÖZEL", "Cafe\u{301}"]);
    assert!(!scope.covers_folder("özel"));
    assert!(!scope.covers_folder("Özel/Alt"));
    assert!(!scope.covers_folder("Café"));
    assert_eq!(
        scope.excluded(),
        &key_set(&["café/", "özel/"]),
        "the resolved set is canonical, not the stored spelling"
    );
}

// ── the root is one folder, not a wildcard ─────────────────────────────────

#[test]
fn excluding_the_root_takes_the_root_notes_and_nothing_else() {
    let all = index(&[("root", None), ("in-folder", Some("Projects"))]);
    let scope = resolve("a", &[""]);
    assert!(!scope.covers_folder(""));
    assert!(
        scope.covers_folder("Projects"),
        "the root is a folder, not a prefix over the vault"
    );
    assert_eq!(scope.note_count(&all), 1);

    // And the mirror image: excluding a folder leaves the root readable, which is
    // the case that would break if an empty key were ever used as a prefix.
    let folder_excluded = resolve("b", &["Projects"]);
    assert!(folder_excluded.covers_folder(""));
    assert_eq!(folder_excluded.note_count(&all), 1);
}

// ── the retired model refuses rather than inverting ────────────────────────

#[test]
fn a_legacy_allow_list_grant_refuses_and_names_reapproval() {
    // The important test in this file. Read as a deny list, "only Private/" would
    // become "everything except Private/", which is the same bytes with the
    // opposite meaning, and nothing on screen would say so.
    let scope = resolve_scope(
        "claude-desktop",
        &grants(&[("claude-desktop", legacy_grant(&["Private"]))]),
    );
    assert!(!scope.is_granted());
    assert!(scope.is_legacy());
    assert_eq!(
        scope.require_granted(),
        Err(McpToolError::ReapprovalRequired),
        "a distinct reason, because the caller's next action is the human's"
    );
    assert!(
        !scope.covers_folder("Private"),
        "nothing is readable, not even the folder the old grant named"
    );
    assert_eq!(
        scope.note_count(&index(&[("a", Some("Private"))])),
        0,
        "the counts describe what this build serves, which is nothing"
    );
}

#[test]
fn a_legacy_grant_still_holds_the_folders_it_was_written_with() {
    // Kept on the resolved scope's source grant so Settings can show what the user
    // is re-approving instead of a row that simply stopped working.
    let map = grants(&[("cursor", legacy_grant(&["Projects", "Inbox"]))]);
    assert_eq!(map["cursor"].folders.len(), 2);
    let scope = resolve_scope("cursor", &map);
    assert!(
        scope.excluded().is_empty(),
        "a legacy grant exludes nothing"
    );
}

// ── a name with no grant ────────────────────────────────────────────────────

#[test]
fn an_unknown_connection_name_resolves_to_an_empty_scope_that_refuses() {
    let map = grants(&[("claude-desktop", exclusion_grant(&[]))]);
    let scope = resolve_scope("never-approved", &map);
    assert!(!scope.is_granted());
    assert!(
        !scope.is_legacy(),
        "nothing was approved, so nothing is stale"
    );
    assert!(scope.excluded().is_empty());
    assert_eq!(scope.require_granted(), Err(McpToolError::NoGrant));
    assert_eq!(scope.name(), "never-approved");
}

#[test]
fn a_revoked_name_is_the_same_case_as_one_never_approved() {
    let map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    let scope = resolve_scope("claude-desktop", &map);
    assert!(!scope.is_granted());
    assert_eq!(scope.require_granted(), Err(McpToolError::NoGrant));
}

#[test]
fn two_names_resolve_to_their_own_exclusions() {
    let map = grants(&[
        ("claude-desktop", exclusion_grant(&["Private"])),
        ("cursor", exclusion_grant(&["Archive"])),
    ]);
    let claude = resolve_scope("claude-desktop", &map);
    let cursor = resolve_scope("cursor", &map);
    assert!(!claude.covers_folder("Private") && claude.covers_folder("Archive"));
    assert!(!cursor.covers_folder("Archive") && cursor.covers_folder("Private"));
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
fn the_readable_folder_count_follows_the_existing_set() {
    // Under a deny list the count is derived, not stored: it is the vault's own
    // folder set minus what the exclusions take out.
    let records = index(&[
        ("a", Some("Projects")),
        ("b", Some("Projects/Deep")),
        ("c", Some("Private")),
    ]);
    let existing = existing_folders(&records, &[], &[]);
    assert_eq!(
        existing,
        key_set(&["private/", "projects/", "projects/deep/"]),
        "no root note exists, so the root is not in the folder set"
    );
    assert_eq!(
        resolve("a", &["Private"]).readable_folder_count(&existing),
        2
    );
    assert_eq!(resolve("a", &[]).readable_folder_count(&existing), 3);
    assert_eq!(
        resolve("a", &["Projects"]).readable_folder_count(&existing),
        1,
        "excluding Projects takes Projects/Deep with it"
    );
}

// ── the per-folder counts ──────────────────────────────────────────────────

#[test]
fn folder_counts_are_derived_from_the_index_and_omit_excluded_folders() {
    let scope = resolve("a", &["Private"]);
    let records = index(&[
        ("one", Some("Projects")),
        ("two", Some("Projects")),
        ("three", Some("Projects/Deep")),
        ("secret", Some("Private")),
        ("deep-secret", Some("Private/2026")),
        ("root", None),
    ]);
    let rows: Vec<(Option<String>, usize)> = scope
        .folder_counts(&records)
        .iter()
        .map(|row| (row.folder.clone(), row.count))
        .collect();
    assert_eq!(
        rows,
        vec![
            (None, 1),
            (Some("projects/".to_string()), 2),
            (Some("projects/deep/".to_string()), 1),
        ],
        "counted directly, not at-or-under: a note has exactly one folder"
    );

    // A trashed note is not part of the working set, so its folder is not listed
    // even though the folder exists.
    let mut with_trash = records.clone();
    with_trash.insert("hidden".into(), hidden(Some("Projects")));
    assert_eq!(
        scope
            .folder_counts(&with_trash)
            .iter()
            .find(|row| row.folder.as_deref() == Some("projects/"))
            .map(|row| row.count),
        Some(2)
    );
}

#[test]
fn a_note_moved_into_an_excluded_folder_leaves_the_scope() {
    let scope = resolve("lm-studio", &["Private"]);
    assert_eq!(scope.note_count(&index(&[("a", Some("Projects"))])), 1);
    assert_eq!(scope.note_count(&index(&[("a", Some("Private"))])), 0);
}

// ── stale exclusions ───────────────────────────────────────────────────────

#[test]
fn an_exclusion_naming_a_folder_the_vault_does_not_have_is_counted_as_stale() {
    // The exclusion is kept (a folder that comes back is still excluded) but it is
    // not counted as one that takes something away, because telling the user they
    // had excluded something they had not is the smaller version of the same lie.
    let records = index(&[("a", Some("Projects"))]);
    let existing = existing_folders(&records, &[], &[]);
    let scope = resolve("a", &["Private", "Deleted", "Projects"]);
    assert_eq!(scope.live_exclusion_count(&existing), 1, "only Projects");
    assert_eq!(
        scope.excluded().len(),
        3,
        "the stored set is preserved verbatim"
    );

    // An exclusion over a subtree whose leaf is gone still excludes what is left.
    let deep = index(&[("a", Some("Projects/Deep"))]);
    let deep_existing = existing_folders(&deep, &[], &[]);
    assert_eq!(
        resolve("a", &["Projects"]).live_exclusion_count(&deep_existing),
        1
    );
}

#[test]
fn the_resolver_reads_the_grant_and_nothing_else() {
    // No parameter through which the folder list, or the caller, can widen or
    // narrow the scope: the same grant resolves to the same scope whatever the
    // vault contains, which is what makes the deny list stable under writes.
    let map = grants(&[("a", exclusion_grant(&["Private"]))]);
    let first = resolve_scope("a", &map);
    let second = resolve_scope("a", &map);
    assert_eq!(first, second);
    assert_eq!(first.excluded(), &key_set(&["private/"]));
}

// ── the folders other AI surfaces were already kept out of ──────────────────

/// A folder the user excluded from Myne's own AI is out of an external
/// connection's reach too, without a second exclusion on the approval screen.
///
/// `decisions/security/0753`, answering the question myne-md/myne#923 left open.
/// The failure this prevents is not a widened grant but a third consent prompt the
/// screen never shows: two exclusions already say "not this folder", and a client
/// reading it because the third list is empty is the same folder being handed over
/// after the user answered twice.
#[test]
fn the_ai_and_cli_exclusions_are_subtracted_from_a_connections_reach() {
    let grants = grants(&[("cursor", exclusion_grant(&[]))]);
    let quiet = strings(&["journal/", "Clients/2025"]);

    let scope = resolve_scope_with_quiet("cursor", &grants, &quiet);

    assert!(scope.is_granted());
    assert!(!scope.covers_folder("journal"));
    assert!(
        !scope.covers_folder("journal/2026"),
        "an exclusion takes its subtree"
    );
    assert!(!scope.covers_folder("clients/2025/acme"));
    assert!(
        scope.covers_folder("notes"),
        "unrelated folders stay readable"
    );
    assert!(scope.covers_folder(""), "the root stays readable");
}

/// The union can only ever take MORE out. A connection whose own list is empty
/// reads nothing extra, and `resolve_scope` with no quiet set is unchanged, so the
/// decision cannot silently narrow an existing approval either.
#[test]
fn the_quiet_union_narrows_and_never_widens() {
    let grants = grants(&[("cursor", exclusion_grant(&["private/"]))]);
    let with_quiet = resolve_scope_with_quiet("cursor", &grants, &strings(&["journal/"]));
    let without = resolve_scope("cursor", &grants);

    assert!(with_quiet.excluded().contains("private/"));
    assert!(with_quiet.excluded().contains("journal/"));
    assert_eq!(with_quiet.excluded().len(), 2);
    assert_eq!(without.excluded().len(), 1);
    for folder in ["", "notes", "projects"] {
        assert_eq!(
            with_quiet.covers_folder(folder),
            without.covers_folder(folder),
            "quiet must not touch a folder it does not name: {folder}"
        );
    }
}

/// A legacy grant stays legacy even with a quiet set: the union narrows a
/// servable scope, it does not turn a refused one into a served one.
#[test]
fn a_quiet_set_does_not_make_a_legacy_grant_servable() {
    let grants = grants(&[("cursor", legacy_grant(&["Work/"]))]);
    let scope = resolve_scope_with_quiet("cursor", &grants, &strings(&["journal/"]));

    assert!(scope.is_legacy());
    assert!(!scope.is_granted());
    assert!(scope.excluded().is_empty());
}
