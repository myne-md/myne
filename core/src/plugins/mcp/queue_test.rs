// SPDX-License-Identifier: AGPL-3.0-only
// The external MCP write queue (external-mcp-connection task 13).
//
// What is asserted here is the bookkeeping a person's decision rests on: a retry
// loop costs one row rather than the prefs budget, the queue stays bounded, a
// folder is matched the way the host stored it rather than the way a click echoed
// it, and accepting a request is a decision made against the grant as it is NOW
// rather than against the claim the queue entry carried when it was written.

use protocol::{McpScopeModel, McpWriteRequest};

use super::{accept_target, enqueue, take, AcceptRefusal, MAX_PENDING_WRITES};

fn request(connection: &str, folder: &str, verb: &str, requested_at: u64) -> McpWriteRequest {
    McpWriteRequest {
        connection: connection.to_string(),
        folder: folder.to_string(),
        requested_at,
        summary: String::new(),
        verb: verb.to_string(),
        kind: protocol::McpRequestKind::Write,
    }
}

fn grant(model: McpScopeModel, write_folders: &[&str]) -> protocol::McpConnectionGrant {
    protocol::McpConnectionGrant {
        model,
        folders: Vec::new(),
        excluded_folders: Vec::new(),
        approved_at: 1_765_432_100,
        last_used_at: None,
        write_folders: write_folders.iter().map(|f| f.to_string()).collect(),
        disabled_verbs: Vec::new(),
    }
}

#[test]
fn mcp_write_queue_a_retry_loop_costs_one_row() {
    let mut queue = Vec::new();
    enqueue(
        &mut queue,
        request("claude-desktop", "Inbox", "note_create", 1),
    );
    enqueue(
        &mut queue,
        request("claude-desktop", "inbox/", "note_create", 2),
    );
    assert_eq!(queue.len(), 1, "one folder and one verb is one decision");
    assert_eq!(queue[0].requested_at, 2, "the newest attempt is the row");
    // The folder is stored canonical, so the card and the grant speak one spelling.
    assert_eq!(queue[0].folder, "inbox/");
}

#[test]
fn mcp_write_queue_keeps_the_newest_and_drops_the_oldest() {
    let mut queue = Vec::new();
    for index in 0..(MAX_PENDING_WRITES + 3) {
        assert!(
            enqueue(
                &mut queue,
                request(
                    "claude-desktop",
                    &format!("folder-{index}/"),
                    "note_create",
                    index as u64
                ),
            ),
            "one connection filling its own share is never refused"
        );
    }
    assert_eq!(
        queue.len(),
        MAX_PENDING_WRITES,
        "the queue is bounded by the writer, so a loop cannot spend the prefs budget"
    );
    assert_eq!(queue[0].requested_at, (MAX_PENDING_WRITES + 2) as u64);
    assert!(
        !queue.iter().any(|row| row.folder == "folder-0/"),
        "the oldest entry is the one a loop produced, so it is the one that goes"
    );
}

#[test]
fn mcp_write_queue_take_matches_any_spelling_of_the_folder() {
    let mut queue = Vec::new();
    enqueue(
        &mut queue,
        request("claude-desktop", "Projects/", "note_create", 1),
    );
    enqueue(
        &mut queue,
        request("claude-desktop", "Work/", "note_append", 1),
    );
    let taken = take(
        &mut queue,
        "claude-desktop",
        " projects ",
        protocol::McpRequestKind::Write,
    )
    .expect("the row is found");
    assert_eq!(taken.folder, "projects/");
    assert_eq!(queue.len(), 1, "the other connection row is untouched");
    assert!(
        take(
            &mut queue,
            "lm-studio",
            "Work/",
            protocol::McpRequestKind::Write
        )
        .is_none(),
        "a row belongs to the connection that caused it"
    );
    assert!(
        take(
            &mut queue,
            "claude-desktop",
            "Nowhere/",
            protocol::McpRequestKind::Write
        )
        .is_none(),
        "an unknown folder is a stale click, not an error"
    );
}

