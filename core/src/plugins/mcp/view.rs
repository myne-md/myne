// SPDX-License-Identifier: AGPL-3.0-only
//! What Settings shows about external access, resolved host-side
//! (external-mcp-connection, myne-md/myne#923).
//!
//! ## Why this is not computed in the WebView
//!
//! The screen states counts: "reads 398 notes in 37 folders", "3 folders left
//! out". Every one of those is a statement about SCOPE, and the scope is
//! [`super::scope`]'s answer, resolved from the stored grant against the vault's
//! own folder set. A renderer that did the arithmetic itself would be a second
//! opinion about the same permission, and the two would drift the first time
//! either changed: the screen would describe a grant the tools do not enforce,
//! which is worse than a screen that shows nothing.
//!
//! So the counts are produced here, from the same [`resolve_scope`] the four
//! readable tools call, and the renderer only formats them.
//!
//! ## Two views, and they answer different questions
//!
//! [`external_access_view`] is the SECTION: every approved connection, with the
//! counts of what each may read and the exclusions it carries.
//! [`grant_preview`] is the APPROVAL SCREEN: what a candidate exclusion list
//! would leave readable, before anything is written.
//!
//! ## Nothing here reads a note body
//!
//! Every input is the vault index's metadata (title, folder, liveness) plus the
//! stored grant. No `.myn` is decrypted, so this module is safe to run on every
//! Settings render and the counts cannot leak a body into a screen.

use std::collections::{BTreeMap, BTreeSet};

use protocol::{McpConnectionGrant, McpScopeModel, McpWriteRequest, PrefsView};
use serde::Serialize;

use crate::folder_key::canonical_input_folder;
use crate::plugins::vault_indices::state::NoteRecord;

use super::scope::{
    exclusion_hits, existing_folders, existing_folders_including_archived, quiet_folders,
    resolve_scope_with_quiet, ConnectionScope,
};
use super::write_scope::resolve_write_scope;

/// One verb, as the approval screen's switch bank renders it.
///
/// Two independent facts, and the screen needs both because they read the same way
/// on a switch and mean different things: `enabled` is what the PERSON chose, and
/// `available_in_build` is what this build can serve at all. A verb that is off
/// because the build has no implementation shows a reason rather than a control
/// that would do nothing (mcp external access rework, myne-md/myne#1052).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSwitchView {
    /// The wire name, which is what the grant stores.
    pub verb: String,
    /// Not disabled by the stored grant. This is the switch's position.
    pub enabled: bool,
    /// This build dispatches the verb.
    pub available_in_build: bool,
    /// Whether the verb changes the vault, so the screen can group reads from
    /// writes without a second roster.
    pub is_write: bool,
}

/// The read budget as the screen states it, so the number shown is the number
/// enforced rather than a copy that can drift from the constant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReadBudgetView {
    /// Notes one connection may take out per window.
    pub notes_per_window: u32,
    /// Length of that window, in seconds.
    pub window_seconds: u64,
}

/// One approved connection, as the connection list renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionView {
    /// The declared name the client announces. A LABEL, not a credential: see
    /// `protocol::McpConnectionGrant`'s doc comment.
    pub name: String,
    /// The connection was approved under the retired allow-list model, so this
    /// build refuses its calls until the user approves it again. The row states
    /// that rather than showing counts from a rule nothing enforces.
    pub legacy: bool,
    /// The legacy allow list, present only when `legacy` is true: what the
    /// connection could read under the old model. Shown so the user can see what
    /// they are re-approving rather than a row that simply stopped working.
    pub legacy_folders: Vec<String>,
    /// The folders this connection may NOT read, sorted. Empty is a real state
    /// under this model (it may read the whole vault) and the row says so in
    /// words rather than rendering an empty list.
    pub excluded_folders: Vec<String>,
    /// Stored exclusions that name a folder which no longer exists. They exclude
    /// nothing, and the row reports them so the count it shows is a count of what
    /// the exclusions actually take out.
    pub stale_excluded_folders: Vec<String>,
    /// The folders this connection may WRITE to. Always empty until the separate
    /// write grant lands (task 13 of the same feature): reporting a write scope
    /// the host does not enforce would be the exact overstatement this screen
    /// exists to avoid.
    pub write_folders: Vec<String>,
    /// When the user approved this connection, Unix epoch seconds (the host's
    /// clock, stamped at the write).
    pub approved_at: u64,
    /// When this connection last reached the door, Unix epoch seconds, or `None`
    /// for "not since it was approved".
    pub last_used_at: Option<u64>,
    /// Live notes the scope covers right now.
    pub note_count: usize,
    /// Folders of the vault the scope covers right now.
    pub folder_count: usize,
    /// One entry per catalog verb, in catalog order, with the person's choice and
    /// this build's capability kept apart.
    pub tools: Vec<McpToolSwitchView>,
}

