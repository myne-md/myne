//! Command-socket rate limit (cli-thin-client task 10; MYND-490).
//!
//! **This is a slowdown, not a protection, and that distinction is binding
//! on every string in this file.** `docs/threat-model.md` §7's entry for
//! this door is explicit that no identity gatekeeper exists: a program
//! running as the same OS user can invoke the legitimate CLI, so nothing
//! here decides *who* is allowed through. What the limiter does is bound
//! the *rate* at which a runaway or hostile script can drain the vault at
//! full speed — a script that would otherwise read ten thousand notes in
//! two seconds takes long enough that a human is still in the loop. Nothing
//! in this module, in the wire copy it produces, or in the Settings
//! affordance that removes it (task 12) may describe it as a protection, or
//! describe its removal as disabling one; the second claim is worse than
//! the first, because it implies a protection was there.
//!
//! ## Removable, on purpose
//!
//! Legitimate bulk work — piping every note through pandoc — otherwise
//! fights a guard rail meant for someone else, so `cli_rate_limit_disabled`
//! (task 2's `vault.prefs` field, class `DeviceLocal`) turns it off. The
//! flag is an [`AtomicBool`] the lifecycle supervisor refreshes on every
//! tick from the live prefs read it already performs, so a change in
//! Settings takes effect within one supervisor tick — **no app restart**,
//! which is task 10's own acceptance criterion. That is why the disabled
//! flag lives beside the counter rather than being baked in at construction.
//!
//! ## Design
//!
//! A fixed-window counter, the same primitive (and for the same "smaller,
//! more auditable" reason) as `crate::clipper::rate_limit`: at most
//! [`DEFAULT_MAX_PER_WINDOW`] served requests per [`DEFAULT_WINDOW`],
//! anchored to a caller-supplied monotonic `Instant` so every test is
//! deterministic and never sleeps.
//!
//! One limiter is created per process by the lifecycle supervisor and
//! shared (by `Arc`) with every socket the supervisor opens, so the budget
//! spans connections *and* survives a lock/unlock cycle — a per-connection
//! limiter would hand a fresh full budget to every `myne` invocation, which
//! is exactly the shape of the loop this bounds.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — the
//! limiter holds counts and timestamps, never a note id, folder or body.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Default: at most 120 served requests per 60-second window.
///
/// Two per second sustained. An interactive user never approaches it (a
/// human types a handful of `myne` commands a minute), and a modest
/// `for id in $(myne list); do myne show $id; done` over a small vault
/// finishes inside one window — while a tight loop over a large vault,
/// which is the case this bounds, is slowed to a pace a human can notice
/// and interrupt. Bulk work at full speed is the removal switch's job, not
/// a reason to raise this number.
pub const DEFAULT_MAX_PER_WINDOW: u32 = 120;

/// Default fixed window: 60 seconds.
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(60);

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateDecision {
    /// Within budget and counted. Serve the request.
    Allowed,
    /// Over the window budget — answer with the `rate_limited` wire kind
    /// and serve nothing. The CLI turns that into its own distinct,
    /// non-hanging exit code (`cli/src/exit.rs::RATE_LIMITED`); it never
    /// waits, and it never retries on the caller's behalf.
    Throttled,
}

/// A fixed-window request limiter. Deterministic: every decision is a pure
/// function of the caller-supplied `Instant` and the prior state.
#[derive(Debug)]
pub struct RateLimiter {
    max_per_window: u32,
    window: Duration,
    /// Start of the current window, or `None` before the first request.
    window_start: Option<Instant>,
    /// Requests served in the current window.
    count: u32,
}

