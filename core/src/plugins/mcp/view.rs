// SPDX-License-Identifier: AGPL-3.0
//! What Settings shows about external access, resolved host-side
//! (external-mcp-connection, myne-md/myne#923).
//!
//! ## Why this is not computed in the WebView
//!
//! The screen states counts: "412 notes in 38 folders", "3 folders created since
//! you approved this are not shared", "2 excluded". Every one of those is a
//! statement about SCOPE, and the scope is [`super::scope`]'s answer, resolved
//! from the stored grant against the vault's own folder set. A renderer that
//! summed a folder list itself would be a second opinion about the same
//! permission, and the two would drift the first time either changed: the screen
//! would describe a grant the tools do not enforce, which is worse than a screen
//! that shows nothing.
//!
//! So the counts are produced here, from the same [`resolve_scope`] the four read
//! tools call, and the renderer only formats them.
//!
//! ## Two views, and they answer different questions
//!
//! [`external_access_view`] is the SECTION: every approved connection, with the
//! counts of what each may read and the folders it is missing. [`grant_preview`]
//! is the APPROVAL SCREEN: what a candidate folder set would cover, given the
//! exclusions the user has ticked so far and before anything is written.
//!
//! The preview is not "the section with a filter": the section reads stored
//! grants, and at approval time there is no grant yet. It resolves the same
//! folder set through the same helpers so the number the user approves is the
//! number the tools will enforce.
//!
//! ## Nothing here reads a note body
//!
//! Every input is the vault index's metadata (title, folder, liveness) plus the
//! stored grant. No `.myn` is decrypted, so this module is safe to run on every
//! Settings render and the counts cannot leak a body into a screen.

use std::collections::{BTreeMap, BTreeSet};

use protocol::{McpConnectionGrant, PrefsView};
use serde::Serialize;

use crate::folder_key::canonical_folder;
use crate::plugins::vault_indices::state::NoteRecord;

use super::scope::{existing_folders, folder_key_of, resolve_scope};

/// One approved connection, as the connection list renders it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionView {
    /// The declared name the client announces. A LABEL, not a credential: see
    /// `protocol::McpConnectionGrant`'s doc comment.
    pub name: String,
    /// The granted folder paths that still exist, sorted. Empty is a real state
    /// (nothing is shared with this connection) and not an error.
    pub read_folders: Vec<String>,
    /// Granted paths that no longer exist, sorted. A rename lands here, which is
    /// how the row can say the grant no longer covers what it did.
    pub missing_folders: Vec<String>,
    /// The folders this connection may WRITE to. Always empty until the separate
    /// write grant lands (task 13 of the same feature): the read grant is the
    /// only authority that exists today, and reporting a write scope the host
    /// does not enforce would be the exact overstatement this screen exists to
    /// avoid.
    pub write_folders: Vec<String>,
    /// When the user approved this connection, Unix epoch seconds (the host's
    /// clock, stamped at the write).
    pub approved_at: u64,
    /// When this connection last reached the door, Unix epoch seconds, or `None`
    /// for "not since it was approved".
    pub last_used_at: Option<u64>,
    /// Live notes inside the readable folders right now.
    pub note_count: usize,
    /// Folders that exist now and are NOT in the frozen set, sorted. This is the
    /// delta row: non-zero means the grant has fallen behind the vault, and its
    /// length is the count the row states.
    pub delta_folders: Vec<String>,
}

/// The section's whole payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpExternalAccessView {
    /// Every approved connection, sorted by name (the grant map's own order).
    pub connections: Vec<McpConnectionView>,
    /// Every folder that exists now, sorted, as canonical keys (the root is
    /// `""`). The approval screen offers this set, so the user can see the
    /// folders they are about to share.
    pub folders: Vec<String>,
    /// Live notes in the vault, for the "N of M notes" framing.
    pub note_count: usize,
}

