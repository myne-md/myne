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
//! - **Polling is the default** (story 7) — pulls fire on a fixed interval. The
//!   server is never told the device is continuously online.
//! - **SSE is opt-in** — a `/sync/poke` (the 423 channel) only triggers a pull
//!   when the `useSyncPrefs` toggle is on; with it off, pokes are ignored and
//!   polling alone drives pulls.
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
    sse_enabled: bool,
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
    /// One-shot immediate-poll armed on resume — guards against `Instant` not
    /// advancing across device sleep: the next tick pulls even if no interval
    /// elapsed, then the flag is consumed so it never re-fires.
    resume_poll_pending: bool,
}

impl SyncScheduler {
    /// Construct a scheduler. `now` seeds `last_poll` so the first poll waits a
    /// full interval (the loop does not hammer the server on unlock).
    pub fn new(now: u64, poll_interval_ms: u64, coalesce_window_ms: u64) -> Self {
        Self {
            unlocked: false,
            sse_enabled: false,
            poll_interval_ms,
            coalesce_window_ms,
            dirty_since: None,
            last_poll: now,
            poke_pending: false,
            suspended: false,
            resume_poll_pending: false,
        }
    }

    /// Lock / unlock the scheduler. On lock, pending push intent is retained
    /// (it flushes on next unlock) but no action fires while locked.
    pub fn set_unlocked(&mut self, unlocked: bool) {
        self.unlocked = unlocked;
    }

    /// Toggle the SSE opt-in (`useSyncPrefs`). With it off, pokes are ignored.
    pub fn set_sse_enabled(&mut self, enabled: bool) {
        self.sse_enabled = enabled;
        if !enabled {
            self.poke_pending = false;
        }
    }

    /// Record a local change (marks the scheduler dirty; starts the coalescing
    /// window if not already running).
    pub fn on_local_change(&mut self, now: u64) {
        if self.dirty_since.is_none() {
            self.dirty_since = Some(now);
        }
    }

    /// A `/sync/poke` arrived. Honored only when SSE is opted in; otherwise a
    /// no-op (polling drives pulls).
    pub fn on_poke(&mut self) {
        if self.sse_enabled {
            self.poke_pending = true;
        }
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
        self.resume_poll_pending = true;
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
        // resume poll (immediate-poll-on-foreground).
        let poll_due = now.saturating_sub(self.last_poll) >= self.poll_interval_ms;
        let pull = poll_due || self.poke_pending || self.resume_poll_pending;
        if pull {
            self.last_poll = now;
            self.poke_pending = false;
            self.resume_poll_pending = false;
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
    fn is_suspended(&self) -> bool {
        self.suspended.load(Ordering::Relaxed)
    }
    /// Consume the one-shot resume-poll request (true at most once per resume).
    fn take_resume_poll(&self) -> bool {
        self.resume_poll_requested.swap(false, Ordering::Relaxed)
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

            // A local note change starts the coalescing window (push trigger).
            if let Some(sig) = app.try_state::<SyncLocalChange>() {
                let c = sig.get();
                if c != last_change_seen {
                    last_change_seen = c;
                    sched.on_local_change(now);
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
    fn poke_ignored_unless_sse_enabled() {
        let mut s = sched();
        s.set_unlocked(true);
        s.on_poke(); // SSE off → ignored
        assert_eq!(s.tick(1_000), SyncAction::Idle);

        s.set_sse_enabled(true);
        s.on_poke();
        assert_eq!(s.tick(1_100), SyncAction::Pull); // honored poke → immediate pull
    }

    #[test]
    fn disabling_sse_clears_a_pending_poke() {
        let mut s = sched();
        s.set_unlocked(true);
        s.set_sse_enabled(true);
        s.on_poke();
        s.set_sse_enabled(false); // toggled back off before the tick
        assert_eq!(s.tick(500), SyncAction::Idle);
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
