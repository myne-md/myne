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
        /// Epoch-ms of the last cycle that completed on this device, or `None`
        /// if none ever has (myne#583). Carried ONLY on this variant: how long
        /// sync has been failing is a question that only exists while it is
        /// failing, and attaching a clock to `Idle` would invite a UI that
        /// displays one.
        ///
        /// It is a raw timestamp rather than a rendered duration because the
        /// coarsening belongs to the surface: AS15 keeps per-device sync
        /// wall-clocks off screen, so the client turns this into "several days"
        /// and never into a date.
        #[serde(skip_serializing_if = "Option::is_none")]
        last_success_at: Option<u64>,
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
        // #267 belt-and-braces: a token WITHOUT identity may not read green.
        //
        // This arm used to be `(true, true, _)`, so a device whose identity
        // write had been discarded reported `Idle` — and `Idle` is what the
        // UI's enrol-gate reads as "already enrolled", which hid the only
        // surface offering a way back while the cycle silently refused to run.
        // The enrolment paths now fail rather than reach that state; this makes
        // it unrepresentable in the status even if some future path does.
        (true, true, true) => SyncRuntimeStatus::Idle,
        (true, true, false) => SyncRuntimeStatus::NotEnrolled,
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
    last_success_at: Option<u64>,
) -> SyncRuntimeStatus {
    if !matches!(base, SyncRuntimeStatus::Idle) {
        return base;
    }
    match live {
        Some(LiveStatus::Syncing) => SyncRuntimeStatus::Syncing,
        Some(LiveStatus::Error(detail)) => SyncRuntimeStatus::Error {
            detail,
            last_success_at,
        },
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
    let mut last_success_at: Option<u64> = None;
    let (token_present, identity_present, conflict_count) = match vault_root.as_deref() {
        Some(dir) => {
            use super::token_store::TokenStore as _;
            let token = matches!(
                super::token_store::default_store().read(io, dir).await,
                Ok(Some(_))
            );
            // A pending device persists its identity (device_id) even before its
            // token is issued, so identity-without-token = awaiting approval.
            let persisted = super::state::read_sync_state(io, dir).await.ok();
            let identity = persisted
                .as_ref()
                .is_some_and(|s| s.device_id_hex.is_some());
            last_success_at = persisted.and_then(|s| s.last_success_at_ms);
            // Unresolved conflict copies (decryption-free — reads the staging dir).
            let conflicts = super::orchestrator::list_pending_conflicts(io, dir)
                .await
                .len() as u32;
            (token, identity, conflicts)
        }
        None => (false, false, 0),
    };
    let base = status_from(cfg.endpoint_url.is_some(), token_present, identity_present);
    Ok(overlay_status(base, live, conflict_count, last_success_at))
}

/// Which of the two "cannot sync yet" states this device is in: awaiting
/// approval, or not enrolled at all (MYND-635).
///
/// Exists because a cycle that declines to run reports one coarse
/// `CycleOutcome::NotReady` covering three unrelated situations — locked vault,
/// never enrolled, and **enrolled but pending approval** — and `sync_now` used
/// to answer `NotEnrolled` for all three. That made two commands disagree about
/// the same fact: `sync_status` said `Pending` while `sync_now` said
/// `NotEnrolled`, and the UI believed whichever it had asked last.
///
/// Deliberately NARROWER than [`read_status`], which is why this is not a call
/// to that. `read_status` answers `Idle` whenever a token exists — correct for a
/// status readout, wrong here: a locked-vault cycle would then turn the
/// indicator green on a sync that never ran, which is precisely the failure the
/// `Ran`-only-`Idle` rule in `sync_now_from_host` exists to prevent. This can
/// return only the two states that are honest about not having synced.
pub async fn not_ready_reason(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
) -> SyncRuntimeStatus {
    let Ok(dir) = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        return SyncRuntimeStatus::NotEnrolled;
    };
    use super::token_store::TokenStore as _;
    let token_present = matches!(
        super::token_store::default_store().read(io, &dir).await,
        Ok(Some(_))
    );
    // Identity without a token is the whole definition of "awaiting approval":
    // the join persists `device_id` unconditionally so the device can claim its
    // token once approved, and the token is what it does not have yet.
    let identity_present = super::state::read_sync_state(io, &dir)
        .await
        .map(|s| s.device_id_hex.is_some())
        .unwrap_or(false);
    if identity_present && !token_present {
        SyncRuntimeStatus::Pending
    } else {
        SyncRuntimeStatus::NotEnrolled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_states_are_derived_honestly() {
        assert_eq!(status_from(false, true, true), SyncRuntimeStatus::Disabled);
        assert_eq!(status_from(true, true, true), SyncRuntimeStatus::Idle);
        assert_eq!(status_from(true, false, true), SyncRuntimeStatus::Pending);
        // #267: a token with NO identity is not enrolled, whatever the token
        // says. It used to read `Idle` — which the UI treats as "already
        // enrolled" — so a device whose identity write had been discarded
        // reported green while the cycle silently refused to run, with the only
        // surface offering a retry hidden.
        assert_eq!(
            status_from(true, true, false),
            SyncRuntimeStatus::NotEnrolled
        );
        // The one that matters: configured but never added must not read as
        // "Synced".
        assert_eq!(
            status_from(true, false, false),
            SyncRuntimeStatus::NotEnrolled
        );
    }

    /// The three-way collapse that made two commands disagree (MYND-635).
    ///
    /// `CycleOutcome::NotReady` covers a locked vault, a never-enrolled device
    /// and one awaiting approval. `sync_now` answered `NotEnrolled` for all
    /// three while `sync_status` answered `Pending` for the last — so the same
    /// device reported two different states depending on which command the UI
    /// happened to ask.
    ///
    /// Driven through the real reader against a real directory, not a stubbed
    /// presence pair: the claim is about what is ON DISK after a join, and a
    /// test that asserted over booleans would keep passing if the identity
    /// stopped being persisted at all.
    #[test]
    fn not_ready_separates_awaiting_approval_from_never_enrolled() {
        use crate::host::test_host::TestHost;
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::VaultIo as _;

        let tmp = ScopedTempDir::new("not-ready-reason").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let state = VaultRuntimeState::default();

        block_on(async {
            // No vault dir, no identity, no token — nothing has ever enrolled.
            assert_eq!(
                not_ready_reason(&host, &io, &state).await,
                SyncRuntimeStatus::NotEnrolled,
                "a device with nothing on disk has not enrolled"
            );

            // A join persists `device_id` BEFORE approval and writes no token.
            // That pair is the definition of awaiting approval.
            let dir = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            io.create_dir_all(&dir).await.unwrap();
            let st = super::super::state::SyncState {
                device_id_hex: Some("0".repeat(32)),
                ..Default::default()
            };
            super::super::state::write_sync_state(&io, &dir, &st)
                .await
                .unwrap();

            assert_eq!(
                not_ready_reason(&host, &io, &state).await,
                SyncRuntimeStatus::Pending,
                "identity without a token is awaiting approval, not unenrolled"
            );
        });
    }

    /// `not_ready_reason` must never answer `Idle`. It is only ever consulted
    /// when a cycle DECLINED to run, and a green indicator there would claim a
    /// sync that did not happen — the exact rule `sync_now_from_host`'s
    /// `Ran`-only-`Idle` mapping exists to hold.
    #[test]
    fn not_ready_can_never_report_a_synced_state() {
        use crate::host::test_host::TestHost;
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        use crate::test_support::{block_on, ScopedTempDir};

        let tmp = ScopedTempDir::new("not-ready-never-idle").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let state = VaultRuntimeState::default();

        block_on(async {
            for _ in 0..2 {
                let got = not_ready_reason(&host, &io, &state).await;
                assert!(
                    matches!(
                        got,
                        SyncRuntimeStatus::Pending | SyncRuntimeStatus::NotEnrolled
                    ),
                    "not_ready_reason returned {got:?}, which claims more than a declined cycle can"
                );
            }
        });
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
                overlay_status(base.clone(), Some(LiveStatus::Syncing), 3, None),
                base
            );
        }
    }

    #[test]
    fn live_wins_over_conflicts_and_conflicts_over_idle() {
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, Some(LiveStatus::Syncing), 2, None),
            SyncRuntimeStatus::Syncing
        );
        assert_eq!(
            overlay_status(
                SyncRuntimeStatus::Idle,
                Some(LiveStatus::Error("rate_limited".into())),
                2,
                None
            ),
            SyncRuntimeStatus::Error {
                detail: "rate_limited".into(),
                last_success_at: None
            }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 2, None),
            SyncRuntimeStatus::Conflicts { count: 2 }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 0, None),
            SyncRuntimeStatus::Idle
        );
    }
}
