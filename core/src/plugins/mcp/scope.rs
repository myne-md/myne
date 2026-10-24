// SPDX-License-Identifier: AGPL-3.0
//! What a named external connection may read, resolved from its stored grant.
//!
//! ## The frozen unit is the folder-path SET, not the note set
//!
//! This is the one place this module differs from the agent's scope model
//! (`super::super::agent::scope`), and the difference is deliberate rather than
//! an inconsistency to be tidied away later.
//!
//! The agent freezes note IDS because the agent can write the very tag or move
//! the very note that would widen its own grant, so a live predicate there is a
//! permission whose contents the grantee controls. A connection's read grant is
//! a folder list, and a note the user later puts in one of those folders is
//! inside it. Freezing note ids instead would make the grant DECAY as the user
//! works (`docs/vision.md`'s user adds a note and the agent silently loses
//! access to the folder they approved), which teaches the user to re-approve
//! without reading. That trade is worse than the thing it prevents.
//!
//! What a connection still cannot do is add a folder to its own grant: the grant
//! is a frozen set of PATHS, written only by the approval command, and a folder
//! created afterwards is outside it until the user adds it. That is why the set
//! is compared EXACTLY rather than by prefix: `Projects/New` created after an
//! approval of `Projects` is a folder the user was never asked about, and a
//! prefix rule would silently include it. The delta below is what makes that
//! visible instead of surprising (Settings reports the count, with a one-action
//! add).
//!
//! ## The root is a path like any other
//!
//! A note at the vault root has the canonical folder key `""`, so a grant that
//! contains `""` covers root notes and one that does not, does not. The empty
//! string is therefore NOT the "everything" wildcard it is in
//! `folder_matches_excluded` (where an empty entry is ignored precisely because
//! it would mean the whole vault). Here it is one folder, named: the root.
//!
//! ## Canonical on both sides
//!
//! Folder keys are [`canonical_folder`]'s output: NFC, lower-cased, empty
//! segments dropped, one trailing slash on everything non-empty. The stored
//! grant is already canonical (the approval command writes that form), and
//! canonicalizing it again on the way in costs one pass and removes the
//! "hand-edited or older-build prefs" case from every comparison after it.
//!
//! ## What "exists now" means
//!
//! The same derivation the sidebar uses, host-side: every live note's folder
//! plus its ancestors, union the deliberately created empty folders (MYND-144),
//! minus archived folders. A folder nobody can see in the sidebar is not a
//! folder Settings should offer to add, and it is not a folder a note can be
//! read from, so the two surfaces agree by construction rather than by review.

use crate::folder_key::{canonical_excluded, canonical_folder};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::McpConnectionGrant;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

use super::error::McpToolError;

/// One granted folder and how many live notes sit directly in it.
///
/// **Directly**, not "at or under": a note has exactly one `folder:` value, so
/// counting it in its ancestors too would report the same note more than once
/// and make the vault's shape look larger than it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCount {
    /// The canonical folder key, or `None` for the vault root.
    pub folder: Option<String>,
    /// Live notes whose `folder:` resolves to exactly this key.
    pub count: usize,
}

/// A connection's read scope, as it resolves at this moment.
///
/// Deliberately not an `Option`: "no such connection" is a scope with
/// [`is_granted`](Self::is_granted) false and nothing in it, so the refusal is a
/// property the tools can read rather than a `None` each of them has to remember
/// to handle. Every tool calls [`require_granted`](Self::require_granted) first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionScope {
    name: String,
    granted: bool,
    folders: BTreeSet<String>,
    missing: Vec<String>,
    delta: Vec<String>,
}

impl ConnectionScope {
    /// The declared connection name this scope was resolved for.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Whether a grant exists for this name on this device.
    ///
    /// A revoked connection and a name that was never approved both answer
    /// `false`, and they are the same situation from the caller's side: no
    /// approval, no access.
    pub fn is_granted(&self) -> bool {
        self.granted
    }

    /// The granted folder keys that still exist, sorted.
    pub fn folders(&self) -> &BTreeSet<String> {
        &self.folders
    }

    /// Granted paths that no longer exist, sorted.
    ///
    /// A rename lands here: the grant stores paths, so the old path is gone and
    /// Settings reports it rather than the grant quietly covering a different
    /// folder with the same name.
    pub fn missing(&self) -> &[String] {
        &self.missing
    }

    /// Folders that exist now and are not in the frozen set, sorted.
    ///
    /// This is the delta row: folders created after approval (plus every new
    /// folder under a granted one, because the comparison is exact). Nothing
    /// here is readable; the row exists so the user can see the count and add
    /// them in one action.
    pub fn delta(&self) -> &[String] {
        &self.delta
    }

    /// Whether a folder, given in ANY casing and with or without a trailing
    /// slash, is inside the scope.
    pub fn covers_folder(&self, folder: &str) -> bool {
        self.covers_key(&canonical_folder(folder))
    }