/// The section's whole payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpExternalAccessView {
    /// Every approved connection, sorted by name (the grant map's own order).
    pub connections: Vec<McpConnectionView>,
    /// Every folder that exists now, sorted, as canonical keys (the root is
    /// `""`). The approval screen offers this set, so the user can pick the ones
    /// to leave out.
    pub folders: Vec<String>,
    /// Live notes in the vault, for the "N of M notes" framing.
    pub note_count: usize,
    /// Writes the connections attempted into folders they may read but not write,
    /// waiting for a person (task 13). Sorted newest first HERE rather than
    /// trusted from the blob: the canonical encoder orders by `(connection,
    /// folder, verb)` for byte stability, so the stored order is not a recency
    /// order and a card that read it as one would reshuffle after every reload.
    ///
    /// **Only the ones that can be accepted right now.** A request whose grant has
    /// gone, whose grant is legacy, or whose folder has been excluded since is not
    /// a decision the person can make here, so it is not offered: the view is what
    /// the card renders, and an Accept that the host then refuses would be a
    /// promise the surface cannot keep.
    pub write_requests: Vec<McpWriteRequestView>,
    /// The read budget, so the surface states the cap it enforces.
    pub read_budget: McpReadBudgetView,
    /// The verb catalog on its own, every switch enabled. The approval flow needs
    /// it for a connection that does not exist yet: a first-run vault has no
    /// stored row to read a catalog from, and a switch bank built from one would
    /// be empty on exactly the screen a new user sees.
    pub tool_catalog: Vec<McpToolSwitchView>,
}

/// One queued out-of-scope write, as the card renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpWriteRequestView {
    /// The connection that attempted it. Its grant is what accepting widens.
    pub connection: String,
    /// The folder it named, canonical.
    pub folder: String,
    /// When it asked, Unix epoch seconds.
    pub requested_at: u64,
    /// What it said it wanted to write: client-authored, USER TEXT (AS3-class).
    /// Shown to the person deciding and never logged.
    pub summary: String,
    /// The verb it called, so the card can say what was attempted.
    pub verb: String,
    /// `write` or `read`: which direction accepting moves the grant, and therefore
    /// which sentence the card shows and which command its accept calls
    /// (mcp external access rework, myne-md/myne#1052).
    pub kind: String,
}

/// What a candidate exclusion list would leave readable, before it is written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGrantPreview {
    /// Live notes still readable.
    pub note_count: usize,
    /// Folders still readable.
    pub folder_count: usize,
    /// Exclusions that name a folder which actually exists right now. An
    /// exclusion naming a folder the vault does not have excludes nothing, and
    /// counting it would tell the user they had left out something they had not.
    pub excluded_count: usize,
    /// The exclusion set itself, canonical and sorted: exactly the folders the
    /// counts above describe, and exactly what the approval writes.
    ///
    /// **It travels with the counts on purpose.** The exclusion rule (a folder
    /// takes its subtree with it, the root takes only itself) is decided here, so
    /// a caller that re-derived the set from the same inputs would be a second
    /// implementation of the rule, and the set approved would eventually stop
    /// being the set counted.
    pub excluded_folders: Vec<String>,
    /// The folders this candidate set still leaves READABLE, canonical and sorted.
    ///
    /// The write picker's candidates, and the reason they come from here rather
    /// than from the vault's folder list: a write grant must name a folder the
    /// connection may also read, so offering an excluded folder would let the user
    /// pick something the writer then refuses. Same rule, one implementation.
    pub folders: Vec<String>,
}

