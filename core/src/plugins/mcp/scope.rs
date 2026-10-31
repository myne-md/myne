// SPDX-License-Identifier: AGPL-3.0
//! What a named external connection may read, resolved from its stored grant.
//!
//! ## The narrowing is a DENY list of folder paths
//!
//! A connection may read the whole vault except the folders the user ticked on
//! the approval screen. That is the same shape the `myne` CLI's
//! `cli_excluded_folders` has, and the same reading applies: a folder created
//! after the approval is readable without a second one, because the grant names
//! what is OUT rather than what is in.
//!
//! **What that costs is stated rather than implied.** Under the previous,
//! allow-list model a folder created after approval started outside the scope
//! and Settings reported a delta row the user could add in one action. There is
//! no delta under a deny list: the new folder is covered the moment it exists.
//! The user's consent is therefore "everything in this vault except what I
//! ticked", and the approval screen says exactly that in words instead of
//! showing a count a reader could mistake for a frozen inventory.
//!
//! ## A legacy grant is REFUSED, not reinterpreted
//!
//! The released build minted the opposite model: an allow list in
//! [`protocol::McpConnectionGrant::folders`], frozen at approval. Those grants
//! are still decoded (so an upgrade neither drops nor inverts them) and they are
//! resolved to [`ConnectionScope::legacy`] with `is_granted` false, which the
//! tools answer as [`McpToolError::ReapprovalRequired`]. Reading an allow list as
//! a deny list would turn "only `private/`" into "everything except `private/`",
//! and the user would have no way to tell that from a working grant.
//!
//! ## An exclusion takes its subtree; the root is one folder
//!
//! Excluding `projects/` also excludes `projects/2026/`, because a user who
//! excludes a folder means the things in it. The ROOT is the exception and the
//! same one the folder-key module makes: `""` is the root folder, so excluding
//! it takes notes sitting at the vault root and nothing else. It is never a
//! prefix over the whole vault.
//!
//! `folder_matches_excluded` cannot be reused for this: it ignores an empty
//! entry on purpose, because in the AI and agent scopes an empty string there is
//! far more likely to be an accident than an instruction. Here the root is a
//! selectable folder on the approval screen, so dropping it would make a folder
//! the user could tick un-tickable in effect.
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
//! folder Settings should offer to exclude.
//!
//! **That subtraction is about the PICKER, not about enforcement**, and the
//! difference went the wrong way once. Under the retired allow-list model the
//! scope was resolved *against* this set, so "visible in the sidebar" and
//! "readable" were the same question and this paragraph could claim the two
//! surfaces agreed by construction. The deny-list flip broke that: an archived
//! folder is still readable (the scope subtracts exclusions, nothing else), so a
//! question about whether an exclusion still does something must be asked against
//! [`existing_folders_including_archived`]. Asked against this set, the answer
//! was "nothing", and an approval act would have written that answer down.

use crate::folder_key::{canonical_excluded, canonical_folder};
use crate::plugins::vault_indices::state::NoteRecord;
use protocol::{McpConnectionGrant, McpScopeModel};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

use super::error::McpToolError;

/// One readable folder and how many live notes sit directly in it.
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
/// [`is_granted`](Self::is_granted) false and nothing readable, so the refusal is
/// a property the tools can read rather than a `None` each of them has to
/// remember to handle. Every tool calls
/// [`require_granted`](Self::require_granted) first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionScope {
    name: String,
    granted: bool,
    /// The grant exists but was written under the retired allow-list model.
    legacy: bool,
    excluded: BTreeSet<String>,
}

impl ConnectionScope {
    /// The declared connection name this scope was resolved for.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Whether a servable grant exists for this name on this device.
    ///
    /// A revoked connection, a name that was never approved, and an approval
    /// written under the retired model all answer `false`. The last one is also
    /// [`is_legacy`](Self::is_legacy), which is what the tool layer turns into a
    /// distinct reason.
    pub fn is_granted(&self) -> bool {
        self.granted
    }

    /// Whether the stored grant predates the deny-list model, so the user has to
    /// approve the connection again before it can read anything.
    pub fn is_legacy(&self) -> bool {
        self.legacy
    }

    /// The excluded folder keys, sorted.
    pub fn excluded(&self) -> &BTreeSet<String> {
        &self.excluded
    }

    /// Whether a folder, given in ANY casing and with or without a trailing
    /// slash, is inside the scope.
    pub fn covers_folder(&self, folder: &str) -> bool {
        self.covers_key(&canonical_folder(folder))
    }

