//! Clip-handoff rate limiter (TB10, user story 21).
//!
//! A runaway or compromised extension build (A14) could flood the vault
//! with clip notes faster than the user would notice. This is the bound:
//! a fixed-window limiter caps how many clip handoffs the host will accept
//! per unit time. Over-limit handoffs are REJECTED (no write), not queued
//! — honest back-pressure the extension surfaces as an error (task 8).
//!
//! ## Design
//!
//! A simple **fixed-window counter**: at most [`DEFAULT_MAX_PER_WINDOW`]
//! accepted handoffs per [`DEFAULT_WINDOW`]. The window is anchored to a
//! caller-supplied monotonic `Instant`, so the limiter is fully
//! deterministic in tests (no wall-clock, no sleeping) — the host passes
//! `Instant::now()` at each handoff. A token-bucket would smooth bursts
//! better, but a fixed window is the smaller, more auditable primitive and
//! the threat here is *sustained* flooding, which either shape bounds
//! equally.
//!
//! Only ACCEPTED handoffs consume budget. A handoff rejected for any other
//! reason (bad frame, unpaired caller, validation failure) never reaches
//! the limiter — rate-limiting is the LAST gate before a write, so a
//! flood of malformed frames cannot exhaust a legitimate sender's budget.
//!
//! This is the standalone limiter primitive + its tests. The relay listener
//! owns ONE process-global [`SharedRateLimiter`] (created before the accept
//! loop, shared by `Arc` across every connection thread) and calls
//! [`RateLimiter::check`] just before composing the `note_create` call — so the
//! budget spans ALL native-messaging connections. A *per-connection* limiter
//! would reset on every host-process reconnect, letting a compromised build
//! (A14) obtain a fresh full budget per connection; the shared wrapper closes
//! that bypass while `check` locks only for the brief decision (never across a
//! connection's blocking dispatch), so per-connection concurrency is preserved.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline" — the
//! limiter holds only counts + timestamps, never any note content.

use std::time::{Duration, Instant};

/// Default: at most 60 accepted clip handoffs per 60-second window.
///
/// One clip/second sustained is far above any human clipping cadence
/// (a human clicks the toolbar a handful of times a minute at most) yet
/// low enough that a compromised build cannot silently bury the vault
/// under thousands of notes before the user notices. Tunable later if a
/// legitimate batch-import use case emerges; v1 is deliberately tight.
pub const DEFAULT_MAX_PER_WINDOW: u32 = 60;

/// Default fixed window: 60 seconds.
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(60);

/// Outcome of a rate-limit check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateDecision {
    /// The handoff is within budget and was counted. Proceed to write.
    Allowed,
    /// The handoff would exceed the window budget — REJECT it (no write).
    /// The extension surfaces this as a "slow down / try again" error
    /// (task 8); the host emits no note.
    Throttled,
}

/// A fixed-window clip-handoff rate limiter.
///
/// Deterministic: every decision is a pure function of the
/// caller-supplied `Instant` and the limiter's prior state, so tests
/// drive it with synthetic time and never sleep.
#[derive(Debug)]
pub struct RateLimiter {
    max_per_window: u32,
    window: Duration,
    /// Start of the current window, or `None` before the first handoff.
    window_start: Option<Instant>,
    /// Accepted handoffs in the current window.
    count: u32,
}

impl RateLimiter {
    /// Construct a limiter with explicit parameters (used by tests and by
    /// the host if it ever needs a non-default cadence).
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        RateLimiter {
            max_per_window,
            window,
            window_start: None,
            count: 0,
        }
    }

    /// Check (and, if allowed, record) a clip handoff at time `now`.
    ///
    /// Returns [`RateDecision::Allowed`] if the handoff is within the
    /// current window's budget — and records it — or
    /// [`RateDecision::Throttled`] if accepting it would exceed the cap.
    /// A throttled handoff does NOT consume budget (it is rejected before
    /// the write), so the count only ever reflects accepted handoffs.
    ///
    /// The window rolls forward when `now` is at or past
    /// `window_start + window`: the counter resets and the new handoff
    /// starts a fresh window.
    pub fn check(&mut self, now: Instant) -> RateDecision {
        match self.window_start {
            // Roll the window forward if the current one has elapsed.
            Some(start) if now.duration_since(start) >= self.window => {
                self.window_start = Some(now);
                self.count = 1;
                RateDecision::Allowed
            }
            Some(_) => {
                if self.count < self.max_per_window {
                    self.count += 1;
                    RateDecision::Allowed
                } else {
                    RateDecision::Throttled
                }
            }
            // First handoff ever — open the first window.
            None => {
                self.window_start = Some(now);
                self.count = 1;
                RateDecision::Allowed
            }
        }
    }
}

impl Default for RateLimiter {
    /// The production limiter: [`DEFAULT_MAX_PER_WINDOW`] per
    /// [`DEFAULT_WINDOW`].
    fn default() -> Self {
        RateLimiter::new(DEFAULT_MAX_PER_WINDOW, DEFAULT_WINDOW)
    }
}

