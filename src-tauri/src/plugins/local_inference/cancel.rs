// SPDX-License-Identifier: AGPL-3.0-only
//! Streaming cancellation (conversational-ai-chat task 4).
//!
//! A single [`CancelToken`] shared between the active streaming generation and
//! the two things that can abort it:
//!   - the composer **"Stop"** command (a UX affordance — the user cuts a
//!     rambling generation short), and
//!   - the **vault-lock** teardown (a *correctness* requirement, not a nicety:
//!     chat history is RAM-only and dropped on lock, so a generation must not
//!     keep emitting into a torn-down transcript/channel after the vault locks).
//!
//! **Per request, not per process (ai-provider-seam task 10).** The original
//! design used one process-global flag, sound under a premise it stated openly:
//! *"only one generation runs at a time (the engine's compute lock serializes
//! all model work)"*. That is a property of the **Candle backend**, not of the
//! seam — a backend that serializes out of process can genuinely run two
//! requests at once, and then "Stop" on one would abort the other. So each
//! request now takes its own [`CancelToken`] from a [`CancelRegistry`], and the
//! two abort paths differ in reach on purpose:
//!   - **composer Stop** cancels the newest in-flight request (which is what a
//!     single Stop button means while chat is the only streaming surface — the
//!     registry can already cancel any request by id, so a second surface needs
//!     no redesign here, only an id on the wire);
//!   - **vault-lock teardown** cancels **every** in-flight request. That one is
//!     the correctness requirement, and it must stay total.
//!
//! The token is checked at the emit seam ([`guarded_on_token`]) — a Qwen
//! generation emits decoded text on ~every token, so an abort takes effect
//! within a token or two (prompt enough; the alternative, threading a cancel
//! check into the engine's inner loop, would couple the engine to this state).
//!
//! The vault-lock teardown call site lands in task 12; the command wiring
//! (`app.manage` + `chat_stream`/`chat_stop`) is task 5.

use std::collections::BTreeMap;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use super::cancellable_io::CancelledFn;

/// A cloneable, thread-safe abort flag for the active streaming generation.
/// Clones share the same underlying flag (via `Arc`), so the streaming callback
/// and the setters (composer Stop / vault-lock) all observe the same state.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// Signal the active generation to stop. Idempotent; safe from any thread.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether an abort has been signalled.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Build the streaming `on_token` callback for a generation guarded by `cancel`.
///
/// **Publish-guard:** the cancel flag is checked **before** forwarding a token,
/// so once an abort is signalled (composer Stop or vault-lock) no further token
/// is pushed to `sink` and generation stops ([`ControlFlow::Break`]). This is
/// the load-bearing property: a vault-lock mid-generation can never emit a token
/// into a torn-down transcript/channel. The partial text already streamed to
/// `sink` stays (nothing is retracted); the engine returns what it produced.
pub fn guarded_on_token<'a>(
    cancel: &'a CancelToken,
    mut sink: impl FnMut(&str) + 'a,
) -> impl FnMut(&str) -> ControlFlow<()> + 'a {
    move |delta: &str| {
        if cancel.is_cancelled() {
            ControlFlow::Break(())
        } else {
            sink(delta);
            ControlFlow::Continue(())
        }
    }
}

/// Which abort paths may reach a request (myne-md/myne#445).
///
/// It exists because registering a request is now what makes the vault-lock
/// teardown able to abort it, so every provider-bound command registers — and
/// `cancel_newest`'s premise ("chat is the only registered surface, so *newest*
/// is what a single Stop button means") stopped being true the moment a rewrite
/// or a grounded answer took a token too. Without this distinction, pressing
/// Stop in the composer while a rewrite happened to start later would abort the
/// rewrite and leave the chat streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReach {
    /// Both abort paths reach it: the composer's Stop **and** the vault-lock
    /// teardown. Today exactly one surface — the streaming chat turn.
    StopAndLock,
    /// Only the vault-lock teardown reaches it. A request with no Stop button
    /// of its own: `infer`, `infer_ambient`, `ask`. Registering them is not
    /// cosmetic — before it, `cancel_all` had nothing to cancel while one was in
    /// flight, so a provider request outlived the lock that dropped the vault it
    /// was answering about, and on a metered API kept billing.
    LockOnly,
}

