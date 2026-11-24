// SPDX-License-Identifier: AGPL-3.0-only
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
    /// The cycle RUNS and cannot UPLOAD: this device is enrolled, it is reaching the server,
    /// and it cannot author a vault head (myne-md/myne#1027).
    ///
    /// A state of its own, and the reason is the defect it came from. It is not `Error` because
    /// nothing failed, the pull succeeds every thirty seconds, and it was not `Idle` before,
    /// although that is what it reported: `Idle` means "enrolled, nothing in flight", the
    /// indicator renders `Idle` as "Synced", and a published vault uploaded nothing for a day
    /// while saying exactly that.
    UploadsBlocked {
        /// A bounded cause token, from the same vocabulary as [`SyncRuntimeStatus::Error`]'s
        /// `detail`: `device_key_missing` and `identity_locked` are the two a user action
        /// repairs, and `uploads_blocked` covers the causes none does.
        detail: String,
        /// Epoch-ms of the last cycle that uploaded anything, or `None` if this device never
        /// has.
        ///
        /// A raw timestamp, coarsened by whatever renders it, and it appears ONLY on this
        /// variant. AS15 bounds it: an hourly stamp, never synced, riding the OS backup like
        /// the rest of `sync-state.json` (TB3).
        ///
        /// **This status is published by the desktop and the phone; the browser does NOT publish
        /// it yet** (the Worker passes no `live` overlay and its cycle loop discards the verdict),
        /// so a blocked web client still reports the base state. Recorded in `0787` as a
        /// residual rather than left as an implicit "all clients".
        ///
        /// NOTHING renders it today. The sentence it is for is "your work has not left this
        /// machine, and the last time it did was three hours ago", which needs a coarsening
        /// formatter and a translation, so it is a named residual rather than a half-wired
        /// surface (`decisions/sync/0787`). Carry it; do not claim it is shown.
        #[serde(skip_serializing_if = "Option::is_none")]
        last_upload_at: Option<u64>,
    },
}

