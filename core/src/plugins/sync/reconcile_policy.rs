// SPDX-License-Identifier: AGPL-3.0
//! Full-reconcile policy (MYND-426 task 4) — the deletion-cache feature's
//! invocation of the engine's reconcile primitive (`reconcile.rs`, MYND-424
//! task 8) on the triggers that invalidate the incremental cursor.
//!
//! The substantive 3-way classify (download / drop / keep-local-only) lives in
//! the engine primitive. This module owns the *policy* around it:
//! - **when** a full reconcile runs ([`ReconcileTrigger`]: a `410 cursor_expired`
//!   pull or a soft-retire return — the device was offline past the GC horizon);
//! - **the deletion semantics**: a previously-synced blob now absent from the
//!   authoritative manifest is a remote deletion → drop (no resurrection); a
//!   never-synced local blob is new local work → keep (never silent loss). The
//!   engine primitive already encodes exactly this, so the policy is a thin,
//!   intention-revealing wrapper that pins the contract with a test.

use super::reconcile::{reconcile, ReconcilePlan};
use std::collections::{HashMap, HashSet};

/// What invalidated the cursor and forced a full reconcile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileTrigger {
    /// `410 cursor_expired` — the cursor fell below the server's GC reclaim floor.
    CursorExpired,
    /// A soft-retire return — the device was offline past the horizon ceiling.
    SoftRetireReturn,
}

/// Run the full-reconcile policy: invoke the engine primitive against the
/// authoritative manifest and return its plan. `previously_synced` is the set of
/// ids this device has ever observed in a manifest (device-local sync state) —
/// the deleted-vs-new discriminator. The `trigger` is recorded for the caller's
/// telemetry / banner (it does not change the plan; both triggers reconcile the
/// same way).
pub fn plan_full_reconcile(
    _trigger: ReconcileTrigger,
    authoritative: &HashMap<[u8; 16], [u8; 24]>,
    local: &HashMap<[u8; 16], [u8; 24]>,
    previously_synced: &HashSet<[u8; 16]>,
) -> ReconcilePlan {
    reconcile(authoritative, local, previously_synced)
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
    fn cursor_expired_drops_remote_deletion_keeps_local_only() {
        // Authoritative no longer has id(1) (deleted remotely); id(2) is new local.
        let auth = HashMap::new();
        let mut local = HashMap::new();
        local.insert(id(1), nonce(0x11)); // previously synced → deleted remotely
        local.insert(id(2), nonce(0x22)); // never synced → new local work
        let mut synced = HashSet::new();
        synced.insert(id(1));

        let plan = plan_full_reconcile(ReconcileTrigger::CursorExpired, &auth, &local, &synced);
        assert_eq!(
            plan.drop,
            vec![id(1)],
            "remote deletion → drop (no resurrection)"
        );
        assert_eq!(
            plan.keep_local_only,
            vec![id(2)],
            "new local → keep (no silent loss)"
        );
    }

    #[test]
    fn soft_retire_downloads_changed_and_missing() {
        let mut auth = HashMap::new();
        auth.insert(id(1), nonce(0xbb)); // changed remotely
        auth.insert(id(3), nonce(0xcc)); // missing locally
        let mut local = HashMap::new();
        local.insert(id(1), nonce(0xaa));
        let plan = plan_full_reconcile(
            ReconcileTrigger::SoftRetireReturn,
            &auth,
            &local,
            &HashSet::new(),
        );
        assert_eq!(plan.download, vec![id(1), id(3)]);
        assert!(plan.drop.is_empty());
    }

    #[test]
    fn both_triggers_reconcile_identically() {
        let mut auth = HashMap::new();
        auth.insert(id(5), nonce(0x55));
        let local = HashMap::new();
        let a = plan_full_reconcile(
            ReconcileTrigger::CursorExpired,
            &auth,
            &local,
            &HashSet::new(),
        );
        let b = plan_full_reconcile(
            ReconcileTrigger::SoftRetireReturn,
            &auth,
            &local,
            &HashSet::new(),
        );
        assert_eq!(a, b);
    }
}