/// The section's view: every grant, resolved against the vault as it is now.
///
/// `records` is the index snapshot and `deliberate`/`archived` are the prefs
/// fields the sidebar itself derives the folder tree from, so "exists now" here
/// is the same answer the sidebar gives rather than a second definition.
pub fn external_access_view(
    prefs: &PrefsView,
    records: &BTreeMap<String, NoteRecord>,
) -> McpExternalAccessView {
    let quiet = quiet_folders(prefs);
    let existing = existing_folders(records, &prefs.deliberate_folders, &prefs.archived_folders);
    // Archived folders are omitted from the picker and INCLUDED here, because a
    // grant's exclusions have to be judged against every folder the vault has:
    // archiving does not narrow the deny list, so treating an archived exclusion as
    // one that does nothing would report a protection the user still has as gone.
    let known = existing_folders_including_archived(records, &prefs.deliberate_folders);
    let connections = prefs
        .mcp_connections
        .iter()
        .map(|(name, grant)| {
            connection_view(
                name,
                grant,
                &prefs.mcp_connections,
                &existing,
                &known,
                records,
                &quiet,
            )
        })
        .collect();
    let mut actionable: Vec<&McpWriteRequest> = prefs
        .mcp_write_requests
        .iter()
        .filter(|request| request_is_actionable(prefs, request))
        .collect();
    // Newest first HERE, because the stored order is the encoder's
    // `(connection, folder, verb)` and reading it as recency is how the card
    // reshuffles under the person between two reloads.
    actionable.sort_by_key(|request| {
        (
            std::cmp::Reverse(request.requested_at),
            request.connection.clone(),
            request.folder.clone(),
            request.verb.clone(),
        )
    });
    let write_requests = actionable
        .into_iter()
        .map(|request| McpWriteRequestView {
            connection: request.connection.clone(),
            folder: request.folder.clone(),
            requested_at: request.requested_at,
            summary: request.summary.clone(),
            verb: request.verb.clone(),
            kind: match request.kind {
                protocol::McpRequestKind::Write => "write".to_string(),
                protocol::McpRequestKind::Read => "read".to_string(),
            },
        })
        .collect();
    McpExternalAccessView {
        connections,
        folders: existing.into_iter().collect(),
        note_count: records.values().filter(|record| record.live).count(),
        write_requests,
        read_budget: McpReadBudgetView {
            notes_per_window: super::budget::NOTES_PER_WINDOW,
            window_seconds: super::budget::WINDOW_MS / 1000,
        },
        tool_catalog: super::tools::CATALOG_VERBS
            .iter()
            .map(|verb| {
                let available = super::tools::ToolName::from_wire(verb).is_some();
                McpToolSwitchView {
                    verb: (*verb).to_string(),
                    enabled: available,
                    available_in_build: available,
                    is_write: super::tools::ToolName::from_wire(verb)
                        .map(|tool| tool.is_write())
                        .unwrap_or(false),
                }
            })
            .collect(),
    }
}

/// Whether a queued request can be accepted against the vault as it is now.
///
/// Three ways it cannot: the connection has been revoked (nothing to widen), its
/// grant is legacy (re-approval is the only path that rewrites one), or the folder
/// has been excluded from the read scope since it was queued (accepting would
/// break the write-scope subset rule). The host's own accept path refuses the same
/// three, and the two agree because both ask
/// [`queue::accept_target`](super::queue::accept_target). This function only adds
/// the read-scope question, which that one takes as a closure.
fn request_is_actionable(prefs: &PrefsView, request: &McpWriteRequest) -> bool {
    let grant = prefs.mcp_connections.get(&request.connection);
    let scope = resolve_scope_with_quiet(
        &request.connection,
        &prefs.mcp_connections,
        &quiet_folders(prefs),
    );
    match request.kind {
        // A write request is actionable when the folder is readable, because the
        // write grant may never exceed the read scope.
        protocol::McpRequestKind::Write => {
            super::queue::accept_target(grant, &request.folder, |folder| {
                scope.covers_folder(folder)
            })
            .is_ok()
        }
        // A read request is actionable when accepting it would NARROW the exclusion
        // list by exactly the folder it names. A folder kept out by another surface's
        // list, or by a parent's exclusion, is not: accepting either would widen more
        // than the card says, so the row is not offered and the person edits the
        // scope themselves.
        protocol::McpRequestKind::Read => {
            super::queue::accept_read_target(grant, &request.folder, &quiet_folders(prefs)).is_ok()
        }
    }
}

/// One row, resolved against the vault as it is now.
///
/// Two folder sets, and they are not interchangeable: `existing` is the sidebar's
/// (archived subtracted, so the picker and the folder count match what a person
/// can see) and `known` is every folder the vault has (archived included, so an
/// exclusion is judged by the rule that actually enforces it).
fn connection_view(
    name: &str,
    grant: &McpConnectionGrant,
    grants: &BTreeMap<String, McpConnectionGrant>,
    existing: &BTreeSet<String>,
    known: &BTreeSet<String>,
    records: &BTreeMap<String, NoteRecord>,
    quiet: &[String],
) -> McpConnectionView {
    let scope = resolve_scope_with_quiet(name, grants, quiet);
    let legacy = scope.is_legacy();
    // Resolved through the WRITE resolver rather than read out of the grant, so the
    // row states what a write would actually be served under: a legacy grant writes
    // nowhere, and a folder named for writing but excluded from reading is dropped
    // here for the same reason the call-time check refuses it.
    let write = resolve_write_scope(name, grants);
    let write_folders: Vec<String> = write
        .writable()
        .iter()
        .filter(|key| write.covers_key(key))
        // And readable under the merged deny set: a folder excluded from Myne's own
        // AI or from the CLI is out of the read scope, and the write scope may never
        // exceed it. Without this the row would offer a folder the call-time subset
        // check refuses, which is the disagreement this row exists to prevent.
        .filter(|key| scope.covers_folder(key))
        .cloned()
        .collect();
    let excluded: Vec<String> = scope.excluded().iter().cloned().collect();
    let stale: Vec<String> = excluded
        .iter()
        .filter(|key| !exclusion_hits(known, key))
        .cloned()
        .collect();
    McpConnectionView {
        name: name.to_string(),
        legacy,
        legacy_folders: if legacy {
            grant.folders.clone()
        } else {
            Vec::new()
        },
        excluded_folders: excluded,
        stale_excluded_folders: stale,
        write_folders,
        approved_at: grant.approved_at,
        last_used_at: grant.last_used_at,
        // A legacy grant is served as "nothing" by this build, so the counts it
        // reports are zero rather than the reach of a rule no longer enforced.
        note_count: if legacy { 0 } else { scope.note_count(records) },
        folder_count: if legacy {
            0
        } else {
            scope.readable_folder_count(existing)
        },
        tools: tool_switches(&scope),
    }
}