impl RateLimiter {
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        RateLimiter {
            max_per_window,
            window,
            window_start: None,
            count: 0,
        }
    }

    /// Check (and, if allowed, record) one request at time `now`.
    ///
    /// A throttled request does NOT consume budget — the count reflects
    /// only requests actually served, so a burst of refusals can neither
    /// extend the window nor deepen the hole the caller is in.
    ///
    /// The window is opened (or rolled) first and the cap is applied
    /// second, deliberately: writing it the other way round — the shape
    /// `crate::clipper::rate_limit` uses — lets the first request of a
    /// window through unconditionally, so a cap of 0 serves one request
    /// per window instead of none. Production never configures 0 (the
    /// preference is a bool, and the default cadence is
    /// [`DEFAULT_MAX_PER_WINDOW`]), but a limiter that can exceed its own
    /// cap under any configuration is not one worth reasoning about.
    pub fn check(&mut self, now: Instant) -> RateDecision {
        let window_elapsed = match self.window_start {
            Some(start) => now.duration_since(start) >= self.window,
            None => true, // first request ever — open the first window
        };
        if window_elapsed {
            self.window_start = Some(now);
            self.count = 0;
        }
        if self.count < self.max_per_window {
            self.count += 1;
            RateDecision::Allowed
        } else {
            RateDecision::Throttled
        }
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        RateLimiter::new(DEFAULT_MAX_PER_WINDOW, DEFAULT_WINDOW)
    }
}

/// Process-global, thread-safe wrapper: one budget shared by every
/// connection thread, plus the live on/off flag the supervisor refreshes
/// from `cli_rate_limit_disabled` each tick.
///
/// [`check`](Self::check) locks only for the decision, never across a
/// connection's dispatch, so the shared budget does not serialize
/// concurrent connections. A poisoned lock answers `Throttled`: with the
/// counter in an unknown state the honest answer is "come back in a
/// moment", and a user who wants no limit at all already has the switch
/// for that.
#[derive(Debug, Default)]
pub struct SharedRateLimiter {
    inner: std::sync::Mutex<RateLimiter>,
    disabled: AtomicBool,
}