/// Process-global, thread-safe wrapper around a single [`RateLimiter`].
///
/// The fixed-window budget must span ALL native-messaging connections rather
/// than resetting per connection. Native messaging spawns a fresh host process
/// — hence a fresh Unix-socket connection — per dispatch pattern, so a
/// per-connection limiter handed every reconnect a brand-new full budget,
/// defeating the A14 flood bound the limiter exists to enforce. The relay
/// listener constructs ONE `SharedRateLimiter` before its accept loop and
/// shares it (via `Arc`) with every connection thread.
///
/// [`check`](Self::check) locks the inner mutex ONLY for the brief decision —
/// never across a connection's blocking dispatch (which can park up to the
/// 30 s dispatch timeout) — so the shared budget does not serialize concurrent
/// connections. A poisoned lock fails CLOSED (`Throttled`): a panic mid-update
/// must never open the floodgate.
#[derive(Debug, Default)]
pub struct SharedRateLimiter {
    inner: std::sync::Mutex<RateLimiter>,
}

impl SharedRateLimiter {
    /// Construct from explicit parameters. Test-only: production always uses
    /// [`SharedRateLimiter::default`] (the documented 60/60 s cadence); a
    /// custom-cadence constructor compiled into the shipping binary would be
    /// dead code, so it is gated to test builds.
    #[cfg(test)]
    pub fn new(max_per_window: u32, window: Duration) -> Self {
        SharedRateLimiter {
            inner: std::sync::Mutex::new(RateLimiter::new(max_per_window, window)),
        }
    }

    /// Check (and, if allowed, record) a handoff at `now`, holding the lock
    /// only for the decision. A poisoned lock fails closed (`Throttled`).
    pub fn check(&self, now: Instant) -> RateDecision {
        match self.inner.lock() {
            Ok(mut limiter) => limiter.check(now),
            Err(_) => RateDecision::Throttled,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_the_cap_then_throttles() {
        let mut rl = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        // 4th within the window → throttled.
        assert_eq!(rl.check(t0), RateDecision::Throttled);
        // Still throttled while the window holds.
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
        // Exactly at the window boundary → a fresh window opens.
        let t1 = t0 + Duration::from_secs(60);
        assert_eq!(rl.check(t1), RateDecision::Allowed);
        assert_eq!(rl.check(t1), RateDecision::Allowed);
        assert_eq!(rl.check(t1), RateDecision::Throttled);
    }

    #[test]
    fn throttled_handoffs_do_not_consume_budget() {
        // A burst of throttled checks must not extend or reset the window
        // — the budget reflects only accepted handoffs.
        let mut rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        // Many throttled attempts mid-window.
        for _ in 0..100 {
            assert_eq!(
                rl.check(t0 + Duration::from_secs(1)),
                RateDecision::Throttled
            );
        }
        // The window still rolls at t0 + 60 (not extended by the burst).
        assert_eq!(
            rl.check(t0 + Duration::from_secs(60)),
            RateDecision::Allowed
        );
    }

    #[test]
    fn just_before_window_end_still_throttles() {
        let mut rl = RateLimiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(rl.check(t0), RateDecision::Allowed);
        // 1ms before the window closes — still the same window.
        let almost = t0 + Duration::from_millis(59_999);
        assert_eq!(rl.check(almost), RateDecision::Throttled);
    }

    #[test]
    fn default_limiter_uses_documented_constants() {
        let mut rl = RateLimiter::default();
        let t0 = Instant::now();
        // Burn the whole documented budget within one window.
        for _ in 0..DEFAULT_MAX_PER_WINDOW {
            assert_eq!(rl.check(t0), RateDecision::Allowed);
        }
        // One over → throttled.
        assert_eq!(rl.check(t0), RateDecision::Throttled);
    }

    #[test]
    fn shared_limiter_budget_spans_connections() {
        use std::sync::Arc;
        // Regression (H2): the budget is process-GLOBAL, not per-connection.
        // Two `Arc` handles stand in for two connection threads; the second
        // "connection" counts against the first's budget and does NOT get a
        // fresh window — a host-process reconnect cannot reset the flood cap.
        let shared = Arc::new(SharedRateLimiter::new(2, Duration::from_secs(60)));
        let conn_a = Arc::clone(&shared);
        let conn_b = Arc::clone(&shared);
        let t0 = Instant::now();
        assert_eq!(conn_a.check(t0), RateDecision::Allowed);
        assert_eq!(conn_a.check(t0), RateDecision::Allowed);
        // conn_b shares conn_a's now-exhausted budget.
        assert_eq!(conn_b.check(t0), RateDecision::Throttled);
        // And it stays throttled within the same window.
        assert_eq!(
            conn_a.check(t0 + Duration::from_secs(59)),
            RateDecision::Throttled
        );
    }
}