    /// [`covers_folder`](Self::covers_folder) for a key the caller already
    /// canonicalized, so a per-note loop pays the normalization once.
    ///
    /// A connection with no servable grant covers NOTHING, whatever its stored
    /// exclusions say: the counts and listings are answers about access this
    /// build enforces, and a legacy grant enforces none.
    pub fn covers_key(&self, folder_key: &str) -> bool {
        self.granted && !self.excluded_covers(folder_key)
    }

    /// Whether the exclusion set takes this key out: equal to one, or inside one.
    ///
    /// Delegates to [`exclusions_cover`](crate::folder_key::exclusions_cover) so
    /// the read scope, the write scope's subset check and the writer that stores a
    /// grant all apply one rule, including the root-is-equality-only case.
    fn excluded_covers(&self, key: &str) -> bool {
        crate::folder_key::exclusions_cover(&self.excluded, key)
    }

    /// How many live notes the scope covers right now.
    pub fn note_count(&self, records: &BTreeMap<String, NoteRecord>) -> usize {
        records
            .values()
            .filter(|record| record.live && self.covers_key(&folder_key_of(record)))
            .count()
    }

    /// How many of the folders that exist right now the scope covers.
    pub fn readable_folder_count(&self, existing: &BTreeSet<String>) -> usize {
        self.readable_folders(existing).len()
    }

    /// The folders that exist right now and are inside the scope, sorted.
    ///
    /// The approval screen needs this rather than its own filter, because a write
    /// grant must name a folder the connection may also READ: a picker that
    /// offered an excluded folder would let the user choose something the writer
    /// refuses, and the refusal would arrive as an unexplained failed approval.
    /// So the candidates are the host's answer, computed by the same rule the
    /// tools clamp with.
    pub fn readable_folders(&self, existing: &BTreeSet<String>) -> Vec<String> {
        existing
            .iter()
            .filter(|key| self.covers_key(key))
            .cloned()
            .collect()
    }

    /// How many stored exclusions name a folder that exists right now.
    ///
    /// An exclusion naming a folder the vault does not have excludes nothing, and
    /// counting it would tell the user they had excluded something they had not.
    pub fn live_exclusion_count(&self, existing: &BTreeSet<String>) -> usize {
        self.excluded
            .iter()
            .filter(|ex| exclusion_hits(existing, ex))
            .count()
    }

    /// The scope by folder, with note counts, sorted by key.
    ///
    /// Derived from the index rather than from the grant: under a deny list there
    /// is no stored list of readable folders to walk, and inventing one would be
    /// a second answer to "what may this connection see".
    pub fn folder_counts(&self, records: &BTreeMap<String, NoteRecord>) -> Vec<FolderCount> {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for record in records.values() {
            if !record.live {
                continue;
            }
            let key = folder_key_of(record);
            if !self.covers_key(&key) {
                continue;
            }
            *counts.entry(key).or_insert(0) += 1;
        }
        counts
            .into_iter()
            .map(|(key, count)| FolderCount {
                folder: if key.is_empty() { None } else { Some(key) },
                count,
            })
            .collect()
    }

    /// A granted scope over an ARBITRARY exclusion set: the approval screen's
    /// what-if, resolved through the same rule the stored grant goes through.
    ///
    /// It exists so the preview cannot be a second implementation of that rule.
    /// `grant_preview` counts what a candidate list would leave readable, and the
    /// only way those counts keep describing what the tools will enforce is for
    /// both to run this code.
    pub fn from_exclusions(name: &str, excluded: impl IntoIterator<Item = String>) -> Self {
        Self {
            name: name.to_string(),
            granted: true,
            legacy: false,
            excluded: excluded
                .into_iter()
                .map(|folder| canonical_folder(&folder))
                .collect(),
        }
    }

    /// Refuse a call from a connection with no servable grant.
    ///
    /// The first line of every tool. Kept on the scope rather than in each tool
    /// so the "empty scope, not an empty vault" rule has one home, and so a
    /// legacy approval cannot be served by a tool that forgot the distinction.
    pub fn require_granted(&self) -> Result<(), McpToolError> {
        if self.granted {
            Ok(())
        } else if self.legacy {
            Err(McpToolError::ReapprovalRequired)
        } else {
            Err(McpToolError::NoGrant)
        }
    }
}

/// The canonical folder key of one index record.
pub fn folder_key_of(record: &NoteRecord) -> String {
    canonical_folder(record.folder.as_deref().unwrap_or(""))
}

