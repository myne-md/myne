// SPDX-License-Identifier: AGPL-3.0
//! Sync-loop scheduling (MYND-424 task 9).
//!
//! The background loop is a `tokio` task gated on `Slot::Unlocked` (the
//! `auto_lock` / `backup_schedule` pattern): it ticks on a timer, and each tick
//! asks [`SyncScheduler::tick`] what to do. The **decision logic** lives here as
//! a pure state machine driven by an injected logical clock, so the privacy-
//! load-bearing behaviour is unit-tested without real time:
//!
//! - **Unlock-gated** — a locked scheduler always decides [`SyncAction::Idle`];
//!   the loop does nothing while the vault is locked and resumes on unlock.
//! - **Polling is the fallback cadence** — pulls fire on a fixed interval
//!   whenever the poke stream is absent or silent, so sync never depends on the
//!   SSE channel being healthy.
//! - **Edge triggers are one-shot** — the locked→unlocked edge, mobile resume,
//!   and a rate-limited window focus ([`FOCUS_POLL_FLOOR_MS`]) each arm a single
//!   immediate poll; the steady-state cadence stays the fixed interval, so edge
//!   events cannot turn into a high-frequency polling channel.
//! - **Pokes are honored unconditionally** — the `/sync/poke` channel (the 423
//!   layer, driven by `poke_listener`) is part of the baseline sync behaviour
//!   per the amended `sync-protocol.md` §8.3: the fixed-interval polling above
//!   already discloses presence at poll granularity while unlocked, so the
//!   continuous stream's marginal A13 delta no longer carries a user-facing
//!   toggle. A poke triggers one immediate pull; the signal stays zero-payload.
//! - **Pushes are coalesced** (story 8) — a local change marks the scheduler
//!   dirty; the push only fires once the coalescing window has elapsed, so the
//!   server sees edit timing blurred to the window granularity (resolution-blur,
//!   NOT decorrelation — documented in the spec staging). No high-resolution
//!   edit-timing channel beyond at-rest mtime is opened.
//! - **Failures re-arm and back off** — a failed cycle re-arms the push intent
//!   it consumed (a transient outage must never strand an edit locally) and
//!   opens a class-based retry gate that *delays* the next scheduled action
//!   (exponential per [`retry_delay_ms`], reset on success). The gate only ever
//!   stretches intervals relative to the baseline cadence — no action fires
//!   earlier than it would today, so the A13 timing posture is unchanged. Pokes
//!   and one-shot immediate polls bypass the gate (a pull is cheap and a
//!   successful bypass pull clears the gate, unstranding any pending push).
//!
//! The actual `tokio` glue (spawn, timer, Slot read, transport call) is thin
//! orchestration over this state machine + the `engine` pull/push functions; it
//! is wired by the unlock flow exactly like `auto_lock::spawn`.

/// Default poll interval (privacy-default cadence; ops-tunable).
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 30_000;
/// Default push-coalescing window (resolution-blur; a few seconds, ops-tunable).
pub const DEFAULT_COALESCE_WINDOW_MS: u64 = 5_000;
/// Minimum age of the last poll before a window-focus event may arm an
/// immediate poll — alt-tab flapping collapses to at most one pull per floor.
pub const FOCUS_POLL_FLOOR_MS: u64 = 10_000;

/// First retry delay after a transport/other failure (doubles per consecutive
/// failure). Extend-only relative to the baseline cadence — see the module doc.
pub const FAILURE_RETRY_START_MS: u64 = 1_000;
/// Cap for the transport/other failure retry delay.
pub const FAILURE_RETRY_CAP_MS: u64 = 120_000;
/// First retry delay after a 429 — the server explicitly asked to slow down,
/// so the ladder starts at a full extra poll interval.
pub const RATE_LIMIT_RETRY_START_MS: u64 = 60_000;
/// Cap for the 429 retry delay.
pub const RATE_LIMIT_RETRY_CAP_MS: u64 = 300_000;
/// Flat park after a 401 — retrying is pointless until re-auth; the focus /
/// unlock / resume / poke edges all bypass the gate, so any user interaction
/// (or a peer's push) re-probes immediately.
pub const AUTH_PARK_MS: u64 = 900_000;

/// Why a cycle failed, coarsened to what the retry policy needs. Derived from
/// `SyncCycleError` at the `commands` boundary (`classify_cycle_error`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureClass {
    /// 429 on pull or push — the server's own throttle.
    RateLimited,
    /// 401 — the stored token is dead; only re-auth helps.
    Unauthenticated,
    /// 401 `device_revoked` — this device's registry row was revoked from
    /// another client (task 94, `server-protocol.md` §3.1).
    ///
    /// **Parks exactly like `Unauthenticated`, and that is the whole of its
    /// behaviour here.** On desktop and mobile the machine is the user's own and
    /// re-enrolling is the fix, so today's park-and-prompt is already right —
    /// erasing someone's own machine on a server signal would be a new and
    /// unasked-for destructive power. What the separate class buys is that the
    /// UI can SAY which of the two happened, and that the web client (whose
    /// storage is a cache of a sync-held vault) can treat it as terminal instead
    /// of retryable. The scheduler is not where that difference lives.
    DeviceRevoked,
    /// Socket/TLS-level failure — offline or the server is unreachable.
    Transport,
    /// A certificate-chain, hostname or TLS-protocol failure needs a server
    /// configuration change; repeating the same handshake cannot fix it.
    TlsFailure,
    /// 507 — the account is over its storage ceiling. Retrying cannot help until
    /// the user frees space or the ceiling changes, so it parks like a 401.
    QuotaExceeded,
    /// 413 — one request exceeded the server's body cap. A property of THAT
    /// request, not of the account: the next cycle may well succeed, so this
    /// keeps the ordinary backoff rather than parking.
    PayloadTooLarge,
    /// 403 — the account is operator-frozen. Push + enroll are refused, pull is
    /// never refused; only the operator can clear it, so it parks like a 401.
    Frozen,
    /// The LOCAL store ran out of room while materialising (phase3-web-client
    /// task 91). Distinct from [`FailureClass::QuotaExceeded`], which is the
    /// SERVER's 507: that one is about the account's ceiling and this one is
    /// about this device's disk or this origin's OPFS allowance. Both park —
    /// retrying cannot help until someone frees something — but they are
    /// different sentences to the user, and only one of them is fixable here.
    StorageFull,
    /// A binding row publishes this device's signing key and the key store does not hold it
    /// (myne-md/myne#983). Distinct from [`FailureClass::IdentityLocked`] because the sentence
    /// and the repair differ: opening the identity DOES fix it, but saying "unlock your identity
    /// to sync" without naming the missing key is what sent users to the wrong fix for a week,
    /// and the state survives every lock until a claim runs.
    DeviceKeyMissing,
    /// An `NTV6` vault whose head cannot be signed because no person identity is
    /// held in this session — the third defect in the same NTV6/identity
    /// intersection as myne-md/myne#790 and #791. The cycle refuses to author a
    /// downgraded `0x01` head, which the `0x02` server would reject anyway.
    ///
    /// **Not parked.** Every parking class above is parked because no user
    /// action can be awaited by the scheduler; here the user CAN act (unlock the
    /// identity, `sync_person_unlock`), but that action has no scheduler edge of
    /// its own — it is not a lock/unlock/focus/resume/poke — so parking for
    /// [`AUTH_PARK_MS`] would strand the first successful retry up to fifteen
    /// minutes after the user fixed it. The ordinary ladder keeps the wait
    /// bounded at [`FAILURE_RETRY_CAP_MS`] instead.
    IdentityLocked,
    /// Everything else (bad response, CAS races, protocol errors, local IO).
    Other,
}

