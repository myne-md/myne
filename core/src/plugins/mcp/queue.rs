// SPDX-License-Identifier: AGPL-3.0
// The queue of writes a connection attempted into a folder it may READ but not
// WRITE (external-mcp-connection task 13; `decisions/ai/0752`).
//
// # A proposal, never a pending write
//
// Nothing in this module is applied. A request that lands here is a write the
// host refused, kept so that a person can accept it instead of losing it: accepting
// one extends that connection's write grant by exactly the folder it named, and the
// client retries against the wider scope it then holds. That is why the queue is a
// `vault.prefs` field rather than a log line: it survives a restart, it dies with
// the device-local grant it would widen, and it never leaves this machine
// (`sync-protocol.md` §10.2 classifies it `DeviceLocal` beside `mcp_connections`).
//
// # Why a refusal becomes a queue entry at all
//
// A plain `out_of_scope_folder` refusal is answered by a client retrying, and a
// client retrying is indistinguishable from a client probing. The entry is the
// difference between "no" and "not yet, ask the person who owns this vault", and it
// is the reason the caller's reason string differs (`write_queued_for_review`).
//
// # What this module does NOT decide
//
// Whether a write may be applied at all: that is [`WriteScope`](super::write_scope),
// which the tool layer consults first. This module is only the bookkeeping between
// "the host refused it" and "a person decided".

use protocol::{McpConnectionGrant, McpRequestKind, McpWriteRequest};

use crate::folder_key::canonical_input_folder;

/// How many requests the queue keeps.
///
/// Bounded by the writer rather than by the codec, because the prefs plaintext
/// budget already caps the whole blob and a client in a retry loop must not be
/// able to spend that budget on its own refusals. Eight is more rows than a person
/// will read on one card and far fewer than a loop produces.
pub const MAX_PENDING_WRITES: usize = 8;

/// Add one request to the queue, keeping it bounded and free of duplicates.
///
/// A second attempt at the same `(connection, folder, verb)` REPLACES the first
/// rather than joining it: the card should show what the client wants now, and a
/// retry loop must cost one row. The stamp of the newest attempt wins for the same
/// reason.
///
/// A request already in the queue for a DIFFERENT verb is kept beside the new one,
/// because "create a note here" and "append to a note here" are two decisions even
/// though they name one folder.
///
/// Returns whether the request is now in the queue. `false` means the cap was full
/// with rows belonging to other connections, and the caller MUST answer the client
/// with the plain out-of-scope refusal rather than `write_queued_for_review`: a row
/// that was never stored is a decision nobody will be shown.
pub fn enqueue(requests: &mut Vec<McpWriteRequest>, mut request: McpWriteRequest) -> bool {
    request.folder = canonical_input_folder(&request.folder);
    requests.retain(|existing| {
        !(existing.connection == request.connection
            && existing.folder == request.folder
            && existing.verb == request.verb
            && existing.kind == request.kind)
    });
    if requests.len() >= MAX_PENDING_WRITES {
        // At the cap, room is made inside THIS connection's own share and never
        // another's. Evicting a row another connection is waiting on would hand a
        // client the power to delete a decision somebody else was owed, which is
        // the same wrong as the silent drop `protocol.md` §9.5.2 refuses for a
        // missing member; refusing here tells the caller to answer with the plain
        // refusal instead of `write_queued_for_review`.
        let oldest_of_this_connection = requests
            .iter()
            .filter(|row| row.connection == request.connection)
            .min_by_key(|row| row.requested_at)
            .map(|row| (row.connection.clone(), row.folder.clone(), row.verb.clone()));
        match oldest_of_this_connection {
            Some((connection, folder, verb)) => requests.retain(|row| {
                !(row.connection == connection && row.folder == folder && row.verb == verb)
            }),
            None => return false,
        }
    }
    requests.push(request);
    // Newest first: what the person sees is what the client most recently wanted.
    requests.sort_by_key(|request| std::cmp::Reverse(request.requested_at));
    true
}

/// Remove every row for one `(connection, folder)` and return the newest.
///
/// Folder is matched in ANY casing and with or without a trailing slash, so a
/// caller that echoes the path the person clicked cannot miss the row the host
/// stored. **Every verb is removed, not one**: the person decided about the
/// FOLDER, which is the thing both accept and dismiss act on, so leaving a second
/// verb's row behind after that decision would keep offering a question that has
/// already been answered and report `false` on the next Accept.
pub fn take(
    requests: &mut Vec<McpWriteRequest>,
    connection: &str,
    folder: &str,
    kind: McpRequestKind,
) -> Option<McpWriteRequest> {
    let key = canonical_input_folder(folder);
    let mut taken: Option<McpWriteRequest> = None;
    requests.retain(|request| {
        if request.connection != connection || request.folder != key || request.kind != kind {
            return true;
        }
        // Stored order is newest-first per (connection, folder), which is the
        // encoder's rule, so the first row seen for this folder is the one the
        // person was reading on the card.
        if taken.is_none() {
            taken = Some(request.clone());
        }
        false
    });
    taken
}