impl SyncRuntimeStatus {
    /// The state as ONE bounded token, for a log field (myne-md/myne#1033).
    ///
    /// Exists so the diagnostic log never needs `?status`: that Debug shape carries a `String`
    /// and the two AS15 per-device clocks, and `threat-model.md` §7 sanctions `?` only over a
    /// CLOSED enum.
    ///
    /// Read from the SERDE tag rather than from a hand-kept match over the variants. The two
    /// answer the same question, the tag is the copy the UI already consumes, and a variant added
    /// to the enum would otherwise leave the log speaking the old vocabulary with nothing to
    /// notice it (review of myne-md/myne#1033). One serialise per status CHANGE, which is the
    /// gate's own frequency, not per cycle.
    #[must_use]
    pub fn state_token(&self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|value| {
                value
                    .get("state")
                    .and_then(|state| state.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// The bounded cause tag the state carries, or `""`. Every token this returns comes from
    /// the closed vocabulary in `loop_control::FailureClass::status_detail` and the cycle's
    /// blocked tokens, never from user data.
    #[must_use]
    pub fn detail_token(&self) -> &str {
        match self {
            SyncRuntimeStatus::Error { detail, .. }
            | SyncRuntimeStatus::UploadsBlocked { detail, .. } => detail.as_str(),
            _ => "",
        }
    }
}

/// A live sync-status overlay (SYNC-36): the background loop / `sync_now`
/// publishes `Syncing` while a cycle runs, `Error` after a failed cycle, and `Blocked` after a
/// cycle that succeeded and could not upload; [`overlay_status`] overlays it on the derived base
/// state. Cleared after a clean cycle. (`Conflicts` is derived from the on-disk staging dir, not
/// held here.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LiveStatus {
    /// A pull/push is in flight.
    Syncing,
    /// The last cycle failed (bounded, non-secret detail tag).
    Error(String),
    /// The last cycle ran and could not upload (bounded cause token).
    ///
    /// The third arm is the whole point of myne-md/myne#1027: a cycle can SUCCEED and still have
    /// moved nothing up, and before this the cell had no way to say so, so it said `None`, the
    /// base state said `Idle`, and the UI said "Synced".
    Blocked(String),
}

/// The two on-disk clocks a status read carries, kept together so a caller cannot pass one
/// where the other belongs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncClocks {
    /// Last cycle that completed against the server, reachability, not uploads.
    pub last_success_at: Option<u64>,
    /// Last cycle that uploads anything, see [`SyncRuntimeStatus::UploadsBlocked`].
    pub last_upload_at: Option<u64>,
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
/// `Syncing`, a last-cycle `Error`, or a last-cycle `Blocked` wins over conflicts, and
/// unresolved conflicts win over a bare `Idle`.
///
/// `Blocked` sits between `Error` and `Conflicts` deliberately. It describes a cycle that
/// RAN, so it outranks an unresolved conflict: a conflict is something to fix once the
/// uploads work, and a device that cannot upload cannot resolve one.
pub fn overlay_status(
    base: SyncRuntimeStatus,
    live: Option<LiveStatus>,
    conflict_count: u32,
    clocks: SyncClocks,
) -> SyncRuntimeStatus {
    if !matches!(base, SyncRuntimeStatus::Idle) {
        return base;
    }
    match live {
        Some(LiveStatus::Syncing) => SyncRuntimeStatus::Syncing,
        Some(LiveStatus::Error(detail)) => SyncRuntimeStatus::Error {
            detail,
            last_success_at: clocks.last_success_at,
        },
        Some(LiveStatus::Blocked(detail)) => SyncRuntimeStatus::UploadsBlocked {
            detail,
            last_upload_at: clocks.last_upload_at,
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
    let mut clocks = SyncClocks::default();
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
            // A PUBLISHED person-born vault has neither a vault token nor an
            // enrolment record: its credential is the person session (myne-md/myne#911
            // task 8). Reading the pair above alone would call it "not enrolled",
            // which is a lie about a vault that is on a server AND hides the one
            // manual sync trigger, so the session's token is counted here as the
            // token and its device id as the enrolment.
            let person_published = if persisted
                .as_ref()
                .is_some_and(|s| s.namespace_hex.is_some())
            {
                match super::person_auth::person_auth_path_for_read(host) {
                    Ok(path) => matches!(
                        super::person_auth::read_person_auth(io, &path).await,
                        Ok(Some(auth)) if !auth.token_hex.is_empty()
                    ),
                    Err(_) => false,
                }
            } else {
                false
            };
            clocks.last_success_at = persisted.as_ref().and_then(|s| s.last_success_at_ms);
            clocks.last_upload_at = persisted.as_ref().and_then(|s| s.last_upload_at_ms);
            let token = token || person_published;
            let identity = identity || person_published;
            // Unresolved conflict copies (decryption-free — reads the staging dir).
            let conflicts = super::orchestrator::list_pending_conflicts(io, dir)
                .await
                .len() as u32;
            (token, identity, conflicts)
        }
        None => (false, false, 0),
    };
    let base = status_from(cfg.endpoint_url.is_some(), token_present, identity_present);
    Ok(overlay_status(base, live, conflict_count, clocks))
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

    /// A published person-born vault is ENROLLED, in the only sense that applies
    /// to it (myne-md/myne#911 task 8): it holds no vault token and no enrolment
    /// record, so the vault-local pair reads false and the status said "Not
    /// enrolled" about a vault that was on a server and could sync. Two things
    /// followed, both wrong: the indicator told the user to add a device that
    /// cannot exist here, and the "Sync now" trigger was hidden.
    ///
    /// Driven through the real reader against real files, because the claim is
    /// about what is on disk: a recorded namespace plus a person session token.
    #[test]
    fn a_published_person_vault_reads_as_enrolled() {
        use crate::host::test_host::TestHost;
        use crate::plugins::sync::person_auth::{write_person_auth, PersonAuth, PERSON_AUTH_FILE};
        use crate::plugins::vault_unlock::state::VaultRuntimeState;
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::VaultIo as _;

        let tmp = ScopedTempDir::new("published-status").unwrap();
        let host = TestHost::with_dirs(tmp.path(), tmp.path().join("config"));
        let io = crate::vault_io::StdVaultIo;
        let state = VaultRuntimeState::default();

        block_on(async {
            super::super::config::set_endpoint(
                &host,
                &io,
                Some("http://127.0.0.1:1".to_string()),
                None,
                None,
            )
            .await
            .expect("endpoint");

            let dir = crate::paths::active_vault_root_io_from_host(&host, None).unwrap();
            io.create_dir_all(&dir).await.unwrap();
            let st = super::super::state::SyncState {
                namespace_hex: Some("ef".repeat(16)),
                ..Default::default()
            };
            super::super::state::write_sync_state(&io, &dir, &st)
                .await
                .unwrap();

            // Without a session the vault is published but cannot authenticate:
            // "idle" would be a green light for a cycle that parks.
            assert!(matches!(
                read_status(&host, &io, &state, None).await.unwrap(),
                SyncRuntimeStatus::NotEnrolled
            ));

            let auth = PersonAuth {
                person_id_hex: "01".repeat(16),
                device_id_hex: "02".repeat(16),
                registered: true,
                token_hex: "ab".repeat(32),
                ..PersonAuth::default()
            };
            write_person_auth(
                &io,
                &tmp.path().join("config").join(PERSON_AUTH_FILE),
                &auth,
            )
            .await
            .expect("person session");

            assert_eq!(
                read_status(&host, &io, &state, None).await.unwrap(),
                SyncRuntimeStatus::Idle,
                "a published person vault with a session is enrolled and idle"
            );
        });
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
                overlay_status(
                    base.clone(),
                    Some(LiveStatus::Syncing),
                    3,
                    SyncClocks::default()
                ),
                base
            );
        }
    }

