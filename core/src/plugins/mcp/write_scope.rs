// SPDX-License-Identifier: AGPL-3.0-only
//! What a named external connection may WRITE, resolved from its stored grant.
//!
//! ## An ALLOW list, one record over from a deny list
//!
//! The read scope beside this one is a deny list: the connection reads the whole
//! vault except what the user left out, because reading a folder the user did not
//! think about is recoverable by revoking. Writing is not, so
//! [`McpConnectionGrant::write_folders`] names folders, and a folder nobody named
//! is not writable no matter how readable it is. `decisions/ai/0752`.
//!
//! ## Empty means NOWHERE, and that is the inversion to watch for
//!
//! An absent or empty write list is a connection that may write nowhere. It is
//! the opposite of the empty `excluded_folders` beside it, which means the whole
//! vault, and the two arrays are both folder paths, so a later implementation
//! reading this one by analogy would silently grant writes to every folder in the
//! vault. There is no input in this surface that expresses "everywhere".
//!
//! ## Exact match, with no subtree
//!
//! A write to `projects/2026/` is not covered by naming `projects/`. The read
//! denylist subtracts subtrees because "leave out a folder" means the things in
//! it; a write grant adds nothing by prefix, because the folder the user pictured
//! is the one they named. A folder created after the approval is therefore not
//! writable until it is named, which is the whole difference between the two
//! halves of the grant.
//!
//! ## The write set is bounded by the read set
//!
//! A folder that is writable but unreadable would be a place a client can put
//! notes it can never find again. The subset is enforced in three places, and the
//! third is the one that matters: the writer refuses to store a write folder
//! outside the read scope (`plugins/prefs/commands.rs`), [`WriteScope::covers_key`]
//! applies both conditions at call time so a grant that drifted after the approval
//! cannot be served, and the settings screen offers no folder it would refuse.
//!
//! ## Outside the grant is QUEUED, not refused
//!
//! A write into a readable folder the user did not name for writing is not
//! applied and is not dropped: it is routed to Myne's review card as a proposal,
//! and the caller is told
//! [`McpToolError::WriteQueuedForReview`] so it can tell "queued for a human" from
//! "refused". A plain refusal would be answered by a client retrying, and a
//! retrying client is indistinguishable from a probing one. A folder that is not
//! readable either is refused outright: there is nothing for a person to review
//! about a place the connection cannot see.

use crate::folder_key::{canonical_folder, exclusions_cover};
use protocol::{McpConnectionGrant, McpScopeModel};
use std::collections::{BTreeMap, BTreeSet};

use super::error::McpToolError;

/// What a connection may write in right now.
///
/// Resolved alongside [`ConnectionScope`](super::scope::ConnectionScope) from the
/// same stored grant, and deliberately a separate type: the two scopes read
/// opposite models off one record, and one struct carrying both would be the place
/// a caller eventually passes the wrong one to a verb.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteScope {
    name: String,
    /// A servable read grant exists for this name on this device.
    granted: bool,
    /// The grant exists but was written under the retired allow-list model.
    legacy: bool,
    /// The folders the user named for writing, canonical and exact-match.
    writable: BTreeSet<String>,
    /// The read scope's exclusions, so a write cannot land where a read cannot.
    excluded: BTreeSet<String>,
}

impl WriteScope {
    /// The declared connection name this scope was resolved for.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Whether a servable grant exists, which is the same condition the read
    /// tools require: a legacy grant serves neither half.
    pub fn is_granted(&self) -> bool {
        self.granted && !self.legacy
    }

    /// Whether the stored grant predates the deny-list model.
    pub fn is_legacy(&self) -> bool {
        self.legacy
    }

    /// The folders the user named for writing, sorted.
    ///
    /// The stored set, not filtered by the read scope: Settings shows the user what
    /// they named, and whether it is still readable is a separate question
    /// [`covers_key`](Self::covers_key) answers.
    pub fn writable(&self) -> &BTreeSet<String> {
        &self.writable
    }

    /// Whether a folder, in ANY casing and with or without a trailing slash, is
    /// writable right now.
    pub fn covers_folder(&self, folder: &str) -> bool {
        self.covers_key(&canonical_folder(folder))
    }

    /// [`covers_folder`](Self::covers_folder) for a key the caller already
    /// canonicalized.
    ///
    /// Three conditions, all of them load-bearing: a servable grant, a folder the
    /// read scope still covers, and the folder named for writing. The middle one
    /// is what stops a grant that drifted after the approval (the user later
    /// excluded a folder they had named for writing) from being served.
    pub fn covers_key(&self, folder_key: &str) -> bool {
        self.is_granted()
            && !exclusions_cover(&self.excluded, folder_key)
            && self.writable.contains(folder_key)
    }

    /// What to do about a write into this folder.
    ///
    /// The four outcomes are deliberately a type rather than a bool, so the caller
    /// cannot confuse "apply" with "queue" by testing for one condition and
    /// assuming the other.
    pub fn route(&self, folder: &str) -> WriteRoute {
        let key = canonical_folder(folder);
        if !self.is_granted() {
            return WriteRoute::Refuse(self.require_granted().expect_err("no servable grant"));
        }
        if exclusions_cover(&self.excluded, &key) {
            return WriteRoute::Refuse(McpToolError::OutOfScopeFolder {
                folder: key.clone(),
            });
        }
        if self.writable.contains(&key) {
            WriteRoute::Apply
        } else {
            WriteRoute::Queue
        }
    }

    /// Refuse a write verb from a connection with no servable grant.
    ///
    /// The two causes stay distinct because the caller's next action differs: an
    /// unapproved name is a configuration mistake, and a legacy approval is a human
    /// re-approving something that is on screen.
    pub fn require_granted(&self) -> Result<(), McpToolError> {
        if self.granted && !self.legacy {
            Ok(())
        } else if self.legacy {
            Err(McpToolError::ReapprovalRequired)
        } else {
            Err(McpToolError::NoGrant)
        }
    }
}

/// What a write into a folder should do, as data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteRoute {
    /// Inside the grant: the verb may apply.
    Apply,
    /// Readable but not named for writing: a review-card proposal, not an apply.
    Queue,
    /// Not servable: nothing is applied and nothing is queued.
    Refuse(McpToolError),
}

/// Resolve a connection name against the stored grants, for writing.
///
/// Pure, and symmetric with [`resolve_scope`](super::scope::resolve_scope): the
/// same map, the same name, the opposite model. A caller needs both scopes, so
/// resolving one from the other is refused on purpose, because the direction of
/// the two lists is exactly what a conversion would get wrong.
pub fn resolve_write_scope(
    name: &str,
    grants: &BTreeMap<String, McpConnectionGrant>,
) -> WriteScope {
    let Some(grant) = grants.get(name) else {
        return WriteScope {
            name: name.to_string(),
            granted: false,
            legacy: false,
            writable: BTreeSet::new(),
            excluded: BTreeSet::new(),
        };
    };
    if matches!(grant.model, McpScopeModel::Folders) {
        // A legacy grant names what it may READ and says nothing about writing, so
        // this build has no write scope to serve and refuses rather than treating
        // an absent list as writable.
        return WriteScope {
            name: name.to_string(),
            granted: false,
            legacy: true,
            writable: BTreeSet::new(),
            excluded: BTreeSet::new(),
        };
    }
    WriteScope {
        name: name.to_string(),
        granted: true,
        legacy: false,
        writable: grant
            .write_folders
            .iter()
            .map(|folder| canonical_folder(folder))
            .collect(),
        excluded: grant
            .excluded_folders
            .iter()
            .map(|folder| canonical_folder(folder))
            .collect(),
    }
}