/// The switch bank for one connection: every catalog verb, once.
///
/// A verb this build does not dispatch is reported with `enabled: false`
/// regardless of the stored set, because a switch shown on for something the host
/// answers as version skew is the overstatement the whole feature is written
/// against. The stored set is still reported through `enabled`, so a person who
/// had switched such a verb on in a later build and came back does not see it
/// silently rewritten.
fn tool_switches(scope: &ConnectionScope) -> Vec<McpToolSwitchView> {
    super::tools::CATALOG_VERBS
        .iter()
        .map(|verb| {
            let available = super::tools::ToolName::from_wire(verb).is_some();
            McpToolSwitchView {
                verb: (*verb).to_string(),
                enabled: available && !scope.is_verb_disabled(verb),
                available_in_build: available,
                is_write: super::tools::ToolName::from_wire(verb)
                    .map(|tool| tool.is_write())
                    .unwrap_or(false),
            }
        })
        .collect()
}

/// What `excluded` leaves readable, before anything is written.
///
/// The candidate scope is the whole vault MINUS the exclusions, which is the
/// shape the approval screen promises: the user starts from everything and takes
/// away, so a folder they never looked at is shared rather than silently absent.
///
/// ## Excluding a folder excludes what is inside it, and that is a decision
///
/// The exclusion is a prefix rule and it is the same rule the resolver applies
/// on every call ([`super::scope`]), so what the screen counts and what the tools
/// enforce cannot differ. The root is the one exception: `""` is the root FOLDER,
/// not a wildcard over the vault, so excluding it takes the root notes and
/// nothing else.
///
/// An exclusion that names nothing is dropped here rather than stored, so the
/// count the user approves is a count of exclusions that do something. A folder
/// created after this preview is covered by the approval, which is the property
/// that comes with a deny list and the reason the row states the rule in words.
pub fn grant_preview(
    prefs: &PrefsView,
    records: &BTreeMap<String, NoteRecord>,
    excluded: &[String],
) -> McpGrantPreview {
    let existing = existing_folders(records, &prefs.deliberate_folders, &prefs.archived_folders);
    // The filter below answers "does this exclusion still exclude anything", and
    // that question is about ENFORCEMENT rather than about what the sidebar shows:
    // a folder that is archived is still readable, so an exclusion naming it is
    // still doing work and dropping it here would widen the reach the moment the
    // dialog writes this preview back on approve. Judged against the sidebar's set
    // instead, it would be dropped, and only for being archived.
    let known = existing_folders_including_archived(records, &prefs.deliberate_folders);
    // The quiet set is counted in, because it is enforced in: the numbers on the
    // approval screen have to be the numbers a call is served under, and a folder
    // the user excluded from Myne's own AI is out of reach whether or not they also
    // tick it here.
    let mut excluded_keys: BTreeSet<String> = excluded
        .iter()
        .map(|folder| canonical_input_folder(folder))
        .filter(|key| exclusion_hits(&known, key))
        .collect();
    excluded_keys.extend(
        quiet_folders(prefs)
            .iter()
            .map(|folder| canonical_input_folder(folder))
            .filter(|key| exclusion_hits(&known, key)),
    );
    // Counted through the resolver's own rule rather than a copy of it: the set
    // the user approves and the scope a call is served under are the same code.
    let candidate = ConnectionScope::from_exclusions("", excluded_keys.iter().cloned());
    McpGrantPreview {
        note_count: candidate.note_count(records),
        folder_count: candidate.readable_folder_count(&existing),
        excluded_count: excluded_keys.len(),
        folders: candidate.readable_folders(&existing),
        excluded_folders: excluded_keys.into_iter().collect(),
    }
}

/// Whether a grant was written under the retired allow-list model.
///
/// Re-exported through this module for the Settings commands, which need the
/// answer before they resolve a scope (a legacy row has no counts to resolve).
pub fn is_legacy_model(grant: &McpConnectionGrant) -> bool {
    matches!(grant.model, McpScopeModel::Folders)
}