/// What accepting one request would have to change, or why it cannot be accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcceptRefusal {
    /// No grant under that name: the row outlived a revocation, so there is
    /// nothing to widen.
    NoGrant,
    /// A grant written under the retired allow-list model. Approving it again is
    /// what rewrites it; a queue accept cannot, because it would be a second
    /// approval path with different rules.
    Legacy,
    /// The folder is not inside the read scope, so widening the WRITE scope to it
    /// would break the subset rule the whole write grant rests on.
    NotReadable,
}

/// Whether the folder a request named may be added to that connection's write
/// grant, checked against the grant as it is NOW.
///
/// The request was queued when the folder was readable-but-not-writable, and the
/// grant can have moved since: the user may have excluded that folder, or revoked
/// and re-approved. So this is a decision made at accept time against the current
/// grant, never a claim inherited from the queue entry.
pub fn accept_target(
    grant: Option<&McpConnectionGrant>,
    folder: &str,
    readable: impl Fn(&str) -> bool,
) -> Result<(), AcceptRefusal> {
    let Some(grant) = grant else {
        return Err(AcceptRefusal::NoGrant);
    };
    if !matches!(grant.model, protocol::McpScopeModel::Exclude) {
        return Err(AcceptRefusal::Legacy);
    }
    let key = canonical_input_folder(folder);
    if !readable(&key) {
        return Err(AcceptRefusal::NotReadable);
    }
    Ok(())
}

/// Why a queued READ request cannot be accepted as it stands
/// (mcp external access rework, myne-md/myne#1052).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadAcceptRefusal {
    /// No grant under that name.
    NoGrant,
    /// A grant in the retired allow-list model: re-approval is the only rewrite.
    Legacy,
    /// The folder is already readable, so there is nothing to widen. A stale row.
    NotExcluded,
    /// The folder is out because of `ai_excluded_folders` or
    /// `cli_excluded_folders`, not because of THIS grant. Accepting would have to
    /// edit another surface's exclusion, on a card that never mentioned it.
    ExcludedElsewhere,
    /// A PARENT folder is the stored exclusion. Removing the parent would also
    /// reveal its siblings, which is more than the card names, so this is refused
    /// and the person edits the scope themselves.
    CoveredByParent,
}

/// What accepting one read request would change: the new exclusion list, or why it
/// cannot be accepted.
///
/// The mirror of [`accept_target`], and the same discipline: the decision is made
/// against the grant as it is NOW, never against what the row claimed when it was
/// queued. Accepting can only ever NARROW the exclusion list by exactly one entry,
/// never re-derive it from the caller's request.
pub fn accept_read_target(
    grant: Option<&McpConnectionGrant>,
    folder: &str,
    quiet: &[String],
) -> Result<Vec<String>, ReadAcceptRefusal> {
    let Some(grant) = grant else {
        return Err(ReadAcceptRefusal::NoGrant);
    };
    if !matches!(grant.model, protocol::McpScopeModel::Exclude) {
        return Err(ReadAcceptRefusal::Legacy);
    }
    let key = canonical_input_folder(folder);
    let quiet_set: std::collections::BTreeSet<String> =
        crate::folder_key::canonical_excluded(quiet)
            .into_iter()
            .collect();
    if crate::folder_key::exclusions_cover(&quiet_set, &key) {
        return Err(ReadAcceptRefusal::ExcludedElsewhere);
    }
    let stored: std::collections::BTreeSet<String> =
        crate::folder_key::canonical_excluded(&grant.excluded_folders)
            .into_iter()
            .collect();
    if stored.contains(&key) {
        let mut next: Vec<String> = stored.into_iter().filter(|entry| entry != &key).collect();
        next.sort();
        return Ok(next);
    }
    if crate::folder_key::exclusions_cover(&stored, &key) {
        return Err(ReadAcceptRefusal::CoveredByParent);
    }
    Err(ReadAcceptRefusal::NotExcluded)
}

#[cfg(test)]
#[path = "queue_test.rs"]
mod queue_test;
