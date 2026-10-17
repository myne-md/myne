// SPDX-License-Identifier: AGPL-3.0
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
//! Only one generation runs at a time (the engine's compute lock serializes all
//! model work), so a single shared token is sufficient: the streaming command
//! `reset()`s it before starting and checks it through [`guarded_on_token`];
//! the stop command and the lock teardown both `cancel()` it.
//!
//! The token is checked at the emit seam ([`guarded_on_token`]) — a Qwen
//! generation emits decoded text on ~every token, so an abort takes effect
//! within a token or two (prompt enough; the alternative, threading a cancel
//! check into the engine's inner loop, would couple the engine to this state).
//!
//! The vault-lock teardown call site lands in task 12; the command wiring
//! (`app.manage` + `chat_stream`/`chat_stop`) is task 5.

// `CancelToken::cancel` is driven by the UI "Stop" + vault-lock (task 7 / a
// later lock-teardown wiring); until those land it is unused on mobile.
#![cfg_attr(not(test), allow(dead_code))]

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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

    /// Clear the flag before starting a fresh generation. The streaming command
    /// calls this at the top of each new turn so a prior Stop doesn't abort the
    /// next generation.
    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::local_inference::engine::{Engine, StubEngine};

    #[test]
    fn token_starts_uncancelled_then_cancels_and_resets() {
        let t = CancelToken::default();
        assert!(!t.is_cancelled());
        t.cancel();
        assert!(t.is_cancelled());
        t.cancel(); // idempotent
        assert!(t.is_cancelled());
        t.reset();
        assert!(!t.is_cancelled());
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
}