/// Resolve a connection name against the stored grants.
///
/// Pure, and reads no folder set: under this model what is readable does not
/// depend on which folders exist, so a resolution cannot drift as the vault
/// grows. The grant is never read from the caller's payload, and there is no
/// parameter through which a caller could name a folder it wants.
pub fn resolve_scope(name: &str, grants: &BTreeMap<String, McpConnectionGrant>) -> ConnectionScope {
    resolve_scope_with_quiet(name, grants, &[])
}

/// Resolve a connection name against the stored grants, and against the folders
/// the user has ALREADY told Myne to stay out of.
///
/// `quiet` is `ai_excluded_folders` and `cli_excluded_folders` together, and it is
/// subtracted from the reach in addition to the connection's own exclusions. The
/// union is the decision (`decisions/security/0753`, answering the question
/// myne-md/myne#923 left open): a person who excluded a folder from Myne's own AI
/// and from the terminal client has said "not this one" twice about the same vault,
/// and an external MCP client reaching it would be the third surface asking for the
/// same folder to be excluded a third time, on a screen that does not mention the
/// other two. Nothing is widened by this: the union can only take more out.
///
/// The approval screen renders the union through
/// [`ConnectionScope::from_exclusions`] too, so the counts a person decides on are
/// the counts the tools enforce.
pub fn resolve_scope_with_quiet(
    name: &str,
    grants: &BTreeMap<String, McpConnectionGrant>,
    quiet: &[String],
) -> ConnectionScope {
    // The stored name is the key. NFC normalization already happened on the way
    // in (`set_mcp_connection_grant`), and this side does not normalize: two
    // spellings that differ only by composition are two names, and treating them
    // as one here would make the revoke path disagree with the grant path.
    let Some(grant) = grants.get(name) else {
        return ConnectionScope {
            name: name.to_string(),
            granted: false,
            legacy: false,
            excluded: BTreeSet::new(),
        };
    };
    if matches!(grant.model, McpScopeModel::Folders) {
        return ConnectionScope {
            name: name.to_string(),
            granted: false,
            legacy: true,
            excluded: BTreeSet::new(),
        };
    }
    let mut excluded: BTreeSet<String> = grant
        .excluded_folders
        .iter()
        .map(|folder| canonical_folder(folder))
        .collect();
    excluded.extend(quiet.iter().map(|folder| canonical_folder(folder)));
    ConnectionScope {
        name: name.to_string(),
        granted: true,
        legacy: false,
        excluded,
    }
}

/// The folders the user has already excluded from every other AI surface, as one
/// list: `ai_excluded_folders` plus `cli_excluded_folders`.
///
/// One home for the union so the tool path, the Settings view and the approval
/// preview cannot disagree about what "already excluded" means.
pub fn quiet_folders(prefs: &crate::plugins::prefs::PrefsView) -> Vec<String> {
    prefs
        .ai_excluded_folders
        .iter()
        .chain(prefs.cli_excluded_folders.iter())
        .cloned()
        .collect()
}

/// Every folder path that exists in the vault right now, as canonical keys.
///
/// The sidebar's own derivation, host-side: live notes' folders plus every
/// ancestor, union the deliberately created empty folders, minus archived
/// folders. `archived` entries are subtracted by prefix, so archiving `Projects`
/// also hides `Projects/Sub`, exactly as the tree hides it.
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

/// Every folder the vault has, archived ones INCLUDED.
///
/// The distinction from [`existing_folders`] is load-bearing and was a silent
/// scope widening until the 2026-10-30 review. Archiving a folder hides it from
/// the sidebar, and the approval screen should not offer it as something to
/// exclude, which is why the picker subtracts it. But an EXCLUSION that already
/// names it is still enforced: [`ConnectionScope::covers_key`](super::scope)
/// consults the exclusion set and nothing else, so the deny list is not narrowed
/// by archiving.
///
/// So the two surfaces disagree on purpose, and every question of the form "does
/// this exclusion still do something" has to be asked against THIS set. Asked
/// against the sidebar's set instead, an approval would drop a live exclusion
/// (widening the reach past what the person was shown) and the row would report
/// it as stale (telling them a protection they still have is gone).
pub fn existing_folders_including_archived(
    records: &BTreeMap<String, NoteRecord>,
    deliberate: &[String],
) -> BTreeSet<String> {
    existing_folders(records, deliberate, &[])
}

/// Whether an exclusion names a folder the vault actually has: the key itself,
/// or something under it (an exclusion over a subtree whose leaf is gone still
/// excludes what is left of it).
pub(super) fn exclusion_hits(existing: &BTreeSet<String>, excluded: &str) -> bool {
    if excluded.is_empty() {
        return existing.contains("");
    }
    existing
        .iter()
        .any(|key| key == excluded || key.starts_with(excluded))
}