    /// [`covers_folder`](Self::covers_folder) for a key the caller already
    /// canonicalized, so a per-note loop pays the normalization once.
    pub fn covers_key(&self, folder_key: &str) -> bool {
        self.folders.contains(folder_key)
    }

    /// How many live notes the scope covers right now.
    pub fn note_count(&self, records: &BTreeMap<String, NoteRecord>) -> usize {
        records
            .values()
            .filter(|record| record.live && self.folders.contains(&folder_key_of(record)))
            .count()
    }

    /// The scope by folder, with note counts, sorted by key.
    ///
    /// A granted folder that holds no live notes is still listed with a count of
    /// zero: it is part of what the user approved, and dropping it would make
    /// "the folders this connection may read" a list that changes with the
    /// vault's contents rather than with the grant.
    pub fn folder_counts(&self, records: &BTreeMap<String, NoteRecord>) -> Vec<FolderCount> {
        let mut counts: BTreeMap<String, usize> =
            self.folders.iter().cloned().map(|key| (key, 0)).collect();
        for record in records.values() {
            if !record.live {
                continue;
            }
            if let Some(slot) = counts.get_mut(&folder_key_of(record)) {
                *slot += 1;
            }
        }
        counts
            .into_iter()
            .map(|(key, count)| FolderCount {
                folder: if key.is_empty() { None } else { Some(key) },
                count,
            })
            .collect()
    }

    /// Refuse a call from a connection with no grant.
    ///
    /// The first line of every tool. Kept on the scope rather than in each tool
    /// so the "empty scope, not an empty vault" rule has one home.
    pub fn require_granted(&self) -> Result<(), McpToolError> {
        if self.granted {
            Ok(())
        } else {
            Err(McpToolError::NoGrant)
        }
    }
}

/// The canonical folder key of one index record.
pub fn folder_key_of(record: &NoteRecord) -> String {
    canonical_folder(record.folder.as_deref().unwrap_or(""))
}

/// Resolve a connection name against the stored grants and the folder set.
///
/// Pure: `existing` is a snapshot the caller took, which is what lets the
/// freezing property be tested by resolving, changing the source, and resolving
/// again. The grant is never read from the caller's payload, and there is no
/// parameter through which a caller could name a folder it wants.
pub fn resolve_scope(
    name: &str,
    grants: &BTreeMap<String, McpConnectionGrant>,
    existing: &BTreeSet<String>,
) -> ConnectionScope {
    // The stored name is the key. NFC normalization already happened on the way
    // in (`set_mcp_connection_grant`), and this side does not normalize: two
    // spellings that differ only by composition are two names, and treating them
    // as one here would make the revoke path disagree with the grant path.
    let Some(grant) = grants.get(name) else {
        return ConnectionScope {
            name: name.to_string(),
            granted: false,
            folders: BTreeSet::new(),
            missing: Vec::new(),
            delta: Vec::new(),
        };
    };

    let granted_keys: BTreeSet<String> =
        grant.folders.iter().map(|f| canonical_folder(f)).collect();
    let folders: BTreeSet<String> = granted_keys
        .iter()
        .filter(|key| existing.contains(*key))
        .cloned()
        .collect();
    let missing: Vec<String> = granted_keys.difference(&folders).cloned().collect();
    let delta: Vec<String> = existing.difference(&granted_keys).cloned().collect();

    ConnectionScope {
        name: name.to_string(),
        granted: true,
        folders,
        missing,
        delta,
    }
}

/// Every folder path that exists in the vault right now, as canonical keys.
///
/// The sidebar's own derivation, host-side: live notes' folders plus every
/// ancestor, union the deliberately created empty folders, minus archived
/// folders. `archived` entries are subtracted by prefix, so archiving `Projects`
/// also hides `Projects/Sub` from the delta, exactly as the tree hides it.
pub fn existing_folders(
    records: &BTreeMap<String, NoteRecord>,
    deliberate: &[String],
    archived: &[String],
) -> BTreeSet<String> {
    let archived = canonical_excluded(archived);
    let mut out: BTreeSet<String> = BTreeSet::new();

    let mut add = |key: &str| {
        // The root is one folder, not a prefix of everything, so it is inserted
        // on its own and never used to synthesize ancestors.
        if key.is_empty() {
            out.insert(String::new());
            return;
        }
        let mut prefix = String::new();
        for segment in key.trim_end_matches('/').split('/') {
            prefix.push_str(segment);
            prefix.push('/');
            out.insert(prefix.clone());
        }
    };

    for record in records.values() {
        if record.live {
            add(&folder_key_of(record));
        }
    }
    for folder in deliberate {
        add(&canonical_folder(folder));
    }

    let visible = |key: &String| {
        !archived
            .iter()
            .any(|arch| !arch.is_empty() && key.starts_with(arch.as_str()))
    };
    out.into_iter().filter(visible).collect()
}