impl FailureClass {
    /// The `SyncRuntimeStatus::Error` detail string for this class — shared by
    /// the loop's status cell and `sync_now` so the UI sees one vocabulary.
    pub fn status_detail(self) -> &'static str {
        match self {
            FailureClass::Unauthenticated => "auth_failed",
            // Its own tag, for the same reason `frozen` has one: collapsing it
            // into "auth_failed" would show "sign-in expired" to a user whose
            // device was deliberately removed, and send them to re-enrol a
            // device the account owner just cut off.
            FailureClass::DeviceRevoked => "device_revoked",
            FailureClass::RateLimited => "rate_limited",
            // Distinct tags so the UI never collapses these into "Sync failed"
            // (MYND-570): each maps to its own banner copy.
            FailureClass::QuotaExceeded => "quota_exceeded",
            FailureClass::StorageFull => "storage_full",
            FailureClass::PayloadTooLarge => "payload_too_large",
            FailureClass::Frozen => "frozen",
            // Its own tag: the fix is a specific user action (unlock the person
            // identity), which "sync_failed" would never say.
            FailureClass::IdentityLocked => "identity_locked",
            // Its own tag: the whole point is that "the identity is closed" and "the key this
            // device published is gone" are different sentences (myne-md/myne#983).
            FailureClass::DeviceKeyMissing => "device_key_missing",
            // Not "sync_failed": this is the one transport failure the user can
            // act on, and the action is specific (fix the server's certificate, or
            // point the client at a host a public CA will issue for).
            FailureClass::TlsFailure => "tls_failure",
            FailureClass::Transport | FailureClass::Other => "sync_failed",
        }
    }
}

/// One cycle's outcome as the scheduler sees it (fed via
/// [`SyncScheduler::on_cycle_outcome`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleResult {
    /// The cycle ran to completion.
    Success,
    /// The cycle did not really run (locked / unenrolled / disabled) — neutral:
    /// neither counts as a failure nor resets the failure gate.
    Skipped,
    /// The cycle ran and failed.
    Failed(FailureClass),
}

/// Pure retry-delay ladder: exponential per class, deterministic (no jitter —
/// retries are quantized to the loop tick and rate-limited per account
/// server-side, so decorrelation buys nothing here, unlike the SSE reconnect).
fn retry_delay_ms(class: FailureClass, consecutive_failures: u32) -> u64 {
    let (start, cap) = match class {
        // Nothing the client can retry its way out of — park until a user
        // action (unlock / focus / manual sync) or a peer poke re-probes.
        FailureClass::Unauthenticated
        | FailureClass::DeviceRevoked
        | FailureClass::QuotaExceeded
        | FailureClass::StorageFull
        | FailureClass::Frozen
        | FailureClass::TlsFailure => return AUTH_PARK_MS,
        FailureClass::RateLimited => (RATE_LIMIT_RETRY_START_MS, RATE_LIMIT_RETRY_CAP_MS),
        FailureClass::Transport | FailureClass::Other | FailureClass::PayloadTooLarge => {
            (FAILURE_RETRY_START_MS, FAILURE_RETRY_CAP_MS)
        }
        // The person-unlock that clears this has no scheduler edge, so it must
        // NOT park: the ladder's cap bounds the wait after the user acts.
        // `DeviceKeyMissing` rides the same ladder for the same reason: the repair is the
        // identity phrase entry, and a manual open has no scheduler edge either
        // (myne-md/myne#983).
        FailureClass::IdentityLocked | FailureClass::DeviceKeyMissing => {
            (FAILURE_RETRY_START_MS, FAILURE_RETRY_CAP_MS)
        }
    };
    // 2^(n-1) with a shift guard; n counts from 1 (first failure).
    let n = consecutive_failures.saturating_sub(1).min(16);
    start.saturating_mul(1u64 << n).min(cap)
}

/// What a tick decides to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncAction {
    /// Nothing to do this tick.
    Idle,
    /// Pull only (a poll interval elapsed, or an honored poke).
    Pull,
    /// Push only (the coalescing window elapsed for pending local changes).
    Push,
    /// Both are due this tick.
    PullAndPush,
}

/// The sync-loop decision state machine (clock injected — no real time).
#[derive(Debug, Clone)]
pub struct SyncScheduler {
    unlocked: bool,
    poll_interval_ms: u64,
    coalesce_window_ms: u64,
    /// Logical time of the first un-pushed local change (the coalescing anchor).
    dirty_since: Option<u64>,
    /// Logical time of the last poll, and a one-shot poke-requested pull.
    last_poll: u64,
    poke_pending: bool,
    /// Mobile lifecycle (SYNC-37/38): the app is backgrounded — the loop hard-idles
    /// while suspended (foreground-only sync), retaining pending push intent.
    suspended: bool,
    /// One-shot immediate-poll arm — set by mobile resume (guards against
    /// `Instant` not advancing across device sleep), the loop's locked→unlocked
    /// edge, and a rate-limited window focus: the next eligible tick pulls even
    /// if no interval elapsed, then the flag is consumed so it never re-fires.
    immediate_poll_pending: bool,
    /// Consecutive failed cycles (reset on success; `Skipped` is neutral).
    consecutive_failures: u32,
    /// Failure gate: no *scheduled* action (poll pull / coalesced push) fires
    /// before this logical time. Pokes and immediate polls bypass it.
    next_retry_at: Option<u64>,
    /// A device-verification eye-compare is open on this device (myne#462), so
    /// no push may author a head under it. **Pushes only** — pulls keep firing,
    /// because the approving side reaches the tip by pulling and the joining
    /// side's whole ceremony is a pull.
    ///
    /// This is deliberately NOT the `suspended` early-return shape: suspend
    /// hard-idles the loop, and hard-idling here would stall the very
    /// convergence the compare is waiting on. Mirrored from
    /// [`super::verify_hold::VerifyHold`] by the loop each tick; the authority
    /// is that lease, not this field.
    verify_hold: bool,
}

