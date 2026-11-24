// SPDX-License-Identifier: AGPL-3.0-only
//! Full-reconcile primitive (MYND-424 task 8; MYND-426 invokes it).
//!
//! Triggered when the incremental cursor is no longer trustworthy — a
//! `410 cursor_expired` or a soft-retire return (the device was offline past the
//! GC horizon). The cursor can't tell us what changed, so we reconcile the whole
//! vault against the **authoritative manifest** the verified head commits
//! (`uuid → content_nonce`, the §4.2 manifest this client now decodes).
//!
//! The three-way classification of each local blob is the load-bearing part —
//! it must distinguish "deleted remotely" from "new local work", or it would
//! either resurrect a deleted note or silently lose an unsynced one:
//!
//! | local? | in authoritative? | previously synced? | action |
//! |--------|-------------------|--------------------|--------|
//! | yes    | yes, same nonce   | —                  | up to date (no-op) |
//! | yes    | yes, diff nonce   | —                  | **download** (remote newer) |
//! | no     | yes               | —                  | **download** (missing locally) |
//! | yes    | no                | yes                | **drop** (deleted/GC'd remotely — no resurrection) |
//! | yes    | no                | no                 | **keep local-only** (new local work — no silent loss) |
//!
//! The "previously synced" set (the ids this device has ever seen in a manifest)
//! is what separates a remote deletion from never-pushed local work — MYND-426
//! threads it from the device-local sync state.

use std::collections::{HashMap, HashSet};

/// The actions a full reconcile resolves to (all by 16-byte blob id).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcilePlan {
    /// Blobs to download from the server (missing locally, or a newer remote
    /// `content_nonce`).
    pub download: Vec<[u8; 16]>,
    /// Blobs to drop locally — gone from the authoritative manifest AND
    /// previously synced ⇒ a remote deletion / horizon-GC. Never a resurrection.
    pub drop: Vec<[u8; 16]>,
    /// Local-only blobs to keep — absent from the authoritative manifest and
    /// never synced ⇒ new local work the device must preserve (and push next).
    pub keep_local_only: Vec<[u8; 16]>,
}

/// Reconcile the local blob set against the authoritative manifest.
///
/// - `authoritative`: the head-committed `id → content_nonce` (§4.2).
/// - `local`: the device's current `id → content_nonce`.
/// - `previously_synced`: every id this device has ever observed in a manifest
///   (from the device-local sync state) — the deleted-vs-new discriminator.
pub fn reconcile(
    authoritative: &HashMap<[u8; 16], [u8; 24]>,
    local: &HashMap<[u8; 16], [u8; 24]>,
    previously_synced: &HashSet<[u8; 16]>,
) -> ReconcilePlan {
    let mut plan = ReconcilePlan::default();

    // Authoritative → download anything missing or with a different nonce.
    for (id, remote_nonce) in authoritative {
        match local.get(id) {
            Some(local_nonce) if local_nonce == remote_nonce => {} // up to date
            _ => plan.download.push(*id),
        }
    }

    // Local blobs absent from the authoritative manifest: drop iff previously
    // synced (remote deletion), else keep (new local work).
    for id in local.keys() {
        if authoritative.contains_key(id) {
            continue;
        }
        if previously_synced.contains(id) {
            plan.drop.push(*id);
        } else {
            plan.keep_local_only.push(*id);
        }
    }

    // Deterministic ordering (the caller may act in order / assert in tests).
    plan.download.sort();
    plan.drop.sort();
    plan.keep_local_only.sort();
    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(b: u8) -> [u8; 16] {
        [b; 16]
    }
    fn nonce(b: u8) -> [u8; 24] {
        [b; 24]
    }

    #[test]
    fn up_to_date_blob_is_noop() {
        let mut auth = HashMap::new();
        auth.insert(id(1), nonce(0xaa));
        let mut local = HashMap::new();
        local.insert(id(1), nonce(0xaa));
        let plan = reconcile(&auth, &local, &HashSet::new());
        assert_eq!(plan, ReconcilePlan::default());
    }

    #[test]
    fn changed_and_missing_are_downloaded() {
        let mut auth = HashMap::new();
        auth.insert(id(1), nonce(0xbb)); // changed remotely
        auth.insert(id(2), nonce(0xcc)); // missing locally
        let mut local = HashMap::new();
        local.insert(id(1), nonce(0xaa));
        let plan = reconcile(&auth, &local, &HashSet::new());
        assert_eq!(plan.download, vec![id(1), id(2)]);
        assert!(plan.drop.is_empty());
    }

    #[test]
    fn previously_synced_absent_is_dropped_not_resurrected() {
        let auth = HashMap::new(); // authoritative no longer has it
        let mut local = HashMap::new();
        local.insert(id(7), nonce(0x77));
        let mut synced = HashSet::new();
        synced.insert(id(7)); // we synced it before → it was deleted remotely
        let plan = reconcile(&auth, &local, &synced);
        assert_eq!(plan.drop, vec![id(7)]);
        assert!(plan.download.is_empty());
        assert!(plan.keep_local_only.is_empty());
    }

    #[test]
    fn never_synced_local_only_is_kept_not_lost() {
        let auth = HashMap::new();
        let mut local = HashMap::new();
        local.insert(id(9), nonce(0x99)); // created locally, never pushed
        let plan = reconcile(&auth, &local, &HashSet::new());
        assert_eq!(plan.keep_local_only, vec![id(9)]);
        assert!(plan.drop.is_empty());
    }

    #[test]
    fn mixed_vault_classifies_each_correctly() {
        let mut auth = HashMap::new();
        auth.insert(id(1), nonce(0xaa)); // up to date
        auth.insert(id(2), nonce(0xbb)); // changed → download
        auth.insert(id(3), nonce(0xcc)); // missing → download
        let mut local = HashMap::new();
        local.insert(id(1), nonce(0xaa));
        local.insert(id(2), nonce(0x22));
        local.insert(id(4), nonce(0x44)); // synced-then-deleted → drop
        local.insert(id(5), nonce(0x55)); // never synced → keep
        let mut synced = HashSet::new();
        synced.insert(id(4));
        let plan = reconcile(&auth, &local, &synced);
        assert_eq!(plan.download, vec![id(2), id(3)]);
        assert_eq!(plan.drop, vec![id(4)]);
        assert_eq!(plan.keep_local_only, vec![id(5)]);
    }
}