#[test]
fn mcp_write_queue_accepts_only_a_current_exclusion_grant() {
    // The grant can move between the refusal and the decision: revoked, rewritten
    // by an older build, or the folder itself excluded. Each answer is its own
    // refusal, because each tells the person something different.
    assert_eq!(
        accept_target(None, "inbox/", |_| true),
        Err(AcceptRefusal::NoGrant)
    );
    assert_eq!(
        accept_target(Some(&grant(McpScopeModel::Folders, &[])), "inbox/", |_| {
            true
        }),
        Err(AcceptRefusal::Legacy),
        "a legacy grant is rewritten by re-approval, not by a queue accept"
    );
    assert_eq!(
        accept_target(Some(&grant(McpScopeModel::Exclude, &[])), "inbox/", |_| {
            false
        }),
        Err(AcceptRefusal::NotReadable),
        "widening the write grant past the read scope would break the subset rule"
    );
    assert_eq!(
        accept_target(
            Some(&grant(McpScopeModel::Exclude, &[])),
            "Inbox",
            |key| key == "inbox/"
        ),
        Ok(()),
        "a readable folder is exactly what may be added to the write grant"
    );
}

#[test]
fn mcp_write_queue_a_request_is_a_proposal_and_carries_no_authority() {
    // Nothing in the entry says the write may proceed: it names what was attempted
    // and where, and the grant decides. This is the assertion that keeps a later
    // reader from treating the queue as a pending write.
    let mut queue = Vec::new();
    enqueue(
        &mut queue,
        request("claude-desktop", "inbox/", "note_create", 7),
    );
    let entry = &queue[0];
    assert_eq!(entry.verb, "note_create");
    assert_eq!(entry.folder, "inbox/");
    assert_eq!(
        accept_target(
            Some(&grant(McpScopeModel::Exclude, &[])),
            &entry.folder,
            |_| false
        ),
        Err(AcceptRefusal::NotReadable),
        "the entry cannot authorise itself, even for the folder it names"
    );
}

/// Evicting another connection's row would let one client delete the decision
/// another client's attempt earned, so at the cap this connection's own oldest
/// goes and a connection with no row of its own is REFUSED.
#[test]
fn mcp_write_queue_keeps_a_read_row_and_a_write_row_as_two_decisions() {
    let mut rows = Vec::new();
    assert!(enqueue(&mut rows, request("a", "Work/", "note_create", 10)));
    assert!(enqueue(
        &mut rows,
        McpWriteRequest {
            kind: protocol::McpRequestKind::Read,
            ..request("a", "Work/", "note_create", 11)
        }
    ));
    assert_eq!(
        rows.len(),
        2,
        "one row per kind is kept, not one per triple"
    );

    let read = take(&mut rows, "a", "Work/", protocol::McpRequestKind::Read);
    assert!(read.is_some());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, protocol::McpRequestKind::Write);
    assert!(take(&mut rows, "a", "Work/", protocol::McpRequestKind::Write).is_some());
    assert!(rows.is_empty());
}

#[test]
fn mcp_write_queue_eviction_frees_one_kind_and_not_both() {
    let mut rows = Vec::new();
    assert!(enqueue(&mut rows, request("a", "Work/", "note_create", 0)));
    assert!(enqueue(
        &mut rows,
        McpWriteRequest {
            kind: protocol::McpRequestKind::Read,
            ..request("a", "Work/", "note_create", 1)
        }
    ));
    for index in 0..(MAX_PENDING_WRITES - 2) {
        assert!(enqueue(
            &mut rows,
            request("a", &format!("F{index}/"), "note_create", 10 + index as u64)
        ));
    }
    assert_eq!(rows.len(), MAX_PENDING_WRITES);

    assert!(enqueue(&mut rows, request("a", "F9/", "note_create", 99)));
    assert_eq!(rows.len(), MAX_PENDING_WRITES);
    assert_eq!(
        rows.iter()
            .filter(|row| row.folder.eq_ignore_ascii_case("work/"))
            .count(),
        1,
        "the read row for that folder survived the eviction of its write sibling"
    );
    assert_eq!(
        rows.iter()
            .find(|row| row.folder.eq_ignore_ascii_case("work/"))
            .map(|row| row.kind),
        Some(protocol::McpRequestKind::Read)
    );
}