impl SyncScheduler {
    /// Construct a scheduler. `now` seeds `last_poll` so the interval clock has
    /// a defined origin; the "sync immediately on unlock" behaviour comes from
    /// the loop's unlock-edge [`SyncScheduler::arm_immediate_poll`], not from
    /// seeding `last_poll` in the past — the arm is one-shot, so the loop still
    /// cannot hammer the server.
    pub fn new(now: u64, poll_interval_ms: u64, coalesce_window_ms: u64) -> Self {
        Self {
            unlocked: false,
            poll_interval_ms,
            coalesce_window_ms,
            dirty_since: None,
            last_poll: now,
            poke_pending: false,
            suspended: false,
            immediate_poll_pending: false,
            consecutive_failures: 0,
            next_retry_at: None,
            verify_hold: false,
        }
    }

    /// Arm a one-shot immediate poll (consumed by the next unlocked, unsuspended
    /// tick; retained across locked/suspended ticks). Callers: the loop's
    /// locked→unlocked edge, [`SyncScheduler::on_resume`], and the rate-limited
    /// [`SyncScheduler::on_focus`].
    pub fn arm_immediate_poll(&mut self) {
        self.immediate_poll_pending = true;
    }

    /// The window regained OS focus. Arms an immediate poll only when the last
    /// poll is at least [`FOCUS_POLL_FLOOR_MS`] old, so focus flapping cannot
    /// drive more than one extra pull per floor window.
    pub fn on_focus(&mut self, now: u64) {
        if now.saturating_sub(self.last_poll) >= FOCUS_POLL_FLOOR_MS {
            self.arm_immediate_poll();
        }
    }

    /// Lock / unlock the scheduler. On lock, pending push intent is retained
    /// (it flushes on next unlock) but no action fires while locked.
    pub fn set_unlocked(&mut self, unlocked: bool) {
        self.unlocked = unlocked;
    }

    /// Record a local change (marks the scheduler dirty; starts the coalescing
    /// window if not already running).
    pub fn on_local_change(&mut self, now: u64) {
        if self.dirty_since.is_none() {
            self.dirty_since = Some(now);
        }
    }

    /// A `/sync/poke` arrived — request one immediate pull. Unconditional per
    /// the amended §8.3 (the poke stream is baseline behaviour, not an opt-in
    /// layer); coalescing happens naturally (one pending flag).
    pub fn on_poke(&mut self) {
        self.poke_pending = true;
    }

    /// Mobile app backgrounded (SYNC-37): hard-idle while suspended. Pending push
    /// intent (`dirty_since`) is retained — it flushes after resume. Idempotent.
    pub fn on_suspend(&mut self) {
        self.suspended = true;
    }

    /// Mobile app foregrounded (SYNC-38): clear the suspend flag and arm a
    /// one-shot immediate poll so the next `tick` pulls even if the injected
    /// clock did not advance a full interval across the sleep. `now` is not read
    /// (the arm is level-triggered, consumed on the next pull) — kept for a
    /// symmetric, clock-injected API.
    pub fn on_resume(&mut self, _now: u64) {
        self.suspended = false;
        self.arm_immediate_poll();
    }

    /// Whether a coalesced local change is still un-pushed — the flush-on-suspend
    /// seam (task 3) queries this to decide whether to spend the OS grace window.
    pub fn has_pending_push(&self) -> bool {
        self.dirty_since.is_some()
    }

    /// Mirror the device-verification push hold into the scheduler (myne#462).
    /// The loop calls this every tick from
    /// [`super::verify_hold::VerifyHold::is_held`], the same way it feeds
    /// [`Self::on_suspend`] / [`Self::on_resume`] from the lifecycle signal.
    ///
    /// **Why the scheduler needs this at all**, given that the cycle itself also
    /// refuses to push while held: without it `tick` would still return `Push`,
    /// **consuming `dirty_since`**, and the cycle would then run push-free and
    /// report success — after which nothing re-arms the intent (`on_cycle_outcome`
    /// only re-arms on failure). The edit would sit unpushed until some unrelated
    /// local change re-dirtied the scheduler. This field's job is to leave the
    /// anchor alone.
    pub fn set_verify_hold(&mut self, held: bool) {
        self.verify_hold = held;
    }

    /// Decide what to do at logical time `now`, advancing internal state.
    pub fn tick(&mut self, now: u64) -> SyncAction {
        // Locked OR suspended → no action; all pending state is retained for the
        // next unlock/resume (early return touches nothing).
        if !self.unlocked || self.suspended {
            return SyncAction::Idle;
        }

        // Failure gate: scheduled actions wait it out; pokes / immediate polls
        // bypass it (a bypassing pull that succeeds clears the gate).
        let gated = self.next_retry_at.is_some_and(|t| now < t);

        // Pull is due on a poll interval (unless gated), an honored poke, or the
        // one-shot immediate poll (unlock edge / focus / resume-on-foreground).
        let poll_due = now.saturating_sub(self.last_poll) >= self.poll_interval_ms;
        let pull = (poll_due && !gated) || self.poke_pending || self.immediate_poll_pending;
        if pull {
            self.last_poll = now;
            self.poke_pending = false;
            self.immediate_poll_pending = false;
        }

        // Push is due once the coalescing window has elapsed since the first
        // pending change (resolution-blur). While gated the intent is RETAINED,
        // not consumed — a failed cycle must never strand an edit locally. The
        // verify hold (myne#462) rides on exactly that property: it suppresses
        // the push without touching `dirty_since`, so the edit flushes the moment
        // the eye-compare closes.
        let push = match self.dirty_since {
            Some(t)
                if !gated
                    && !self.verify_hold
                    && now.saturating_sub(t) >= self.coalesce_window_ms =>
            {
                self.dirty_since = None;
                true
            }
            _ => false,
        };

        match (pull, push) {
            (true, true) => SyncAction::PullAndPush,
            (true, false) => SyncAction::Pull,
            (false, true) => SyncAction::Push,
            (false, false) => SyncAction::Idle,
        }
    }

