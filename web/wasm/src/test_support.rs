// SPDX-License-Identifier: AGPL-3.0
//! Test-only helpers for this crate's host-build test modules.
//!
//! # Why a `block_on` of our own, and why it re-polls
//!
//! The router's arms and `sync_loop::tick` are `async`, but on the locked path
//! they are meant never to SUSPEND: `tick` returns before it reaches the network
//! cycle, and every router arm answers from memory or a refused host call. That
//! is worth asserting, and pulling a test-only executor into the crate to do it
//! would be a dependency this workspace's reproducibility bar would rather not
//! pay for.
//!
//! A single `poll` was the first shape and it was FLAKY — roughly one run in
//! twenty under `cargo test`, same commit, same machine. The reason is that
//! `tick` reads the process-wide slot map through an async
//! `tokio::sync::RwLock` (`myne_core::plugins::vault_unlock::state::
//! VaultRuntimeState::slots`), and the router's tests run in PARALLEL with it
//! and take that SAME lock for writing (`vault_lock` against an empty map,
//! which `dispatched_names_match_the_router` drives). A reader that arrives
//! during that write legitimately pends, and a single-poll helper reported a
//! lock a sibling test held for a few microseconds as "the future suspended".
//!
//! So this polls again, yielding the thread, until a bounded budget is spent.
//! Contention resolves within a poll or two; a future that genuinely suspends —
//! a timer, or the cycle this helper exists to prove is not reached — never
//! resolves and still fails, only after the budget. The guard is kept rather
//! than weakened: the failure moved from "one `Pending`" to "never became
//! ready".

use std::future::Future;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

/// Generous enough that a lock held by a sibling test is always out-lived, and
/// small enough that a genuinely suspended future fails promptly.
const POLL_BUDGET: usize = 1_000_000;

/// Drive `fut` to completion, tolerating a transient `Pending`.
///
/// `what` names the caller in the panic message, so a real suspension still
/// says which surface hung.
pub(crate) fn block_on<F: Future>(mut fut: F, what: &str) -> F::Output {
    // A waker that does nothing: this helper re-polls itself and never parks,
    // so it has no use for a wake-up.
    const VTABLE: RawWakerVTable = RawWakerVTable::new(
        |_| RawWaker::new(std::ptr::null(), &VTABLE),
        |_| {},
        |_| {},
        |_| {},
    );
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let mut cx = Context::from_waker(&waker);
    // SAFETY: `fut` is owned by this frame and never moved after pinning.
    let mut fut = unsafe { std::pin::Pin::new_unchecked(&mut fut) };
    for _ in 0..POLL_BUDGET {
        if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
    panic!("{what} future never became ready; the locked/no-network path must not suspend");
}
