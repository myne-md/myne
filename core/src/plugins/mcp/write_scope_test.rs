// SPDX-License-Identifier: AGPL-3.0
//! The write-scope resolver, held to the properties task 13's acceptance criteria
//! name. Every case is written with the `mcp_write_scope` prefix so
//! `cargo test -p myne-core mcp_write_scope` is the one command the feature's own
//! task row prescribes.
//!
//! The properties, and why each one is a test rather than a convention:
//!
//! - the write set is an ALLOW list of named folders, while the read set beside it
//!   is a deny list, so the two arrays carry opposite meanings in one record;
//! - an absent or empty write list means write NOWHERE, which is the inversion a
//!   later reader would reach for by analogy with `excluded_folders`;
//! - a named folder covers itself and not its subtree, so a folder created after
//!   the approval is not writable until it is named;
//! - the write set is bounded by the read set, including when the user excluded a
//!   folder after naming it for writing;
//! - a legacy grant serves neither half.

use super::error::McpToolError;
use super::write_scope::{resolve_write_scope, WriteRoute, WriteScope};
use protocol::{McpConnectionGrant, McpScopeModel};
use std::collections::BTreeMap;

/// A grant in the model this build writes, with no write scope: the shape every
/// connection approved before the write path existed has on disk.
fn read_only_grant(excluded: &[&str]) -> McpConnectionGrant {
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

/// A grant that also names folders the connection may write in.
fn writable_grant(excluded: &[&str], write: &[&str]) -> McpConnectionGrant {
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

/// A grant in the retired allow-list model: it names what may be READ and says
/// nothing about writing.
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

fn scope(name: &str, grant: Option<McpConnectionGrant>) -> WriteScope {
    let mut grants: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    if let Some(grant) = grant {
        grants.insert(name.to_string(), grant);
    }
    resolve_write_scope(name, &grants)
}

// ── the allow list ──────────────────────────────────────────────────────────

#[test]
fn mcp_write_scope_names_a_folder_and_covers_only_that_folder() {
    // Exact match and no subtree: the read denylist subtracts subtrees because
    // "leave out a folder" means the things inside it, while a write grant adds
    // nothing by prefix because the folder the user pictured is the one they
    // named. `Projects/2026/` was never named, so it is queued rather than
    // written.
    let scope = scope("claude", Some(writable_grant(&[], &["Projects/"])));
    assert!(scope.is_granted());
    assert!(scope.covers_folder("Projects"));
    assert!(scope.covers_folder("projects/"), "casing is not identity");
    assert!(!scope.covers_folder("Projects/2026"));
    assert_eq!(scope.route("Projects/"), WriteRoute::Apply);
    assert_eq!(scope.route("Projects/2026/"), WriteRoute::Queue);
}

#[test]
fn mcp_write_scope_empty_list_writes_nowhere_rather_than_everywhere() {
    // The whole point of the asymmetry: an empty `excluded_folders` means the
    // whole vault is readable, and an empty `write_folders` means nothing is
    // writable. Reading one by analogy with the other would grant writes across
    // the vault, so the reading is asserted on both the scope and the route.
    let scope = scope("claude", Some(read_only_grant(&[])));
    assert!(
        scope.is_granted(),
        "a read-only connection is still approved"
    );
    assert!(scope.writable().is_empty());
    assert!(!scope.covers_folder(""));
    assert!(!scope.covers_folder("Projects"));
    assert_eq!(scope.route("Projects/"), WriteRoute::Queue);
    assert_eq!(scope.route(""), WriteRoute::Queue);
}

#[test]
fn mcp_write_scope_treats_the_root_as_one_folder() {
    // Naming the root is naming one folder: notes filed at the top level, and
    // nothing under them. A prefix reading would make the root mean "everywhere",
    // which is the one grant this surface must not be able to express.
    let scope = scope("claude", Some(writable_grant(&[], &[""])));
    assert!(scope.covers_folder(""));
    assert!(!scope.covers_folder("Projects"));
    assert_eq!(scope.route(""), WriteRoute::Apply);
    assert_eq!(scope.route("Projects/"), WriteRoute::Queue);
}

// ── bounded by the read scope ───────────────────────────────────────────────

#[test]
fn mcp_write_scope_is_bounded_by_the_read_scope() {
    // A folder named for writing that is not readable would be a place a client
    // can put notes it can never find again, so the write scope is a subset and
    // the subset is enforced at call time rather than only at approval: a grant
    // edited by an older build, or by a build that never learnt the rule, cannot
    // be served past it.
    let scope = scope("claude", Some(writable_grant(&["Private/"], &["Private/"])));
    assert!(
        scope.writable().contains("private/"),
        "the stored set is what the user named, in canonical form"
    );
    assert!(!scope.covers_folder("Private"));
    match scope.route("Private/") {
        WriteRoute::Refuse(McpToolError::OutOfScopeFolder { folder }) => {
            assert_eq!(folder, "private/", "the refusal names the canonical key");
        }
        other => panic!("expected a refusal naming the folder, got {other:?}"),
    }
}

#[test]
fn mcp_write_scope_is_bounded_by_a_parent_exclusion() {
    // The exclusion side takes its subtree, so excluding `Projects/` takes
    // `Projects/2026/` out of the READ scope, and a write grant on the child is
    // therefore dead too. The two rules have to meet here: an implementation that compared write folders to exclusions by equality would
    // serve this write while the read beside it is refused.
    let scope = scope(
        "claude",
        Some(writable_grant(&["Projects/"], &["Projects/2026/"])),
    );
    assert!(!scope.covers_folder("Projects/2026"));
    assert!(matches!(
        scope.route("Projects/2026/"),
        WriteRoute::Refuse(McpToolError::OutOfScopeFolder { .. })
    ));
}

// ── no grant, and the retired model ─────────────────────────────────────────

#[test]
fn mcp_write_scope_of_an_unnamed_connection_is_empty_and_refused() {
    let scope = scope("claude", None);
    assert!(!scope.is_granted());
    assert!(scope.writable().is_empty());
    assert_eq!(scope.require_granted(), Err(McpToolError::NoGrant));
    match scope.route("Projects/") {
        WriteRoute::Refuse(McpToolError::NoGrant) => {}
        other => panic!("expected no_grant, got {other:?}"),
    }
}

#[test]
fn mcp_write_scope_of_a_legacy_grant_refuses_reapproval() {
    // The legacy grant names what may be READ, so this build has no write scope to
    // serve. It refuses rather than reading the absent list as writable, and the
    // reason differs from no_grant because the fix is a human re-approving a
    // connection that is already on screen.
    let scope = scope("claude", Some(legacy_grant(&["Projects/"])));
    assert!(scope.is_legacy());
    assert!(!scope.is_granted());
    assert!(scope.writable().is_empty());
    assert_eq!(
        scope.require_granted(),
        Err(McpToolError::ReapprovalRequired)
    );
    match scope.route("Projects/") {
        WriteRoute::Refuse(McpToolError::ReapprovalRequired) => {}
        other => panic!("expected reapproval_required, got {other:?}"),
    }
}

// ── the route itself ────────────────────────────────────────────────────────

#[test]
fn mcp_write_scope_routes_outside_the_grant_to_review_rather_than_refusing() {
    // A readable folder that was not named for writing is the one outcome that is
    // neither an apply nor a refusal: it becomes a review-card proposal, and the
    // caller is told so with its own reason. A plain refusal here would be answered
    // by a client retrying, and a retrying client looks exactly like a probing one.
    let scope = scope(
        "claude",
        Some(writable_grant(&["Private/"], &["Projects/"])),
    );
    assert_eq!(scope.route("Archive/"), WriteRoute::Queue);
    let reason = McpToolError::WriteQueuedForReview {
        folder: "archive/".to_string(),
    }
    .reason();
    assert_eq!(reason, "write_queued_for_review");
    assert_ne!(
        reason,
        McpToolError::OutOfScopeFolder {
            folder: "archive/".to_string()
        }
        .reason(),
        "queued and refused must stay tellable apart"
    );
}

#[test]
fn mcp_write_scope_resolution_is_pure_and_independent_of_the_read_scope_type() {
    // Resolved from the same map as the read scope, never derived from a resolved
    // read scope: the two lists run in opposite directions, so a conversion between
    // them is the bug this type exists to make unwritable.
    let grant = writable_grant(&["Private/"], &["Projects/", "Areas/"]);
    let mut grants: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    grants.insert("claude".to_string(), grant);

    let first = resolve_write_scope("claude", &grants);
    let second = resolve_write_scope("claude", &grants);
    assert_eq!(first, second);
    assert_eq!(
        first.writable().iter().cloned().collect::<Vec<_>>(),
        vec!["areas/".to_string(), "projects/".to_string()],
        "the set is canonical (lowercase keys) and sorted, so two spellings resolve to one scope"
    );
}