    /// Feed one cycle's outcome back into the scheduler (the loop calls this
    /// after every non-idle tick). On failure of a push-carrying action the
    /// consumed push intent is re-armed **pre-aged** (the edit already served
    /// its full coalescing window once — retry timing is then governed solely
    /// by the failure gate, and an edit that arrived mid-cycle keeps its own,
    /// newer anchor so its window is never shortened).
    pub fn on_cycle_outcome(&mut self, action: SyncAction, result: CycleResult, now: u64) {
        match result {
            CycleResult::Success => {
                self.consecutive_failures = 0;
                self.next_retry_at = None;
            }
            // Locked / unenrolled / disabled — the cycle never really ran.
            CycleResult::Skipped => {}
            CycleResult::Failed(class) => {
                if matches!(action, SyncAction::Push | SyncAction::PullAndPush)
                    && self.dirty_since.is_none()
                {
                    self.dirty_since = Some(now.saturating_sub(self.coalesce_window_ms));
                }
                self.consecutive_failures = self.consecutive_failures.saturating_add(1);
                self.next_retry_at =
                    Some(now.saturating_add(retry_delay_ms(class, self.consecutive_failures)));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime glue (task 9): the tokio task that drives the scheduler. The decision
// logic above is pure + unit-tested; this is the thin "spawn / timer / Slot read
// / transport call" layer the module doc promised, mirroring `auto_lock`.
//
// **Everything below this line is host-gated; everything above it is not**
// (phase3-web-client task 84). The split is the whole point: the decision logic
// is the privacy-load-bearing part — poll cadence, focus rate-limiting, push
// coalescing, the extend-only retry ladder — and a browser that re-derived it
// would be a second answer to questions `sync-protocol.md` §8.3 and the A13
// timing posture have exactly one. What genuinely differs is only how a tick
// ARRIVES (a `tokio::time::interval` here, a Worker timer there) and where the
// per-tick inputs are read from (`Manager::try_state` singletons here, Worker
// state there), so those are the only things gated.
//
// The wasm arm's driver is not written yet and is deliberately absent rather
// than stubbed: it needs the sync data plane dispatched into the Worker (tasks
// 22/23/33), and a driver with nothing to drive would be a shape guess frozen
// into the tree. What this ungating buys today is that when it arrives, it
// binds to THIS `SyncScheduler` — there is no second one to write.
// ---------------------------------------------------------------------------

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Emitter, Manager, Runtime};
// `now_unix_millis` for the verify-hold lease (myne#462) — wall-clock, because
// the lease is armed from a WebView that cannot see this loop's origin.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::HostCtx as _;

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Device-local "a note changed" signal: the note-save path bumps it, the sync
/// loop reads it to mark the scheduler dirty (the coalesced-push trigger). A
/// monotone counter — the loop only cares whether it advanced since last tick.
#[derive(Default)]
pub struct SyncLocalChange(AtomicU64);

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
impl SyncLocalChange {
    /// Note-save calls this after a successful write (soft dependency via
    /// `app.try_state` — a no-op when the sync plugin isn't registered).
    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Device-local mobile-lifecycle signal (SYNC-38): the platform event source
/// (mobile `WindowEvent::Suspended`/`Resumed`, task 2) sets it, the sync loop
/// reads it each tick to drive `SyncScheduler::on_suspend`/`on_resume`. Desktop
/// never registers it (`try_state` → `None` → no-op), so desktop behaviour is
/// unchanged. `resume` arms a one-shot immediate-poll consumed by the loop.
#[derive(Default)]
pub struct SyncLifecycleSignal {
    suspended: AtomicBool,
    resume_poll_requested: AtomicBool,
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
impl SyncLifecycleSignal {
    /// App backgrounded — the loop hard-idles the scheduler.
    pub fn suspend(&self) {
        self.suspended.store(true, Ordering::Relaxed);
    }
    /// App foregrounded — clear suspend + request the one-shot resume poll.
    pub fn resume(&self) {
        self.suspended.store(false, Ordering::Relaxed);
        self.resume_poll_requested.store(true, Ordering::Relaxed);
    }
    pub(crate) fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::Relaxed)
    }
    /// Consume the one-shot resume-poll request (true at most once per resume).
    fn take_resume_poll(&self) -> bool {
        self.resume_poll_requested.swap(false, Ordering::Relaxed)
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Desktop window-focus signal: the host's `WindowEvent::Focused(true)` handler
/// bumps it, the loop reads it each tick to drive the rate-limited
/// [`SyncScheduler::on_focus`] immediate poll. Mobile never registers it
/// (`try_state` → `None` → no-op) — foreground/background arrives through
/// [`SyncLifecycleSignal`] there. A monotone counter like [`SyncLocalChange`].
#[derive(Default)]
pub struct SyncFocusSignal(AtomicU64);

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
impl SyncFocusSignal {
    /// The host window regained focus.
    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Base loop cadence — a fine tick so the scheduler's logical clock advances; the
/// scheduler itself enforces the poll interval + the coalescing window.
const LOOP_TICK_MS: u64 = 1_000;

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
/// Spawn the background sync loop (wired in `lib.rs` setup, exactly like
/// `auto_lock::spawn_idle_lock_timer`). Unlock-gated. Polling-default +
/// coalesced-push per the MYND-424 grill (decision B); the SSE-opt-in
/// (`/sync/poke`) listener is a thin follow-up. Emits `sync://changed` (with the
/// pulled count) when a cycle writes incoming notes to disk, so the UI reloads.
pub fn spawn_sync_loop<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        let mut sched = SyncScheduler::new(0, DEFAULT_POLL_INTERVAL_MS, DEFAULT_COALESCE_WINDOW_MS);
        let mut last_change_seen = 0u64;
        let mut last_focus_seen = 0u64;
        let mut last_poke_seen = 0u64;
        let mut prev_unlocked = false;
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(LOOP_TICK_MS));
        loop {
            ticker.tick().await;
            let now = start.elapsed().as_millis() as u64;

            // Unlock gate (active_vault_id is Some only for an Unlocked slot).
            let unlocked =
                match app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>() {
                    Some(state) => state.active_vault_id().await.is_some(),
                    None => false,
                };
            sched.set_unlocked(unlocked);

            // Locked→unlocked edge (and app-start with an already-unlocked
            // vault): sync immediately instead of waiting out the first full
            // interval — closes the "unlock, then reach for Sync Now" gap.
            if unlocked && !prev_unlocked {
                sched.arm_immediate_poll();
            }
            prev_unlocked = unlocked;

            // A local note change starts the coalescing window (push trigger).
            if let Some(sig) = app.try_state::<SyncLocalChange>() {
                let c = sig.get();
                if c != last_change_seen {
                    last_change_seen = c;
                    sched.on_local_change(now);
                }
            }

            // Desktop window focus: returning to the app pulls fresh state
            // without waiting out the interval (rate-limited in the scheduler).
            if let Some(sig) = app.try_state::<SyncFocusSignal>() {
                let f = sig.get();
                if f != last_focus_seen {
                    last_focus_seen = f;
                    sched.on_focus(now);
                }
            }

            // A `/sync/poke` arrived on the SSE stream (`poke_listener` bumps
            // the signal, including the catch-up bump on every reconnect) →
            // one immediate pull.
            if let Some(sig) = app.try_state::<super::poke_listener::SsePokeSignal>() {
                let p = sig.get();
                if p != last_poke_seen {
                    last_poke_seen = p;
                    sched.on_poke();
                }
            }

            // Mobile lifecycle (SYNC-37/38): suspend hard-idles the scheduler;
            // resume arms the one-shot immediate poll. Desktop never registers
            // the signal (`try_state` → None), so this is a no-op there.
            if let Some(sig) = app.try_state::<SyncLifecycleSignal>() {
                if sig.is_suspended() {
                    sched.on_suspend();
                } else if sig.take_resume_poll() {
                    sched.on_resume(now);
                }
            }

            // Device-verification eye-compare open on this device (myne#462)?
            // Mirror the lease into the scheduler so `tick` withholds the push
            // WITHOUT consuming `dirty_since` — the cycle refuses to push while
            // held either way, but a consumed anchor would leave the edit
            // unpushed until some unrelated local change re-dirtied the
            // scheduler, because `on_cycle_outcome` only re-arms on failure.
            //
            // Wall-clock, not the loop's monotonic `now`: the lease is armed from
            // a WebView that has no access to this loop's origin.
            sched.set_verify_hold(
                super::verify_hold::verify_hold().is_held(
                    crate::host::tauri_host::TauriHost::new(app.clone()).now_unix_millis(),
                ),
            );

            let action = sched.tick(now);
            if action == SyncAction::Idle {
                continue;
            }
            let allow_push = matches!(action, SyncAction::Push | SyncAction::PullAndPush);

            // Publish "a cycle is in flight" (SYNC-36) so the status indicator
            // reflects real activity, not a poll-late guess. No-op if the cell
            // isn't registered (try_state → None).
            if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                cell.set_syncing();
                let _ = app.emit("sync://status-changed", ());
            }

            let outcome = super::commands::run_active_cycle(&app, allow_push).await;
            // Re-read the clock — the cycle takes real time, and the failure
            // gate / re-armed push anchor must be relative to its END.
            let now_after = start.elapsed().as_millis() as u64;
            let result = match &outcome {
                super::commands::CycleOutcome::Ran(_) => CycleResult::Success,
                super::commands::CycleOutcome::Failed(class) => CycleResult::Failed(*class),
                super::commands::CycleOutcome::NotReady
                | super::commands::CycleOutcome::Disabled => CycleResult::Skipped,
            };
            sched.on_cycle_outcome(action, result, now_after);

            match outcome {
                super::commands::CycleOutcome::Ran(summary) => {
                    if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                        // A cycle that RAN and could not upload is not `clear` (myne-md/myne#1027).
                        // Clearing it fell back to `Idle`, and the indicator renders `Idle` as
                        // "Synced" — so the one state a user most needs to see looked identical
                        // to a healthy device. The cause travels on the summary from the cycle,
                        // which is the only place that knows the verdict.
                        match summary.upload_blocked {
                            Some(detail) => cell.set_blocked(detail),
                            None => cell.clear(),
                        }
                    }
                    if summary.pulled > 0 || summary.dropped > 0 {
                        // Pulled notes are on disk (or reconcile quarantined
                        // absentees) — tell the UI to reload.
                        let _ = app.emit("sync://changed", summary.pulled);
                    }
                    let _ = app.emit("sync://status-changed", ());
                }
                super::commands::CycleOutcome::Failed(class) => {
                    // The loop no longer swallows Failed — it publishes Error so
                    // the status dot reports a failed background cycle, not only
                    // a manual sync_now click (SYNC-36). Detail is class-scoped
                    // so the UI can distinguish auth/throttle from a plain blip.
                    if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                        cell.set_error(class.status_detail());
                    }
                    let _ = app.emit("sync://status-changed", ());
                }
                // NotReady (locked / unenrolled) / Disabled are not real failures
                // — clear the overlay so status falls back to the honest base
                // config state (Pending / NotEnrolled / Disabled / Idle).
                _ => {
                    if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                        cell.clear();
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sched() -> SyncScheduler {
        SyncScheduler::new(0, 30_000, 5_000)
    }

    #[test]
    fn locked_scheduler_is_always_idle() {
        let mut s = sched();
        s.on_local_change(0);
        // even with a poll interval elapsed and a pending change, locked → Idle
        assert_eq!(s.tick(100_000), SyncAction::Idle);
    }

    #[test]
    fn polling_pull_fires_on_interval_when_unlocked() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(10_000), SyncAction::Idle); // < interval
        assert_eq!(s.tick(30_000), SyncAction::Pull); // interval elapsed
        assert_eq!(s.tick(40_000), SyncAction::Idle); // reset; < interval again
    }

    #[test]
    fn poke_triggers_immediate_pull_and_coalesces() {
        let mut s = sched();
        s.set_unlocked(true);
        // Pokes are baseline behaviour (amended §8.3) — no toggle gates them.
        s.on_poke();
        s.on_poke(); // a burst coalesces into the single pending flag
        assert_eq!(s.tick(1_000), SyncAction::Pull);
        assert_eq!(s.tick(1_100), SyncAction::Idle); // consumed — no double pull
    }

    #[test]
    fn poke_while_locked_is_retained_until_unlock() {
        let mut s = sched();
        s.on_poke();
        assert_eq!(s.tick(1_000), SyncAction::Idle); // locked → nothing
        s.set_unlocked(true);
        assert_eq!(s.tick(1_100), SyncAction::Pull); // honored after unlock
    }

    #[test]
    fn push_is_coalesced_to_the_window() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000);
        // within the window → no push (timing blurred)
        assert_eq!(s.tick(3_000), SyncAction::Idle);
        // window elapsed → push fires once
        assert_eq!(s.tick(6_000), SyncAction::Push);
        // dirty cleared → no repeat
        assert_eq!(s.tick(6_100), SyncAction::Idle);
    }

