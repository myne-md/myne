// SPDX-License-Identifier: AGPL-3.0
//! The sync status indicator's types and derivation (MYND-424 task 10).
//!
//! **Lifted out of the host-gated `commands.rs`** (phase3-web-client task 84) so
//! the browser reports the same states from the same code. What stayed behind is
//! the one genuinely host-shaped thing: `SyncRuntimeStatusCell`, a
//! `Manager::try_state` singleton. Its CONTENT ([`LiveStatus`]) lives here and
//! is passed in, so the overlay rule is shared even though the cell is not.
//!
//! The derivation is the part worth sharing. "Is this device syncing?" has four
//! honest answers before anything is in flight — no endpoint, endpoint but no
//! token, identity awaiting approval, ready — and a client that got that mapping
//! subtly wrong would tell the user "Synced" about a device that cannot sync.
//! That is a correctness property, not a rendering detail.

use serde::Serialize;

/// The runtime sync status surfaced to the UI (MYND-424 task 10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncRuntimeStatus {
    /// No endpoint configured — sync is off.
    Disabled,
    /// Endpoint configured, but THIS device has no device-local token — it is not
    /// enrolled and cannot sync until it is added. Distinct from `Disabled` (no
    /// endpoint) and from `Idle` (enrolled, nothing in flight); reporting `Idle` here
    /// would falsely show "Synced" for a device that cannot sync.
    NotEnrolled,
    /// Configured + enrolled but still awaiting approval by an existing device. The
    /// device identity IS persisted (it will claim its token once approved), so this
    /// is distinct from `NotEnrolled` (never added) — the UI says "Awaiting approval",
    /// not "add this device".
    Pending,
    /// Configured and idle (no sync in flight).
    Idle,
    /// A pull/push is in flight.
    Syncing,
    /// The last sync attempt failed.
    Error {
        /// A bounded, non-secret reason tag.
        detail: String,
    },
    /// Unresolved conflict copies are present (count surfaced to the UI).
    Conflicts {
        /// Number of `conflict:`-marked notes awaiting resolution.
        count: u32,
    },
}

/// A live sync-status overlay (SYNC-36): the background loop / `sync_now`
/// publishes `Syncing` while a cycle runs and `Error` after a failed cycle;
/// [`overlay_status`] overlays it on the derived base state. Cleared after a
/// clean cycle. (`Conflicts` is derived from the on-disk staging dir, not held
/// here.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveStatus {
    /// A pull/push is in flight.
    Syncing,
    /// The last cycle failed (bounded, non-secret detail tag).
    Error(String),
}

/// Pure endpoint+token+identity → status mapping. No endpoint → `Disabled` (the
/// rest is irrelevant); endpoint + token → `Idle`; endpoint + no token + a
/// persisted enrollment identity → `Pending` (added, awaiting approval);
/// endpoint + no token + no identity → `NotEnrolled`.
pub fn status_from(
    endpoint_present: bool,
    token_present: bool,
    identity_present: bool,
) -> SyncRuntimeStatus {
    match (endpoint_present, token_present, identity_present) {
        (false, _, _) => SyncRuntimeStatus::Disabled,
        (true, true, _) => SyncRuntimeStatus::Idle,
        (true, false, true) => SyncRuntimeStatus::Pending,
        (true, false, false) => SyncRuntimeStatus::NotEnrolled,
    }
}

/// Overlay the live status + unresolved-conflict count on the derived base state.
///
/// Precedence: a config state (`Disabled`/`NotEnrolled`/`Pending`) dominates — a
/// device that cannot sync shows WHY, never a stale live overlay. Only for an
/// enrolled, idle-eligible device does the overlay apply: an in-flight
/// `Syncing` or a last-cycle `Error` wins over conflicts, and unresolved
/// conflicts win over a bare `Idle`.
pub fn overlay_status(
    base: SyncRuntimeStatus,
    live: Option<LiveStatus>,
    conflict_count: u32,
) -> SyncRuntimeStatus {
    if !matches!(base, SyncRuntimeStatus::Idle) {
        return base;
    }
    match live {
        Some(LiveStatus::Syncing) => SyncRuntimeStatus::Syncing,
        Some(LiveStatus::Error(detail)) => SyncRuntimeStatus::Error { detail },
        None if conflict_count > 0 => SyncRuntimeStatus::Conflicts {
            count: conflict_count,
        },
        None => SyncRuntimeStatus::Idle,
    }
}

