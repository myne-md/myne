//! Sync taxonomy — what syncs, what stays device-local, what is re-derived
//! (MYND-426 task 3; SYNC-12 + the §9.6.4 / §9.8.4 rebuildable-cache rule).
//!
//! The blind server replicates a strict, closed set of vault artifacts. The rule
//! is **sync ⊆ backup**: everything that syncs is in the backup allowlist, but
//! not everything backed up syncs — rebuildable caches and device-local state
//! are excluded:
//!
//! - **Synced** — the content blobs (`*.myn` notes, `attachments/<id>`) + the
//!   shared singletons (`vault.meta`, `vault.prefs`, `vault.dictionary`,
//!   `vault.attachments`). These are the authoritative state the head commits /
//!   the conflict engine reconciles.
//! - **Rederivable cache** — `vault.search` (`MYS1`) + `vault.indices` (`MYI1`):
//!   NOT synced; each device rebuilds them locally from the `.myn` files via the
//!   `content_nonce` reconcile (§9.6.4 / §9.8.4). Syncing them would be wasted
//!   bytes + a merge headache for no gain.
//! - **Device-local** — `vault.workspace` (`MYW1`, the editor pane tree),
//!   `sync-state.json` (cursor + VV log), `vault.head-state` (`MYH1` baseline).
//!   NEVER synced (AS6/A13: leaking these would expose per-device state).
//!
//! This classifier is the single authority the push/pull paths consult before
//! they ever offer a blob to the server.

/// How a vault artifact relates to sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncClass {
    /// Replicated to the server (content blobs + shared singletons).
    Synced,
    /// A rebuildable cache — never synced; re-derived locally from `.myn`.
    RederivableCache,
    /// Device-local state — never synced.
    DeviceLocal,
}

impl SyncClass {
    /// Whether an artifact of this class is offered to the server.
    pub fn is_synced(self) -> bool {
        matches!(self, SyncClass::Synced)
    }
}

/// The device-local singleton file names (never synced).
const DEVICE_LOCAL: &[&str] = &["vault.workspace", "sync-state.json", "vault.head-state"];
/// The rebuildable-cache singleton file names (never synced; re-derived).
const REDERIVABLE: &[&str] = &["vault.search", "vault.indices"];
/// The shared singleton file names that DO sync.
const SYNCED_SINGLETONS: &[&str] = &[
    "vault.meta",
    "vault.prefs",
    "vault.dictionary",
    "vault.attachments",
];

/// Classify a vault artifact by its path/name relative to the vault root.
/// `name` is the file name (`vault.search`) or a relative path
/// (`attachments/<id>`, `notes/<uuid>.myn` or just `<uuid>.myn`).
pub fn classify(name: &str) -> SyncClass {
    // Content notes: any `.myn` blob (flat or under notes/).
    if name.ends_with(".myn") {
        return SyncClass::Synced;
    }
    // Attachments: anything under the attachments/ subtree.
    if name.starts_with("attachments/") || name.starts_with("attachments\\") {
        return SyncClass::Synced;
    }
    // Singletons by exact name.
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if DEVICE_LOCAL.contains(&base) {
        return SyncClass::DeviceLocal;
    }
    if REDERIVABLE.contains(&base) {
        return SyncClass::RederivableCache;
    }
    if SYNCED_SINGLETONS.contains(&base) {
        return SyncClass::Synced;
    }
    // Unknown artifacts default to device-local — fail SAFE: never sync something
    // the taxonomy does not explicitly recognize (closed allowlist, blind-relay).
    SyncClass::DeviceLocal
}

/// Convenience: should this artifact be pushed/pulled?
pub fn is_synced(name: &str) -> bool {
    classify(name).is_synced()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_and_attachments_sync() {
        assert_eq!(classify("0a1b.myn"), SyncClass::Synced);
        assert_eq!(classify("notes/0a1b.myn"), SyncClass::Synced);
        assert_eq!(classify("attachments/deadbeef"), SyncClass::Synced);
        assert!(is_synced("x.myn"));
    }

    #[test]
    fn synced_singletons() {
        for f in [
            "vault.meta",
            "vault.prefs",
            "vault.dictionary",
            "vault.attachments",
        ] {
            assert_eq!(classify(f), SyncClass::Synced, "{f} should sync");
        }
    }

    #[test]
    fn rederivable_caches_never_sync() {
        assert_eq!(classify("vault.search"), SyncClass::RederivableCache);
        assert_eq!(classify("vault.indices"), SyncClass::RederivableCache);
        assert!(!is_synced("vault.search"));
        assert!(!is_synced("vault.indices"));
    }

    #[test]
    fn device_local_never_syncs() {
        for f in ["vault.workspace", "sync-state.json", "vault.head-state"] {
            assert_eq!(
                classify(f),
                SyncClass::DeviceLocal,
                "{f} must stay device-local"
            );
            assert!(!is_synced(f));
        }
        // The MYND-424 task-4 device-local files are covered.
        assert_eq!(classify("vault.head-state"), SyncClass::DeviceLocal);
    }

    #[test]
    fn unknown_artifact_fails_safe_to_device_local() {
        // A future/unrecognized file is NOT offered to the server (closed allowlist).
        assert_eq!(classify("vault.somethingnew"), SyncClass::DeviceLocal);
        assert!(!is_synced("vault.somethingnew"));
    }
}