    #[test]
    fn rapid_edits_collapse_to_one_push() {
        let mut s = sched();
        s.set_unlocked(true);
        // a burst of edits — only the first anchors the window
        s.on_local_change(1_000);
        s.on_local_change(1_010);
        s.on_local_change(1_500);
        assert_eq!(s.tick(2_000), SyncAction::Idle); // still within window
        assert_eq!(s.tick(6_000), SyncAction::Push); // one coalesced push
        assert_eq!(s.tick(6_500), SyncAction::Idle);
    }

    #[test]
    fn pull_and_push_can_coincide() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000);
        assert_eq!(s.tick(30_000), SyncAction::PullAndPush);
    }

    #[test]
    fn pending_change_survives_lock_and_flushes_on_unlock() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000);
        s.set_unlocked(false);
        assert_eq!(s.tick(10_000), SyncAction::Idle); // locked → nothing
        s.set_unlocked(true);
        assert_eq!(s.tick(10_001), SyncAction::Push); // window long elapsed → flush
    }

    // ── Mobile lifecycle (SYNC-37/38) ──────────────────────────────────────

    #[test]
    fn suspend_forces_idle_even_with_elapsed_interval_and_pending_change() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000); // pending push
        s.on_suspend();
        // A full poll interval elapsed AND a change is pending, but suspended → Idle.
        assert_eq!(s.tick(100_000), SyncAction::Idle);
        assert!(
            s.has_pending_push(),
            "suspend must retain pending push intent"
        );
    }

    #[test]
    fn resume_arms_one_shot_immediate_poll_with_non_advanced_clock() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_suspend();
        assert_eq!(s.tick(5_000), SyncAction::Idle); // suspended
        s.on_resume(5_000);
        // Clock has NOT advanced a full interval, but resume armed the poll → Pull.
        assert_eq!(s.tick(5_000), SyncAction::Pull);
        // One-shot: the next tick (still < interval) is Idle again.
        assert_eq!(s.tick(5_100), SyncAction::Idle);
    }

    // ── Immediate-poll edge triggers (unlock / focus) ──────────────────────

    #[test]
    fn armed_immediate_poll_fires_once_and_survives_lock() {
        let mut s = sched();
        s.arm_immediate_poll(); // unlock-edge arm while still locked
        assert_eq!(s.tick(1_000), SyncAction::Idle); // locked → retained, not consumed
        s.set_unlocked(true);
        assert_eq!(s.tick(1_100), SyncAction::Pull); // consumed on the first eligible tick
        assert_eq!(s.tick(1_200), SyncAction::Idle); // one-shot: no re-fire
    }

    #[test]
    fn focus_respects_last_poll_floor() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull); // interval poll; last_poll = 30_000
        s.on_focus(35_000); // 5 s after the poll — under the floor → ignored
        assert_eq!(s.tick(35_000), SyncAction::Idle);
        s.on_focus(41_000); // 11 s after — over the floor → arms
        assert_eq!(s.tick(41_000), SyncAction::Pull);
        s.on_focus(45_000); // floor re-anchored at 41_000 → ignored again
        assert_eq!(s.tick(45_000), SyncAction::Idle);
    }

    #[test]
    fn focus_arm_survives_suspend_and_fires_after_resume() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_suspend();
        s.on_focus(20_000); // arms (last_poll = 0, floor long met)
        assert_eq!(s.tick(20_000), SyncAction::Idle); // suspended → retained
        s.on_resume(20_001);
        assert_eq!(s.tick(20_001), SyncAction::Pull);
        assert_eq!(s.tick(20_100), SyncAction::Idle); // still one-shot overall
    }

    #[test]
    fn has_pending_push_is_true_iff_a_coalesced_change_is_unpushed() {
        let mut s = sched();
        assert!(!s.has_pending_push());
        s.set_unlocked(true);
        s.on_local_change(1_000);
        assert!(s.has_pending_push());
        assert_eq!(s.tick(10_000), SyncAction::Push); // window elapsed → flush
        assert!(!s.has_pending_push()); // pushed → cleared
    }

    #[test]
    fn pending_push_survives_suspend_resume_and_flushes() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000); // pending push
        s.on_suspend();
        assert_eq!(s.tick(10_000), SyncAction::Idle); // suspended → nothing (retained)
        assert!(s.has_pending_push());
        s.on_resume(10_001);
        // Resume poll + the long-elapsed coalescing window → both fire.
        assert_eq!(s.tick(10_001), SyncAction::PullAndPush);
        assert!(!s.has_pending_push()); // flushed after resume
    }

    // ── Failure re-arm + class-based retry gate ────────────────────────────

    #[test]
    fn failed_push_rearms_dirty_and_retries_after_gate() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(5_000), SyncAction::Push); // window elapsed, dirty consumed
                                                     // The cycle fails — intent must be re-armed, gated 1 s (first failure).
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            5_000,
        );
        assert!(s.has_pending_push(), "failed push must re-arm the intent");
        assert_eq!(s.tick(5_500), SyncAction::Idle); // gated
        assert_eq!(s.tick(6_100), SyncAction::Push); // gate passed → retry
    }

    #[test]
    fn push_retry_gate_doubles_and_caps() {
        // The pure ladder: 1s, 2s, 4s … capped at 120s; no shift overflow.
        assert_eq!(retry_delay_ms(FailureClass::Transport, 1), 1_000);
        assert_eq!(retry_delay_ms(FailureClass::Transport, 2), 2_000);
        assert_eq!(retry_delay_ms(FailureClass::Transport, 3), 4_000);
        assert_eq!(retry_delay_ms(FailureClass::Transport, 8), 120_000); // 128s → cap
        assert_eq!(retry_delay_ms(FailureClass::Transport, 500), 120_000); // shift guard
        assert_eq!(retry_delay_ms(FailureClass::Other, 1), 1_000); // Other shares the ladder
                                                                   // Behavioral doubling through the scheduler.
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(5_000), SyncAction::Push);
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            5_000,
        );
        assert_eq!(s.tick(6_000), SyncAction::Push); // retry after 1s
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            6_000,
        );
        assert_eq!(s.tick(7_000), SyncAction::Idle); // second gate is 2s
        assert_eq!(s.tick(8_000), SyncAction::Push);
    }

    #[test]
    fn success_resets_gate_and_counter() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(5_000), SyncAction::Push);
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            5_000,
        );
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            6_000,
        );
        assert_eq!(s.tick(8_000), SyncAction::Push); // 2s gate passed
        s.on_cycle_outcome(SyncAction::Push, CycleResult::Success, 8_000);
        // Counter reset: a NEW failure starts the ladder at 1s again, and no
        // gate is pending now (interval poll at 30s fires normally).
        assert_eq!(s.tick(30_000), SyncAction::Pull);
    }

    /// A failed TLS handshake parks rather than reconnect-spinning, and says
    /// which trust boundary failed rather than claiming the device is offline.
    #[test]
    fn a_tls_failure_parks_and_keeps_its_own_name() {
        assert_eq!(
            retry_delay_ms(FailureClass::TlsFailure, 1),
            AUTH_PARK_MS,
            "an invalid certificate cannot be retried out of"
        );
        assert_eq!(
            retry_delay_ms(FailureClass::TlsFailure, 9),
            retry_delay_ms(FailureClass::TlsFailure, 1),
            "parking is flat: there is nothing to back off from"
        );
        assert_ne!(
            retry_delay_ms(FailureClass::TlsFailure, 1),
            retry_delay_ms(FailureClass::Transport, 1),
            "it must NOT share the transport ladder it used to be folded into"
        );
        assert_eq!(FailureClass::TlsFailure.status_detail(), "tls_failure");
        assert_ne!(
            FailureClass::TlsFailure.status_detail(),
            FailureClass::Transport.status_detail(),
            "the whole defect was these two sharing the string \"sync_failed\""
        );
    }

    /// A full LOCAL store parks, and it parks distinctly from a full ACCOUNT
    /// (phase3-web-client task 91).
    ///
    /// Both are "no room", both are unfixable by retrying, and they park on the
    /// same ladder — but they are different sentences to the user and only one of
    /// them is fixable on this device. A client that reported a full disk as
    /// "you are over your storage limit" would send someone to an account page
    /// while their own drive was what filled up.
    #[test]
    fn a_full_local_store_parks_and_says_which_store() {
        assert_eq!(
            retry_delay_ms(FailureClass::StorageFull, 1),
            retry_delay_ms(FailureClass::QuotaExceeded, 1),
            "both park — retrying cannot help until someone frees something"
        );
        assert_eq!(
            retry_delay_ms(FailureClass::StorageFull, 9),
            retry_delay_ms(FailureClass::StorageFull, 1),
            "parking is flat, not exponential — there is nothing to back off from"
        );
        assert_ne!(
            FailureClass::StorageFull.status_detail(),
            FailureClass::QuotaExceeded.status_detail(),
            "the two must not collapse into one message"
        );
        assert_eq!(FailureClass::StorageFull.status_detail(), "storage_full");
    }

    /// An `NTV6` vault whose signed head cannot be built for lack of a held
    /// person identity is its own class, NOT the generic "sync failed", and it
    /// retries on the ladder rather than parking: the unlock that clears it has
    /// no scheduler edge, so a 15-minute park would delay the first successful
    /// cycle long after the user acted.
    #[test]
    fn a_locked_person_identity_is_named_and_retries_on_the_ladder() {
        assert_eq!(
            FailureClass::IdentityLocked.status_detail(),
            "identity_locked"
        );
        assert_ne!(
            FailureClass::IdentityLocked.status_detail(),
            FailureClass::Other.status_detail(),
            "the whole defect was this collapsing into the generic \"sync_failed\""
        );
        assert_eq!(
            retry_delay_ms(FailureClass::IdentityLocked, 1),
            FAILURE_RETRY_START_MS,
            "it must retry on the ladder, not park"
        );
        assert_ne!(
            retry_delay_ms(FailureClass::IdentityLocked, 1),
            AUTH_PARK_MS,
            "parking would strand the first retry after the user unlocks the identity"
        );
        assert_eq!(
            retry_delay_ms(FailureClass::IdentityLocked, 8),
            FAILURE_RETRY_CAP_MS
        );
    }

    #[test]
    fn failed_pull_does_not_rearm_dirty() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull); // interval poll
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::Transport),
            30_000,
        );
        assert!(
            !s.has_pending_push(),
            "a pull-only failure must not invent push intent"
        );
    }

    #[test]
    fn dirty_retained_not_consumed_while_gated() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull);
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::RateLimited),
            30_000,
        );
        s.on_local_change(31_000);
        // Window elapses inside the 60s rate-limit gate: intent retained, not consumed.
        assert_eq!(s.tick(40_000), SyncAction::Idle);
        assert!(
            s.has_pending_push(),
            "gated tick must retain, not consume, the intent"
        );
        assert_eq!(s.tick(90_000), SyncAction::PullAndPush); // gate passed → both
    }

    #[test]
    fn rate_limited_stretches_polls() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull);
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::RateLimited),
            30_000,
        );
        assert_eq!(s.tick(60_000), SyncAction::Idle); // poll due but gated (60s ladder)
        assert_eq!(s.tick(90_000), SyncAction::Pull); // gate passed
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::RateLimited),
            90_000,
        );
        assert_eq!(s.tick(150_000), SyncAction::Idle); // second gate = 120s
        assert_eq!(s.tick(210_000), SyncAction::Pull);
    }

    #[test]
    fn unauthenticated_parks_for_auth_park_ms() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull);
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::Unauthenticated),
            30_000,
        );
        assert_eq!(s.tick(500_000), SyncAction::Idle); // parked
        assert_eq!(s.tick(930_000), SyncAction::Pull); // AUTH_PARK_MS elapsed
    }

    /// Task 94's "desktop and mobile behaviour on the same code unchanged"
    /// criterion, at the layer that decides it: a revoked device parks on the
    /// SAME ladder as an expired token. The class exists to be SAID, not to
    /// change the schedule — and nothing in this file may ever make it
    /// destructive, because a server signal must not erase a user's own machine.
    #[test]
    fn device_revoked_parks_exactly_like_unauthenticated() {
        let mut a = sched();
        let mut b = sched();
        a.set_unlocked(true);
        b.set_unlocked(true);
        assert_eq!(a.tick(30_000), SyncAction::Pull);
        assert_eq!(b.tick(30_000), SyncAction::Pull);
        a.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::Unauthenticated),
            30_000,
        );
        b.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::DeviceRevoked),
            30_000,
        );
        for t in [500_000, 930_000, 1_000_000] {
            assert_eq!(
                a.tick(t),
                b.tick(t),
                "the two must park identically at {t}ms"
            );
        }
    }

    /// …and yet is DISTINGUISHABLE where it matters: the status detail the UI
    /// reads. Collapsing it into `auth_failed` would tell a user whose device was
    /// deliberately removed that their sign-in expired, and send them to re-enrol
    /// a device the account owner just cut off.
    #[test]
    fn device_revoked_carries_its_own_status_detail() {
        assert_eq!(
            FailureClass::DeviceRevoked.status_detail(),
            "device_revoked"
        );
        assert_ne!(
            FailureClass::DeviceRevoked.status_detail(),
            FailureClass::Unauthenticated.status_detail()
        );
    }

    #[test]
    fn poke_bypasses_failure_gate_and_success_ungates_push() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(5_000), SyncAction::Push);
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Unauthenticated),
            5_000,
        );
        // Parked for 900s — but a poke still pulls immediately (push stays gated).
        s.on_poke();
        assert_eq!(s.tick(6_000), SyncAction::Pull);
        // The bypassing pull succeeds → gate cleared → pending push flows next tick.
        s.on_cycle_outcome(SyncAction::Pull, CycleResult::Success, 6_000);
        assert_eq!(s.tick(7_000), SyncAction::Push);
    }

    #[test]
    fn immediate_poll_bypasses_failure_gate() {
        let mut s = sched();
        s.set_unlocked(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull);
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::RateLimited),
            30_000,
        );
        s.arm_immediate_poll(); // unlock edge / focus / resume
        assert_eq!(s.tick(31_000), SyncAction::Pull); // gate bypassed
    }

    #[test]
    fn consumed_poke_not_restored_on_failure() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_poke();
        assert_eq!(s.tick(1_000), SyncAction::Pull); // poke consumed
        s.on_cycle_outcome(
            SyncAction::Pull,
            CycleResult::Failed(FailureClass::Transport),
            1_000,
        );
        // No 1s-tick retry storm: the poke is NOT restored; past the gate there
        // is still no pull until the regular interval.
        assert_eq!(s.tick(1_500), SyncAction::Idle); // gated
        assert_eq!(s.tick(3_000), SyncAction::Idle); // gate passed, interval not due
        assert_eq!(s.tick(31_000), SyncAction::Pull); // interval poll covers recovery
    }

    #[test]
    fn skipped_outcome_is_neutral() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(5_000), SyncAction::Push);
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            5_000,
        );
        // A Skipped outcome (vault locked mid-flight) must not RESET the gate…
        s.on_cycle_outcome(SyncAction::Push, CycleResult::Skipped, 5_100);
        assert_eq!(s.tick(5_500), SyncAction::Idle); // still gated (1s from the failure)
        assert_eq!(s.tick(6_100), SyncAction::Push); // retry
                                                     // …and must not COUNT as a failure: this next failure is n=2 → a 2s
                                                     // gate (a 4s gate here would mean Skipped was counted as n=2).
        s.on_cycle_outcome(
            SyncAction::Push,
            CycleResult::Failed(FailureClass::Transport),
            6_100,
        );
        assert_eq!(s.tick(7_500), SyncAction::Idle); // inside the 2s gate
        assert_eq!(s.tick(8_200), SyncAction::Push); // 2s gate passed (4s would still Idle)
    }

    // --- the device-verification push hold (myne#462) ---

    /// The property the whole hold rests on: a held push is **withheld, not
    /// consumed**. If `tick` returned `Push` and cleared `dirty_since`, the
    /// cycle would then run push-free (the cycle refuses too) and report
    /// success — and `on_cycle_outcome` re-arms only on FAILURE, so the edit
    /// would sit unpushed until some unrelated local change happened to
    /// re-dirty the scheduler.
    #[test]
    fn a_held_push_is_withheld_rather_than_consumed() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(1_000);
        s.set_verify_hold(true);
        // Window elapsed, but the compare is open.
        assert_eq!(s.tick(10_000), SyncAction::Idle);
        assert!(s.has_pending_push(), "the coalescing anchor must survive");
        // Still held a poll interval later — the intent keeps surviving, and
        // the pull that tick is due still fires.
        assert_eq!(s.tick(40_000), SyncAction::Pull);
        assert!(s.has_pending_push());
        // Compare closed → the edit flushes on the next eligible tick.
        s.set_verify_hold(false);
        assert_eq!(s.tick(41_000), SyncAction::Push);
        assert!(!s.has_pending_push());
    }

    /// The hold is push-only. Withholding pulls would stall the very
    /// convergence the compare is waiting on — the approving side reaches the
    /// head it displays BY pulling, and the joining side's whole ceremony is a
    /// pull.
    #[test]
    fn a_hold_never_withholds_a_pull_or_a_poke() {
        let mut s = sched();
        s.set_unlocked(true);
        s.set_verify_hold(true);
        assert_eq!(s.tick(30_000), SyncAction::Pull); // interval pull still fires
        s.on_poke();
        assert_eq!(s.tick(30_100), SyncAction::Pull); // pokes still honored
    }

    /// A tick that would have been `PullAndPush` degrades to `Pull`, keeping
    /// its push intent. This is the shape a real ceremony hits: the poll
    /// interval and the coalescing window both elapse while the screen is open.
    #[test]
    fn a_hold_downgrades_pull_and_push_to_pull() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_local_change(0);
        assert_eq!(s.tick(30_000), SyncAction::PullAndPush); // baseline shape
        s.on_local_change(30_001);
        s.set_verify_hold(true);
        assert_eq!(s.tick(60_000), SyncAction::Pull);
        assert!(s.has_pending_push());
    }

    /// Deliberately NOT the `suspended` shape: suspend hard-idles everything,
    /// which here would be wrong. This pins the difference so a later "unify
    /// these two flags" refactor has to argue with a failing test.
    #[test]
    fn a_hold_is_not_a_suspend() {
        let mut held = sched();
        held.set_unlocked(true);
        held.set_verify_hold(true);
        let mut suspended = sched();
        suspended.set_unlocked(true);
        suspended.on_suspend();
        assert_eq!(held.tick(30_000), SyncAction::Pull);
        assert_eq!(suspended.tick(30_000), SyncAction::Idle);
    }
}