impl SharedRateLimiter {
    /// Construct with an explicit cadence — test-only, matching
    /// `crate::clipper::rate_limit::SharedRateLimiter::new`'s own gate for
    /// the same reason: production always takes the documented cadence via
    /// [`SharedRateLimiter::default`], so a custom-cadence constructor
    /// compiled into the shipping binary would be dead code.
    #[cfg(test)]
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        SharedRateLimiter {
            inner: std::sync::Mutex::new(RateLimiter::new(max_per_window, window)),
            disabled: AtomicBool::new(false),
        }
    }

    /// Apply the current `cli_rate_limit_disabled` preference. Called by
    /// the lifecycle supervisor on every tick, which is what makes the
    /// Settings change take effect without an app restart.
    pub fn set_disabled(&self, disabled: bool) {
        self.disabled.store(disabled, Ordering::Relaxed);
    }

    /// Check one request at `now`. Returns `Allowed` immediately — without
    /// touching the counter — while the limit is removed, so turning it
    /// back on later starts from whatever window was last open rather than
    /// from a phantom backlog of untracked requests.
    pub fn check(&self, now: Instant) -> RateDecision {
        if self.disabled.load(Ordering::Relaxed) {
            return RateDecision::Allowed;
        }
        match self.inner.lock() {
            Ok(mut limiter) => limiter.check(now),
            Err(_) => RateDecision::Throttled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn allows_up_to_the_cap_then_throttles() {
        let mut rl = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        for _ in 0..3 {
            assert_eq!(rl.check(t0), RateDecision::Allowed);
        }
        assert_eq!(rl.check(t0), RateDecision::Throttled);
        assert_eq!(
            rl.check(t0 + Duration::from_secs(59)),
            RateDecision::Throttled
        );
    }

    #[test]
    fn window_rolls_forward_and_resets_budget() {
        let mut rl = RateLimiter::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        assert_eq!(rl.check(t0), RateDecision::Throttled);
        // Exactly at the boundary a fresh window opens.
        let t1 = t0 + Duration::from_secs(60);
        assert_eq!(rl.check(t1), RateDecision::Allowed);
        assert_eq!(rl.check(t1), RateDecision::Allowed);
        assert_eq!(rl.check(t1), RateDecision::Throttled);
    }

    #[test]
    fn throttled_requests_do_not_consume_budget() {
        let mut rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        for _ in 0..100 {
            assert_eq!(
                rl.check(t0 + Duration::from_secs(1)),
                RateDecision::Throttled
            );
        }
        // The window still rolls at t0 + 60 — the burst did not extend it.
        assert_eq!(
            rl.check(t0 + Duration::from_secs(60)),
            RateDecision::Allowed
        );
    }

    #[test]
    fn just_before_the_window_ends_still_throttles() {
        let mut rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        assert_eq!(
            rl.check(t0 + Duration::from_millis(59_999)),
            RateDecision::Throttled
        );
    }

    #[test]
    fn a_zero_cap_never_allows_anything() {
        // The cap is applied after the window opens, so "0 per window"
        // means zero — not "one, then zero" (see `check`'s doc comment).
        let mut rl = RateLimiter::new(0, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Throttled);
        assert_eq!(
            rl.check(t0 + Duration::from_secs(120)),
            RateDecision::Throttled
        );
    }

    #[test]
    fn default_limiter_uses_the_documented_constants() {
        let mut rl = RateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..DEFAULT_MAX_PER_WINDOW {
            assert_eq!(rl.check(t0), RateDecision::Allowed);
        }
        assert_eq!(rl.check(t0), RateDecision::Throttled);
    }

    #[test]
    fn the_limit_is_on_by_default() {
        // Task 10's first acceptance criterion, asserted on the exact
        // constructor production uses.
        let shared = SharedRateLimiter::default();
        let t0 = Instant::now();
        for _ in 0..DEFAULT_MAX_PER_WINDOW {
            assert_eq!(shared.check(t0), RateDecision::Allowed);
        }
        assert_eq!(shared.check(t0), RateDecision::Throttled);
    }

    #[test]
    fn budget_is_shared_across_connections() {
        // One budget for the whole process: a second `myne` invocation
        // counts against the first's window rather than opening its own.
        let shared = Arc::new(SharedRateLimiter::new(2, Duration::from_secs(60)));
        let conn_a = Arc::clone(&shared);
        let conn_b = Arc::clone(&shared);
        let t0 = Instant::now();
        assert_eq!(conn_a.check(t0), RateDecision::Allowed);
        assert_eq!(conn_a.check(t0), RateDecision::Allowed);
        assert_eq!(conn_b.check(t0), RateDecision::Throttled);
    }

    #[test]
    fn removing_the_limit_takes_effect_on_an_already_exhausted_budget() {
        // The "without restarting the app" criterion, at the mechanism
        // level: the supervisor flips this flag on its next tick from the
        // live prefs read, and an in-flight exhausted window stops
        // throttling immediately — no reconstruction, no restart.
        let shared = SharedRateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(shared.check(t0), RateDecision::Allowed);
        assert_eq!(shared.check(t0), RateDecision::Throttled);
        shared.set_disabled(true);
        for _ in 0..1_000 {
            assert_eq!(shared.check(t0), RateDecision::Allowed);
        }
    }

    #[test]
    fn restoring_the_limit_does_not_charge_for_the_removed_interval() {
        // Requests served while removed are not counted, so switching the
        // limit back on gives the window that was already open, not a
        // backlog of a thousand phantom requests.
        let shared = SharedRateLimiter::new(2, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(shared.check(t0), RateDecision::Allowed);
        shared.set_disabled(true);
        for _ in 0..1_000 {
            assert_eq!(shared.check(t0), RateDecision::Allowed);
        }
        shared.set_disabled(false);
        // One of the two slots was used before removal; the second is
        // still there, the third is not.
        assert_eq!(shared.check(t0), RateDecision::Allowed);
        assert_eq!(shared.check(t0), RateDecision::Throttled);
    }

    #[test]
    fn a_poisoned_lock_answers_throttled() {
        let shared = Arc::new(SharedRateLimiter::new(10, Duration::from_secs(60)));
        let poisoner = Arc::clone(&shared);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.inner.lock().unwrap();
            panic!("poison the limiter mutex");
        })
        .join();
        assert_eq!(shared.check(Instant::now()), RateDecision::Throttled);
        // ...and the removal switch still wins, since it is read before
        // the lock is ever taken.
        shared.set_disabled(true);
        assert_eq!(shared.check(Instant::now()), RateDecision::Allowed);
    }
}
