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

    /// Decide what to do at logical time `now`, advancing internal state.
    pub fn tick(&mut self, now: u64) -> SyncAction {
        if !self.unlocked {
            return SyncAction::Idle;
        }

        // Pull is due on a poll interval, or when an honored poke is pending.
        let poll_due = now.saturating_sub(self.last_poll) >= self.poll_interval_ms;
        let pull = poll_due || self.poke_pending;
        if pull {
            self.last_poll = now;
            self.poke_pending = false;
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
}