/// Registry of the tokens for every in-flight streaming request.
///
/// `BTreeMap` rather than a `Vec` so "the newest" is `last_key_value()` — ids
/// are monotonic, so newest is well-defined even after out-of-order completion.
#[derive(Default)]
pub struct CancelRegistry {
    inner: Mutex<BTreeMap<u64, (CancelReach, CancelToken)>>,
    next_id: AtomicU64,
}

impl CancelRegistry {
    /// Take a token for a new request. The returned guard deregisters on drop,
    /// so a panicking or early-returning command cannot leak an entry — which
    /// would make a later `cancel_newest` abort a request that already ended.
    ///
    /// `reach` says which abort paths may reach it; see [`CancelReach`].
    pub fn begin(&self, reach: CancelReach) -> CancelGuard<'_> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let token = CancelToken::default();
        self.inner
            .lock()
            .expect("cancel registry mutex poisoned")
            .insert(id, (reach, token.clone()));
        CancelGuard {
            registry: self,
            id,
            token,
        }
    }

    /// Whether ANY in-flight request is cancelled.
    ///
    /// The abort source for a backend that cannot be interrupted at an emit
    /// seam (myne-md/myne#440). `RemoteEngine::chat_streaming` does not stream:
    /// it blocks on one `post_json` and then calls `on_token` once with the
    /// whole reply, so [`guarded_on_token`] only ever looks AFTER the request
    /// has completed. The transport's cancel poll is the only thing that can
    /// abort a provider call mid-flight, and it was wired to a closure that
    /// always answered `false` — Stop and vault-lock were both inert against a
    /// provider.
    ///
    /// **No longer the abort source for a per-request engine call** (#445). The
    /// four commands that carry a prompt to a backend each hand the engine a
    /// [`RequestCancel`] built from their OWN token, so cancelling one no longer
    /// reaches the others.
    ///
    /// What still rides this: the construction-time source baked into every
    /// engine at plugin setup (`mod.rs::cancel_source`), which covers the calls
    /// that take no per-request predicate — the loopback `embed`, the served
    /// model-identity query, the provider model list. Those keep the coarse
    /// behaviour, and it is coarse in both directions: with nothing registered
    /// it answers `false`, so one of them in flight during a lock with no other
    /// request open is not aborted at all. Narrowing that means threading a
    /// predicate through those call sites too, which is worth doing when one of
    /// them can run long enough to matter.
    pub fn any_cancelled(&self) -> bool {
        self.inner
            .lock()
            .expect("cancel registry mutex poisoned")
            .values()
            .any(|(_, t)| t.is_cancelled())
    }

    /// Cancel one request by id. `false` when it already finished.
    ///
    /// No production caller yet: the composer's single Stop means "the newest",
    /// and a second streaming surface is what would put an id on the wire. Kept
    /// because it is the primitive the other two are expressed against, and
    /// because it is what proves per-request targeting in the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cancel(&self, id: u64) -> bool {
        let guard = self.inner.lock().expect("cancel registry mutex poisoned");
        match guard.get(&id) {
            Some((_, t)) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// Cancel the newest in-flight request **that has a Stop button** — the
    /// composer Stop path.
    ///
    /// Newest among [`CancelReach::StopAndLock`] only. A `LockOnly` request
    /// (`infer`, `ask`) is registered so the vault-lock teardown can reach it,
    /// not so an unrelated surface's Stop can: cancelling the newest *anything*
    /// would mean a rewrite that started after the chat turn swallows the Stop
    /// meant for the chat.
    pub fn cancel_newest(&self) -> bool {
        let guard = self.inner.lock().expect("cancel registry mutex poisoned");
        match guard
            .iter()
            .rev()
            .find(|(_, (reach, _))| *reach == CancelReach::StopAndLock)
        {
            Some((_, (_, t))) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// Cancel **every** in-flight request — the vault-lock teardown path.
    ///
    /// Total by requirement, not by convenience: chat history is RAM-only and
    /// dropped on lock, so no generation may keep emitting into a torn-down
    /// transcript. A per-request registry makes it possible to miss one; this
    /// is the method that must not.
    pub fn cancel_all(&self) {
        for (_, (_, t)) in self
            .inner
            .lock()
            .expect("cancel registry mutex poisoned")
            .iter()
        {
            t.cancel();
        }
    }

    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.inner
            .lock()
            .expect("cancel registry mutex poisoned")
            .len()
    }
}

/// The abort predicate for **one** request, obtainable only from a registered
/// [`CancelGuard`] (myne-md/myne#445).
///
/// The newtype is the whole mechanism. [`CancelledFn`] is a bare
/// `Arc<dyn Fn() -> bool>`, so a command could have handed its engine
/// `Arc::new(|| false)` — or the fleet-wide [`CancelRegistry::any_cancelled`],
/// which is what every one of them did — and neither the compiler nor a lint
/// would have said anything. Requiring *this* type at the command core means a
/// prompt cannot reach a backend unless a token for it exists in the registry,
/// which is what turns the vault-lock teardown's totality from something a call
/// site has to remember into something it cannot avoid.
///
/// Cheap to clone (one `Arc`), because the blocking engine call needs `'static`.
#[derive(Clone)]
pub struct RequestCancel(CancelledFn);

impl RequestCancel {
    /// The predicate, for handing to an [`super::engine::Engine`] method.
    pub fn as_fn(&self) -> &CancelledFn {
        &self.0
    }
}

/// One request's cancellation handle. Deregisters itself on drop.
pub struct CancelGuard<'a> {
    registry: &'a CancelRegistry,
    id: u64,
    token: CancelToken,
}