/// Read the current sync status, derived honestly from disk.
///
/// `live` is the caller's overlay — desktop reads it from the app-managed
/// `SyncRuntimeStatusCell`, and the browser passes `None` until it has a loop to
/// publish one. Passing it in rather than reaching for a singleton is what keeps
/// this function callable from either host: the cell is `Manager`-shaped, the
/// rule is not.
///
/// The vault root is resolved here rather than passed in — the same shape every
/// other `_from_host` core uses. An unresolvable root (no active vault) reads as
/// "no token, no identity, no conflicts", which is the conservative answer the
/// desktop already gave when `active_vault_root_io` failed: a device whose vault
/// cannot be located has not proven it is enrolled.
pub async fn read_status(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    live: Option<LiveStatus>,
) -> Result<SyncRuntimeStatus, super::config::SyncConfigError> {
    let path = super::config::config_path_from_host(host, io).await?;
    let cfg = super::config::read_config(io, &path).await?;
    let vault_root =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await).ok();
    let (token_present, identity_present, conflict_count) = match vault_root.as_deref() {
        Some(dir) => {
            use super::token_store::TokenStore as _;
            let token = matches!(
                super::token_store::default_store().read(io, dir).await,
                Ok(Some(_))
            );
            // A pending device persists its identity (device_id) even before its
            // token is issued, so identity-without-token = awaiting approval.
            let identity = super::state::read_sync_state(io, dir)
                .await
                .map(|s| s.device_id_hex.is_some())
                .unwrap_or(false);
            // Unresolved conflict copies (decryption-free — reads the staging dir).
            let conflicts = super::orchestrator::list_pending_conflicts(io, dir)
                .await
                .len() as u32;
            (token, identity, conflicts)
        }
        None => (false, false, 0),
    };
    let base = status_from(cfg.endpoint_url.is_some(), token_present, identity_present);
    Ok(overlay_status(base, live, conflict_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_states_are_derived_honestly() {
        assert_eq!(status_from(false, true, true), SyncRuntimeStatus::Disabled);
        assert_eq!(status_from(true, true, false), SyncRuntimeStatus::Idle);
        assert_eq!(status_from(true, false, true), SyncRuntimeStatus::Pending);
        // The one that matters: configured but never added must not read as
        // "Synced".
        assert_eq!(
            status_from(true, false, false),
            SyncRuntimeStatus::NotEnrolled
        );
    }

    #[test]
    fn a_config_state_dominates_any_live_overlay() {
        // A device that cannot sync shows WHY. A stale `Syncing` from a loop
        // that ran before the token was revoked must not mask `NotEnrolled`.
        for base in [
            SyncRuntimeStatus::Disabled,
            SyncRuntimeStatus::NotEnrolled,
            SyncRuntimeStatus::Pending,
        ] {
            assert_eq!(
                overlay_status(base.clone(), Some(LiveStatus::Syncing), 3),
                base
            );
        }
    }

    #[test]
    fn live_wins_over_conflicts_and_conflicts_over_idle() {
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, Some(LiveStatus::Syncing), 2),
            SyncRuntimeStatus::Syncing
        );
        assert_eq!(
            overlay_status(
                SyncRuntimeStatus::Idle,
                Some(LiveStatus::Error("rate_limited".into())),
                2
            ),
            SyncRuntimeStatus::Error {
                detail: "rate_limited".into()
            }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 2),
            SyncRuntimeStatus::Conflicts { count: 2 }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 0),
            SyncRuntimeStatus::Idle
        );
    }
}