    #[test]
    fn live_wins_over_conflicts_and_conflicts_over_idle() {
        assert_eq!(
            overlay_status(
                SyncRuntimeStatus::Idle,
                Some(LiveStatus::Syncing),
                2,
                SyncClocks::default()
            ),
            SyncRuntimeStatus::Syncing
        );
        assert_eq!(
            overlay_status(
                SyncRuntimeStatus::Idle,
                Some(LiveStatus::Error("rate_limited".into())),
                2,
                SyncClocks::default()
            ),
            SyncRuntimeStatus::Error {
                detail: "rate_limited".into(),
                last_success_at: None
            }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 2, SyncClocks::default()),
            SyncRuntimeStatus::Conflicts { count: 2 }
        );
        assert_eq!(
            overlay_status(SyncRuntimeStatus::Idle, None, 0, SyncClocks::default()),
            SyncRuntimeStatus::Idle
        );
    }

    /// A cycle that ran and could not upload must NOT read as idle (myne-md/myne#1027).
    ///
    /// `Idle` is what the indicator renders as "Synced", and "Synced" is what a published vault
    /// reported for a day while it uploaded nothing at all. Three clauses: the state is its own,
    /// the cause survives, and the upload clock reaches the one surface that exists for it.
    #[test]
    fn a_blocked_cycle_is_never_reported_as_idle() {
        let clocks = SyncClocks {
            last_success_at: Some(1_700_000_000_000),
            last_upload_at: Some(1_699_000_000_000),
        };
        let blocked = overlay_status(
            SyncRuntimeStatus::Idle,
            Some(LiveStatus::Blocked("device_key_missing".into())),
            0,
            clocks,
        );
        assert_eq!(
            blocked,
            SyncRuntimeStatus::UploadsBlocked {
                detail: "device_key_missing".into(),
                last_upload_at: Some(1_699_000_000_000),
            },
            "the cause and the upload clock both survive the overlay"
        );
        assert_ne!(blocked, SyncRuntimeStatus::Idle, "and it is not `Synced`");

        // It outranks an unresolved conflict: a device that cannot upload cannot resolve one.
        assert!(matches!(
            overlay_status(
                SyncRuntimeStatus::Idle,
                Some(LiveStatus::Blocked("uploads_blocked".into())),
                4,
                clocks
            ),
            SyncRuntimeStatus::UploadsBlocked { .. }
        ));

        // And a config state still dominates it, like every other overlay.
        assert_eq!(
            overlay_status(
                SyncRuntimeStatus::NotEnrolled,
                Some(LiveStatus::Blocked("device_key_missing".into())),
                0,
                clocks
            ),
            SyncRuntimeStatus::NotEnrolled
        );
    }
}