/// What a candidate grant would cover, before it is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGrantPreview {
    /// Live notes inside the candidate set.
    pub note_count: usize,
    /// Folders in the candidate set.
    pub folder_count: usize,
    /// Exclusions that name a folder which actually exists right now. An
    /// exclusion naming a folder the vault does not have changes nothing, and
    /// counting it would tell the user they had excluded something they had not.
    pub excluded_count: usize,
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
    let existing = existing_folders(records, &prefs.deliberate_folders, &prefs.archived_folders);
    let connections = prefs
        .mcp_connections
        .iter()
        .map(|(name, grant)| {
            connection_view(name, grant, &prefs.mcp_connections, &existing, records)
        })
        .collect();
    McpExternalAccessView {
        connections,
        folders: existing.into_iter().collect(),
        note_count: records.values().filter(|record| record.live).count(),
    }
}

fn connection_view(
    name: &str,
    grant: &McpConnectionGrant,
    grants: &BTreeMap<String, McpConnectionGrant>,
    existing: &BTreeSet<String>,
    records: &BTreeMap<String, NoteRecord>,
) -> McpConnectionView {
    let scope = resolve_scope(name, grants, existing);
    McpConnectionView {
        name: name.to_string(),
        read_folders: scope.folders().iter().cloned().collect(),
        missing_folders: scope.missing().to_vec(),
        write_folders: Vec::new(),
        approved_at: grant.approved_at,
        last_used_at: grant.last_used_at,
        note_count: scope.note_count(records),
        delta_folders: scope.delta().to_vec(),
    }
}

/// What `excluded` leaves of the vault, before anything is written.
///
/// The candidate set is every folder that exists now MINUS the exclusions, which
/// is the shape the approval screen promises: the user starts from everything and
/// takes away, so a folder they never looked at is shared rather than silently
/// absent.
///
/// ## Excluding a folder excludes what is inside it, and that is a decision
///
/// The GRANT matches a path EXACTLY (`scope.rs`), because a folder created after
/// approval must not be covered by a prefix the user never saw. An EXCLUSION is
/// the opposite act and takes the opposite rule: it is applied once, here, to the
/// candidate set, and a user who excludes `Projects` means the things in
/// `Projects`, subfolders included. The result is written as explicit paths
/// either way, so the stored grant is exactly the list this function returns, and
/// no later folder is ever covered by a rule nobody stated.
///
/// The root is the one exception: `""` is the root FOLDER, not a wildcard over
/// the vault (the same reading `scope.rs` records), so excluding it takes the
/// root notes and nothing else.
///
/// A folder created between this preview and the write lands outside the shared
/// set, which is the frozen-snapshot property rather than a lost exclusion.
pub fn grant_preview(
    prefs: &PrefsView,
    records: &BTreeMap<String, NoteRecord>,
    excluded: &[String],
) -> McpGrantPreview {
    let existing = existing_folders(records, &prefs.deliberate_folders, &prefs.archived_folders);
    let excluded_keys: BTreeSet<String> = excluded
        .iter()
        .map(|folder| canonical_folder(folder))
        .filter(|key| excluded_key_hits(&existing, key))
        .collect();
    let shared: BTreeSet<String> = existing
        .iter()
        .filter(|key| !excluded_by(&excluded_keys, key))
        .cloned()
        .collect();
    McpGrantPreview {
        note_count: records
            .values()
            .filter(|record| record.live && shared.contains(&folder_key_of(record)))
            .count(),
        folder_count: shared.len(),
        excluded_count: excluded_keys.len(),
    }
}

/// Whether an exclusion names a folder the vault actually has.
///
/// An exclusion that matches nothing changes nothing, and counting it would tell
/// the user they had excluded something they had not.
fn excluded_key_hits(existing: &BTreeSet<String>, excluded: &str) -> bool {
    if excluded.is_empty() {
        return existing.contains("");
    }
    existing
        .iter()
        .any(|key| key == excluded || key.starts_with(excluded))
}

/// Whether `key` is taken out by the exclusion set: equal to one, or inside one.
fn excluded_by(excluded: &BTreeSet<String>, key: &str) -> bool {
    if excluded.contains(key) {
        return true;
    }
    if key.is_empty() {
        // The root is a folder, never a prefix; it is caught by the equality
        // arm above or not at all.
        return false;
    }
    excluded
        .iter()
        .any(|ex| !ex.is_empty() && key.starts_with(ex.as_str()))
}