impl CancelGuard<'_> {
    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    /// This request's own abort predicate — what the engine polls between
    /// socket waits. Reads **only** this token, which is the whole point: the
    /// engine aborts when *this* request is cancelled and not when some other
    /// one is.
    pub fn request_cancel(&self) -> RequestCancel {
        let token = self.token.clone();
        RequestCancel(Arc::new(move || token.is_cancelled()))
    }

    #[cfg(test)]
    fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for CancelGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .inner
            .lock()
            .expect("cancel registry mutex poisoned")
            .remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::local_inference::engine::{Engine, StubEngine};

    /// `reset()` is gone: a fresh turn takes a fresh token, so there is no
    /// shared flag left to clear. The semantics it protected — a prior Stop must
    /// not abort the next generation — are now structural and are asserted by
    /// `a_new_request_is_never_born_cancelled` below, which is a stronger claim
    /// than "someone remembered to call reset".
    #[test]
    fn token_starts_uncancelled_then_cancels_idempotently() {
        let t = CancelToken::default();
        assert!(!t.is_cancelled());
        t.cancel();
        assert!(t.is_cancelled());
        t.cancel(); // idempotent
        assert!(t.is_cancelled());
    }

    #[test]
    fn clones_share_the_same_flag() {
        let a = CancelToken::default();
        let b = a.clone();
        a.cancel();
        assert!(b.is_cancelled(), "a clone observes the same abort");
    }

    #[test]
    fn guarded_on_token_forwards_every_token_when_not_cancelled() {
        let engine = StubEngine;
        let cancel = CancelToken::default();
        let mut collected = String::new();
        let out = {
            let mut cb = guarded_on_token(&cancel, |t| collected.push_str(t));
            engine.infer_streaming("alpha beta", &mut cb).unwrap()
        };
        // Nothing cancelled → the sink received the whole stream, == the return.
        assert_eq!(collected, out);
        assert!(collected.contains("alpha"));
        assert!(collected.contains("beta"));
    }

    #[test]
    fn guarded_on_token_publish_guard_blocks_post_cancel_tokens() {
        let engine = StubEngine;
        let cancel = CancelToken::default();
        let mut collected = String::new();
        {
            // The sink cancels itself after the first forwarded token; the NEXT
            // token must be blocked by the publish-guard (checked before sink).
            let mut forwarded = 0;
            let mut cb = guarded_on_token(&cancel, |t| {
                collected.push_str(t);
                forwarded += 1;
                if forwarded == 1 {
                    cancel.cancel();
                }
            });
            let _ = engine
                .infer_streaming("stub-infer stops early here", &mut cb)
                .unwrap();
        }
        // Partial preserved (something streamed before the abort)…
        assert!(!collected.is_empty(), "partial text is preserved");
        // …but the guard stopped forwarding after the cancel: the later tokens
        // ("early", "here") never reached the sink.
        assert!(
            !collected.contains("early") && !collected.contains("here"),
            "publish-guard blocked post-cancel tokens, got: {collected:?}"
        );
    }

    #[test]
    fn cancelling_one_request_leaves_the_other_running() {
        let reg = CancelRegistry::default();
        let a = reg.begin(CancelReach::StopAndLock);
        let b = reg.begin(CancelReach::StopAndLock);
        assert!(reg.cancel(a.id()));
        assert!(a.token().is_cancelled());
        assert!(
            !b.token().is_cancelled(),
            "the whole point: one request's Stop must not abort the other"
        );
    }

    #[test]
    fn vault_lock_cancels_every_in_flight_request() {
        let reg = CancelRegistry::default();
        let a = reg.begin(CancelReach::StopAndLock);
        let b = reg.begin(CancelReach::StopAndLock);
        let c = reg.begin(CancelReach::StopAndLock);
        reg.cancel_all();
        // Total by requirement — chat history is RAM-only and dropped on lock.
        for (name, g) in [("a", &a), ("b", &b), ("c", &c)] {
            assert!(g.token().is_cancelled(), "request {name} survived the lock");
        }
    }

    #[test]
    fn composer_stop_hits_the_newest_request() {
        let reg = CancelRegistry::default();
        let older = reg.begin(CancelReach::StopAndLock);
        let newer = reg.begin(CancelReach::StopAndLock);
        assert!(reg.cancel_newest());
        assert!(newer.token().is_cancelled());
        assert!(!older.token().is_cancelled());
    }

    /// The reach split (myne-md/myne#445).
    ///
    /// Registering `infer`/`ask` is what lets the vault-lock teardown abort a
    /// provider request — but it also put them in the path of `cancel_newest`,
    /// whose whole definition ("the newest") assumed chat was the only thing in
    /// the map. Without the split, a rewrite that started after the chat turn
    /// swallows the Stop the user pressed on the chat, and the chat keeps
    /// streaming into the transcript they were trying to cut off.
    #[test]
    fn composer_stop_skips_a_request_with_no_stop_button_but_the_lock_does_not() {
        let reg = CancelRegistry::default();
        let chat = reg.begin(CancelReach::StopAndLock);
        // Newer, and deliberately so: "newest" is what makes this fail if the
        // reach is ignored.
        let rewrite = reg.begin(CancelReach::LockOnly);

        assert!(
            reg.cancel_newest(),
            "there IS a stoppable request in flight"
        );
        assert!(
            chat.token().is_cancelled(),
            "the Stop must reach the newest STOPPABLE request — the chat turn"
        );
        assert!(
            !rewrite.token().is_cancelled(),
            "a LockOnly request has no Stop button; a composer Stop must not \
             abort it just because it started later"
        );

        // The lock is the path that must stay total, LockOnly included — that
        // is the entire reason these register at all.
        reg.cancel_all();
        assert!(rewrite.token().is_cancelled(), "vault lock must be total");
    }

    /// With nothing stoppable in flight, Stop is a no-op rather than reaching
    /// for whatever else happens to be registered.
    #[test]
    fn composer_stop_with_only_lock_only_requests_cancels_nothing() {
        let reg = CancelRegistry::default();
        let a = reg.begin(CancelReach::LockOnly);
        let b = reg.begin(CancelReach::LockOnly);
        assert!(!reg.cancel_newest(), "nothing has a Stop button");
        assert!(!a.token().is_cancelled());
        assert!(!b.token().is_cancelled());
    }

    /// The predicate an engine actually polls reads ONE token (#445).
    ///
    /// This is the primitive the four command call sites hand to the engine in
    /// place of `any_cancelled`. Asserted in both directions: cancelling A must
    /// abort A and must NOT abort B, and the vault-lock's total cancel must
    /// reach both — the second half is what keeps the totality requirement true
    /// after cancellation stopped being fleet-wide.
    #[test]
    fn a_request_cancel_answers_for_its_own_request_only() {
        let reg = CancelRegistry::default();
        let a = reg.begin(CancelReach::StopAndLock);
        let b = reg.begin(CancelReach::LockOnly);
        let (fa, fb) = (a.request_cancel(), b.request_cancel());

        assert!(!fa.as_fn()(), "a fresh request is not cancelled");
        assert!(!fb.as_fn()());

        reg.cancel(a.id());
        assert!(fa.as_fn()(), "A's predicate must see A's cancel");
        assert!(
            !fb.as_fn()(),
            "B's predicate must NOT see A's cancel — this is the whole issue: \
             `any_cancelled` answered true here and aborted B's request too"
        );

        reg.cancel_all();
        assert!(fb.as_fn()(), "the vault-lock teardown must reach B as well");
    }

    #[test]
    fn a_finished_request_deregisters_and_cannot_be_cancelled_afterwards() {
        let reg = CancelRegistry::default();
        let id = {
            let g = reg.begin(CancelReach::StopAndLock);
            assert_eq!(reg.in_flight(), 1);
            g.id()
        };
        assert_eq!(reg.in_flight(), 0, "the guard deregisters on drop");
        // A leaked entry would let a later Stop abort a request that already
        // ended — or, worse, one that reused the slot.
        assert!(!reg.cancel(id));
        assert!(!reg.cancel_newest(), "nothing in flight, nothing to cancel");
    }

    /// Each request starts uncancelled, so a prior Stop cannot abort the next
    /// generation — the reset-before-each-turn semantics, now structural: a new
    /// turn takes a NEW token rather than clearing a shared one.
    #[test]
    fn a_new_request_is_never_born_cancelled() {
        let reg = CancelRegistry::default();
        {
            let first = reg.begin(CancelReach::StopAndLock);
            first.token().cancel();
        }
        let second = reg.begin(CancelReach::StopAndLock);
        assert!(!second.token().is_cancelled());
    }

    /// The abort source a non-streaming backend polls (myne-md/myne#440).
    ///
    /// Both abort paths must reach it: the composer's Stop (`cancel_newest`)
    /// and the vault-lock teardown (`cancel_all`, the correctness requirement
    /// this module's doc calls total). Before this, a provider request could be
    /// stopped by neither — the transport's cancel poll was wired to a closure
    /// that always answered `false`.
    #[test]
    fn any_cancelled_sees_both_abort_paths_and_forgets_finished_requests() {
        let reg = CancelRegistry::default();
        assert!(!reg.any_cancelled(), "idle registry cancels nothing");

        {
            let a = reg.begin(CancelReach::StopAndLock);
            assert!(!reg.any_cancelled(), "a fresh request is not cancelled");
            reg.cancel_newest();
            assert!(reg.any_cancelled(), "composer Stop must reach the poll");
            drop(a);
        }
        assert!(
            !reg.any_cancelled(),
            "a finished request must not keep the poll cancelled forever — a stale \
             token would abort every LATER provider call"
        );

        {
            let _b = reg.begin(CancelReach::StopAndLock);
            reg.cancel_all();
            assert!(
                reg.any_cancelled(),
                "vault-lock teardown must reach the poll"
            );
        }
        assert!(!reg.any_cancelled());
    }
}
