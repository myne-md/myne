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

    /// Decide what to do at logical time `now`, advancing internal state.
    pub fn tick(&mut self, now: u64) -> SyncAction {
        // Locked OR suspended → no action; all pending state is retained for the
        // next unlock/resume (early return touches nothing).
        if !self.unlocked || self.suspended {
            return SyncAction::Idle;
        }

        // Pull is due on a poll interval, an honored poke, or the one-shot
        // immediate poll (unlock edge / focus / resume-on-foreground).
        let poll_due = now.saturating_sub(self.last_poll) >= self.poll_interval_ms;
        let pull = poll_due || self.poke_pending || self.immediate_poll_pending;
        if pull {
            self.last_poll = now;
            self.poke_pending = false;
            self.immediate_poll_pending = false;
        }

        // Push is due once the coalescing window has elapsed since the first
        // pending change (resolution-blur).
        let push = match self.dirty_since {
            Some(t) if now.saturating_sub(t) >= self.coalesce_window_ms => {
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
}

// ---------------------------------------------------------------------------
// Runtime glue (task 9): the tokio task that drives the scheduler. The decision
// logic above is pure + unit-tested; this is the thin "spawn / timer / Slot read
// / transport call" layer the module doc promised, mirroring `auto_lock`.
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Device-local "a note changed" signal: the note-save path bumps it, the sync
/// loop reads it to mark the scheduler dirty (the coalesced-push trigger). A
/// monotone counter — the loop only cares whether it advanced since last tick.
#[derive(Default)]
pub struct SyncLocalChange(AtomicU64);

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

/// Desktop window-focus signal: the host's `WindowEvent::Focused(true)` handler
/// bumps it, the loop reads it each tick to drive the rate-limited
/// [`SyncScheduler::on_focus`] immediate poll. Mobile never registers it
/// (`try_state` → `None` → no-op) — foreground/background arrives through
/// [`SyncLifecycleSignal`] there. A monotone counter like [`SyncLocalChange`].
#[derive(Default)]
pub struct SyncFocusSignal(AtomicU64);

impl SyncFocusSignal {
    /// The host window regained focus.
    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// Base loop cadence — a fine tick so the scheduler's logical clock advances; the
/// scheduler itself enforces the poll interval + the coalescing window.
const LOOP_TICK_MS: u64 = 1_000;

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

            match super::commands::run_active_cycle(&app, allow_push).await {
                super::commands::CycleOutcome::Ran(summary) => {
                    if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                        cell.clear();
                    }
                    if summary.pulled > 0 {
                        // Pulled notes are on disk now — tell the UI to reload.
                        let _ = app.emit("sync://changed", summary.pulled);
                    }
                    let _ = app.emit("sync://status-changed", ());
                }
                super::commands::CycleOutcome::Failed => {
                    // The loop no longer swallows Failed — it publishes Error so
                    // the status dot reports a failed background cycle, not only
                    // a manual sync_now click (SYNC-36).
                    if let Some(cell) = app.try_state::<super::commands::SyncRuntimeStatusCell>() {
                        cell.set_error("sync_failed");
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
}
