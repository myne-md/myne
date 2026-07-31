//! Compute-lock priority policy for the background auto-tag pass (MYND-651,
//! task 4).
//!
//! The engine serializes ALL model work behind a single `compute` mutex
//! (`engine_candle.rs`) — that lock is a crash-safety invariant on Metal, not a
//! perf knob, so it cannot be split. But a plain mutex is unfair: a background
//! pass that grabs it is indistinguishable from a user waiting on a summarize.
//!
//! Auto-tag runs **ambiently** — the user never asked for it — so it must be the
//! LOWEST-priority holder of that lock. This module is the ordering the mutex
//! itself cannot express: user-initiated commands register for the length of
//! their call, and the tag pass consults the register both **before** it queues
//! for `compute` and **on every generated token** once it holds it.
//!
//! Two halves, and both are needed:
//!   - **pre-flight** — a tag pass that never starts while interactive work is
//!     pending is a tag pass an interactive command can never queue behind;
//!   - **mid-flight yield** — an interactive command that arrives *after* the
//!     pass started sets the register, and the pass breaks out within a token,
//!     dropping `compute` instead of holding it for its full budget.
//!
//! **Note-open is not represented here on purpose.** Opening a note decrypts a
//! `MY01` blob and touches no model, so it never contends for `compute` at all —
//! the tag pass cannot block it by construction, which is a stronger property
//! than a priority rule. The integration proof of both claims is task 11.
//!
//! Content-free: this module holds one counter and never sees a prompt, note
//! body, or transcript (DENY-list, `src-tauri/CLAUDE.md`).

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// A cloneable register of in-flight **user-initiated** compute. Clones share
/// the same counter (via `Arc`), so the app-managed state, the command that
/// registers, and the closure the tag pass hands to the engine all observe the
/// same number — the same shape as [`super::cancel::CancelToken`].
#[derive(Clone, Default)]
pub struct ComputePriority(Arc<AtomicUsize>);

impl ComputePriority {
    /// Register a user-initiated model call for the lifetime of the returned
    /// guard. Held across the command's `spawn_blocking` await, so the count
    /// covers the call from *before* it queues for `compute` until after it
    /// releases it — a background pass yields to a waiting user, not only to a
    /// running one.
    pub fn interactive(&self) -> InteractiveGuard {
        self.0.fetch_add(1, Ordering::SeqCst);
        InteractiveGuard(self.clone())
    }

    /// Whether any user-initiated model call is pending or running. The tag
    /// pass's whole policy is "don't run while this is true".
    pub fn interactive_pending(&self) -> bool {
        self.0.load(Ordering::SeqCst) > 0
    }

    /// The `should_continue` probe the tag pass hands down to the engine:
    /// [`ControlFlow::Break`] the moment interactive work appears. Returned as a
    /// closure so the engine seam stays policy-free — it knows only "keep
    /// going?", never what a user or a preference is.
    pub fn tag_yield_probe(&self) -> impl FnMut() -> ControlFlow<()> {
        let pri = self.clone();
        move || {
            if pri.interactive_pending() {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        }
    }
}

/// RAII registration of one user-initiated model call. Decrements on drop, so
/// every early return (engine error, join failure, `?` on a gate) un-registers —
/// a leaked registration would starve auto-tag forever, which is the failure
/// mode a manual decrement invites.
pub struct InteractiveGuard(ComputePriority);

impl Drop for InteractiveGuard {
    fn drop(&mut self) {
        self.0 .0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_register_is_idle() {
        assert!(!ComputePriority::default().interactive_pending());
    }

    #[test]
    fn a_guard_marks_pending_and_drop_clears_it() {
        let pri = ComputePriority::default();
        {
            let _g = pri.interactive();
            assert!(pri.interactive_pending());
        }
        assert!(!pri.interactive_pending(), "drop un-registers");
    }

    #[test]
    fn concurrent_interactive_calls_nest_rather_than_clobber() {
        // Two user-initiated commands overlap; the register must stay "pending"
        // until BOTH finish. A bool flag would clear on the first drop and let a
        // tag pass start while the second call is still queued for `compute`.
        let pri = ComputePriority::default();
        let a = pri.interactive();
        let b = pri.interactive();
        drop(a);
        assert!(pri.interactive_pending(), "still one interactive call live");
        drop(b);
        assert!(!pri.interactive_pending());
    }

    #[test]
    fn clones_share_the_same_counter() {
        let a = ComputePriority::default();
        let b = a.clone();
        let _g = a.interactive();
        assert!(
            b.interactive_pending(),
            "a clone observes the same registration"
        );
    }

    #[test]
    fn the_yield_probe_breaks_exactly_while_interactive_work_is_live() {
        let pri = ComputePriority::default();
        let mut probe = pri.tag_yield_probe();
        assert!(probe().is_continue(), "idle → keep generating");
        let g = pri.interactive();
        assert!(probe().is_break(), "a user call arrived → yield the lock");
        drop(g);
        assert!(probe().is_continue(), "and the pass may resume next round");
    }
}