#[test]
fn mcp_write_queue_refuses_rather_than_evicting_another_connections_row() {
    let mut queue = Vec::new();
    for index in 0..MAX_PENDING_WRITES {
        assert!(enqueue(
            &mut queue,
            request(
                "someone-else",
                &format!("theirs-{index}/"),
                "note_create",
                index as u64
            ),
        ));
    }
    assert!(
        !enqueue(
            &mut queue,
            request("claude-desktop", "inbox/", "note_create", 99)
        ),
        "the queue is full of rows this client did not earn, so it is refused"
    );
    assert_eq!(queue.len(), MAX_PENDING_WRITES);
    assert!(
        queue
            .iter()
            .any(|row| row.connection == "someone-else" && row.folder == "theirs-0/"),
        "no row belonging to another connection was dropped"
    );
    // The same connection asking again may make room in its OWN share.
    assert!(enqueue(
        &mut queue,
        request("someone-else", "theirs-new/", "note_create", 100)
    ));
    assert!(
        !queue.iter().any(|row| row.folder == "theirs-0/"),
        "its own oldest is the row that goes"
    );
}

/// The person decided about the FOLDER, so one decision clears every verb queued
/// for it. Leaving a second row behind would keep offering a question already
/// answered, and the next Accept would report `false` about a grant it did widen.
#[test]
fn mcp_write_queue_take_clears_every_verb_queued_for_the_folder() {
    let mut queue = Vec::new();
    assert!(enqueue(
        &mut queue,
        request("claude-desktop", "inbox/", "note_create", 5),
    ));
    assert!(enqueue(
        &mut queue,
        request("claude-desktop", "inbox/", "note_append", 6),
    ));
    assert!(enqueue(
        &mut queue,
        request("claude-desktop", "other/", "note_create", 7),
    ));
    assert_eq!(queue.len(), 3);

    let taken = take(
        &mut queue,
        "claude-desktop",
        "inbox/",
        protocol::McpRequestKind::Write,
    )
    .expect("the row is found");
    assert_eq!(
        taken.requested_at, 6,
        "the newest of the two is the row the card showed"
    );
    assert!(
        !queue.iter().any(|row| row.folder == "inbox/"),
        "no phantom row survives for the folder the person decided about"
    );
    assert_eq!(queue.len(), 1, "another folder is untouched");
}

// ── the read kind: accepting NARROWS the exclusion list (myne-md/myne#1052) ──

/// A grant whose read scope leaves `excluded` out.
fn read_grant(excluded: &[&str]) -> protocol::McpConnectionGrant {
    protocol::McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: Vec::new(),
        excluded_folders: excluded.iter().map(|f| f.to_string()).collect(),
        approved_at: 1_765_432_100,
        last_used_at: None,
        write_folders: Vec::new(),
        disabled_verbs: Vec::new(),
    }
}

#[test]
fn accepting_a_read_request_removes_exactly_the_folder_it_names() {
    use super::accept_read_target;
    let grant = read_grant(&["Archive/", "Private/"]);
    let next = accept_read_target(Some(&grant), "Private/", &[]).expect("actionable");
    // Canonical form: the exclusion list is lower-cased with a trailing slash, so
    // the stored value is what the resolver compares against.
    assert_eq!(next, vec!["archive/".to_string()]);
}

#[test]
fn a_read_accept_is_refused_when_accepting_would_widen_more_than_the_card_says() {
    use super::{accept_read_target, ReadAcceptRefusal};
    // A parent folder is the stored exclusion: removing it would reveal its
    // siblings, which the card never named.
    let grant = read_grant(&["Projects/"]);
    assert_eq!(
        accept_read_target(Some(&grant), "Projects/2026/", &[]),
        Err(ReadAcceptRefusal::CoveredByParent)
    );
    // Another surface excluded it (Myne's own AI, the terminal client): accepting
    // here would have to edit that list, and the card never mentioned it.
    let grant = read_grant(&[]);
    assert_eq!(
        accept_read_target(Some(&grant), "Private/", &["Private/".to_string()]),
        Err(ReadAcceptRefusal::ExcludedElsewhere)
    );
    // Already readable: a stale row, not a decision.
    let grant = read_grant(&[]);
    assert_eq!(
        accept_read_target(Some(&grant), "Work/", &[]),
        Err(ReadAcceptRefusal::NotExcluded)
    );
}

#[test]
fn a_read_accept_of_a_revoked_or_legacy_grant_changes_nothing() {
    use super::{accept_read_target, ReadAcceptRefusal};
    assert_eq!(
        accept_read_target(None, "Work/", &[]),
        Err(ReadAcceptRefusal::NoGrant)
    );
    let legacy = grant(McpScopeModel::Folders, &[]);
    assert_eq!(
        accept_read_target(Some(&legacy), "Work/", &[]),
        Err(ReadAcceptRefusal::Legacy)
    );
}
