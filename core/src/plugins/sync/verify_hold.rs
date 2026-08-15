// SPDX-License-Identifier: AGPL-3.0
//! The device-verification push hold (myne-md/myne#462).
//!
//! # What this is for
//!
//! The SYNC-40 eye-compare shows a [bootstrap-fingerprint][fp] of a vault head
//! on two screens at once and asks the user whether they read the same string.
//! `sync-protocol.md` §6.3 is normative about the derivation and silent about
//! the thing that actually broke: **a head is not a stable identity.** Every
//! push authors a new one, so two devices agree only while they sit on the same
//! head — and the ceremony itself moves it, because a joining device writes its
//! own name into `vault.prefs` the moment it adopts a head, which is a vault
//! write like any other.
//!
//! The result was a compare that cried wolf. That is a security problem rather
//! than an annoyance: `threat-model.md` §7 records this compare as the *only*
//! mitigation for the TOFU-bootstrap hole, and §6.3 says it out loud — "a user
//! trained to expect mismatches is a user who clicks through the real one".
//!
//! This module is the fix's load-bearing half: **while a verify screen is open,
//! no content push may author a head.** With the head standing still, both sides
//! converge on the same value and a match becomes deterministic instead of
//! coincidental.
//!
//! # Why a lease rather than a flag
//!
//! The hold is armed by a WebView and the WebView can die without telling
//! anyone. A plain boolean would then suppress this device's pushes forever —
//! trading a false-positive compare for silently-unsynced notes, which is a
//! straight downgrade. So the hold is a **lease**: an open screen re-arms it
//! roughly once a second, and three independent lapses bound it.
//!
//! * [`VERIFY_HOLD_LEASE_MS`] — silence for this long releases it. A crashed
//!   WebView, a frozen JS thread or a backgrounded app all stop re-arming, and
//!   the worst case is that much delay on a subsystem whose baseline poll
//!   interval is already [`super::loop_control::DEFAULT_POLL_INTERVAL_MS`].
//! * [`VERIFY_HOLD_MAX_MS`] — an absolute ceiling that renewal cannot push
//!   past, so a screen left open on a desk cannot hold pushes indefinitely.
//! * [`VerifyHold::end`] — the explicit release, on match, on mismatch and on
//!   unmount.
//!
//! A **backward** wall-clock jump reads as lapsed rather than as more time,
//! which closes the one direction where a non-monotonic clock could *extend* a
//! hold. A large forward jump releases early, degrading to the pre-fix
//! behaviour rather than to a stuck one. Both directions fail toward releasing.
//!
//! # Why it is not `SyncLifecycleSignal`
//!
//! The obvious precedent — the mobile foreground/background flag in
//! [`super::loop_control`] — is `#[cfg(all(feature = "tauri-ipc", not(target_arch
//! = "wasm32")))]` and lives in Tauri managed state. The browser cannot see it,
//! and the browser is one of the clients that runs this ceremony
//! (`src/screens/AccountBootstrap.tsx` is the web joiner, and `SyncPanel` is
//! "ported", so a browser can be the *approving* side too). So the shape here is
//! [`super::cycle::sync_cycle_mutex`]'s instead: an ungated process-wide
//! `OnceLock` singleton every client reaches, with the clock injected rather
//! than read, so nothing in this file needs a platform.
//!
//! # Privacy
//!
//! Holding a push only ever **delays** one. Nothing fires earlier than it would
//! have, and the push intent is retained rather than consumed
//! ([`super::loop_control::SyncScheduler::tick`] keeps its `dirty_since`
//! anchor), so no edit is stranded. That is the same extend-only argument
//! `loop_control`'s module doc already makes for the failure-retry gate, and
//! `sync-protocol.md` §8.3 already accepts push arrival and timing as intrinsic
//! (A13). Delaying a push discloses strictly less than sending it.
//!
//! [fp]: protocol::head_fingerprint

use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

/// How long a hold survives without being re-armed.
///
/// The open screen pings about once a second, so this is ~15 missed pings. It
/// has to clear the worst realistic gap between two ticks — a slow
/// `sync_head_fingerprint` on a large vault, a backgrounded mobile WebView
/// catching up — because a hold that flaps lets the head move mid-compare. It
/// also has to stay well under [`VERIFY_HOLD_MAX_MS`] to be the binding limit in
/// the common case.
pub const VERIFY_HOLD_LEASE_MS: u64 = 15_000;

/// Absolute ceiling on one hold, measured from when it was first engaged.
///
/// Renewal extends the lease, never this. A verify screen left open cannot
/// suppress pushes for longer than this no matter how faithfully it pings.
pub const VERIFY_HOLD_MAX_MS: u64 = 300_000;

/// The process-wide device-verification push hold.
///
/// Every method takes the current wall-clock time rather than reading one, so
/// this type is pure, testable without a clock, and free of the
/// `std::time::Instant` that panics on `wasm32-unknown-unknown`.
#[derive(Debug, Default)]
pub struct VerifyHold {
    /// Whether a hold has been engaged at all. Cleared by [`Self::end`]; NOT
    /// cleared by a lapse, because a lapse is a function of time and reading it
    /// must not require a writer.
    engaged: AtomicBool,
    /// When the current hold was first engaged — the anchor
    /// [`VERIFY_HOLD_MAX_MS`] is measured from. Re-arming does not move it.
    engaged_at_ms: AtomicU64,
    /// When the current hold was last re-armed — the anchor
    /// [`VERIFY_HOLD_LEASE_MS`] is measured from.
    renewed_at_ms: AtomicU64,
}

impl VerifyHold {
    /// Engage the hold, or re-arm one that is already engaged.
    ///
    /// **Idempotent, and that is what makes it usable as the lease ping.**
    ///
    /// The subtlety is what a ping does to each of the two bounds, and getting
    /// it wrong makes the ceiling decorative. A ping moves the **lease** and
    /// never the **ceiling**, so:
    ///
    /// * a hold that went quiet and came back (a stalled tick, a briefly
    ///   backgrounded app) resumes under its ORIGINAL ceiling — it cannot buy
    ///   itself a fresh five minutes by falling silent;
    /// * a hold that has reached the ceiling stays finished, and a PING will not
    ///   resurrect it, so a screen left open on a desk does not buy itself
    ///   another five minutes;
    /// * but a NEW ceremony does get its full ceiling, even when the previous
    ///   hold was abandoned without an `end`.
    ///
    /// That last clause is the correction, and the bug it fixes was silent.
    /// Recovery from a spent ceiling used to route exclusively through
    /// [`Self::end`], which is the one call a dead WebView cannot make, and this
    /// module's whole premise (see the module doc) is that the WebView CAN die
    /// without telling anyone. So one abandoned ceremony left `engaged` true with
    /// `engaged_at` pinned to it, and every later `begin` took the renewal branch,
    /// saw the ceiling spent and armed nothing: the hold was disabled for the rest
    /// of the process, with no error and no log, reverting every subsequent
    /// compare to the false-mismatch behaviour this module exists to remove. That
    /// is the only mitigation `threat-model.md` §7 records for the TOFU-bootstrap
    /// hole, so a silent revert is the worst available failure.
    ///
    /// The two cases are told apart by the LEASE rather than by an explicit
    /// release. A live screen pings about once a second, so its lease can never be
    /// fully lapsed when it renews; an abandoned hold minutes old always is.
    ///
    /// Written the other way round, re-engaging whenever `is_held` is false, the
    /// ceiling could never bind at all: a screen pinging once a second would lapse
    /// at the ceiling and re-anchor on the very next ping, forever.
    pub fn begin(&self, now_ms: u64) {
        if self.engaged.load(Ordering::Acquire) {
            let engaged_at = self.engaged_at_ms.load(Ordering::Relaxed);
            // Ceiling spent, or the wall clock moved backwards past the anchor.
            if now_ms < engaged_at || now_ms - engaged_at >= VERIFY_HOLD_MAX_MS {
                let renewed_at = self.renewed_at_ms.load(Ordering::Relaxed);
                let lease_lapsed =
                    now_ms < renewed_at || now_ms - renewed_at >= VERIFY_HOLD_LEASE_MS;
                if !lease_lapsed {
                    // Still being pinged: this is the same ceremony running past
                    // its ceiling, and it stays finished.
                    return;
                }
                // Nobody has pinged for a full lease, so the previous ceremony is
                // gone whether or not anyone said so. This is a new one.
                self.engaged_at_ms.store(now_ms, Ordering::Relaxed);
                self.renewed_at_ms.store(now_ms, Ordering::Relaxed);
                return;
            }
            self.renewed_at_ms.store(now_ms, Ordering::Relaxed);
            return;
        }
        self.engaged_at_ms.store(now_ms, Ordering::Relaxed);
        self.renewed_at_ms.store(now_ms, Ordering::Relaxed);
        self.engaged.store(true, Ordering::Release);
    }

    /// Release the hold now. Idempotent; releasing a hold that was never
    /// engaged is a no-op rather than an error, because the UI calls this on
    /// every unmount path and cannot always know which one ran first.
    pub fn end(&self) {
        self.engaged.store(false, Ordering::Release);
    }

    /// Whether pushes are currently held.
    ///
    /// Both bounds are checked here rather than by a writer, so a hold whose
    /// owner vanished lapses without anyone having to notice.
    pub fn is_held(&self, now_ms: u64) -> bool {
        if !self.engaged.load(Ordering::Acquire) {
            return false;
        }
        let engaged_at = self.engaged_at_ms.load(Ordering::Relaxed);
        let renewed_at = self.renewed_at_ms.load(Ordering::Relaxed);
        // A clock that moved BACKWARDS past either anchor reads as lapsed. The
        // alternative — saturating the subtraction — would treat a backward
        // jump as "no time has passed", which is the one reading that makes a
        // hold outlive its bounds.
        if now_ms < engaged_at || now_ms < renewed_at {
            return false;
        }
        now_ms - renewed_at < VERIFY_HOLD_LEASE_MS && now_ms - engaged_at < VERIFY_HOLD_MAX_MS
    }
}

/// The process-wide hold. One active unlocked vault in Phase 1, so one
/// singleton is a correct serializer — the same reasoning, and the same shape,
/// as [`super::cycle::sync_cycle_mutex`].
pub fn verify_hold() -> &'static VerifyHold {
    static H: OnceLock<VerifyHold> = OnceLock::new();
    H.get_or_init(VerifyHold::default)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh hold holds nothing — the default must be "sync normally", so a
    /// client that never learned about this feature is unaffected.
    #[test]
    fn a_fresh_hold_is_not_held() {
        let h = VerifyHold::default();
        assert!(!h.is_held(0));
        assert!(!h.is_held(1_000_000));
    }

    #[test]
    fn begin_holds_and_end_releases_immediately() {
        let h = VerifyHold::default();
        h.begin(1_000);
        assert!(h.is_held(1_000));
        assert!(h.is_held(1_000 + VERIFY_HOLD_LEASE_MS - 1));
        h.end();
        assert!(!h.is_held(1_000));
    }

    /// The crash case: the screen stops pinging and the hold clears itself.
    /// Without this the fix would trade a noisy compare for silently-unsynced
    /// notes.
    #[test]
    fn lapses_after_the_lease_without_renewal() {
        let h = VerifyHold::default();
        h.begin(1_000);
        assert!(h.is_held(1_000 + VERIFY_HOLD_LEASE_MS - 1));
        assert!(!h.is_held(1_000 + VERIFY_HOLD_LEASE_MS));
    }

    #[test]
    fn renewal_extends_the_lease() {
        let h = VerifyHold::default();
        h.begin(0);
        // One ping just before the lease would have run out.
        h.begin(VERIFY_HOLD_LEASE_MS - 1);
        assert!(h.is_held(VERIFY_HOLD_LEASE_MS + 1));
        assert!(h.is_held(2 * VERIFY_HOLD_LEASE_MS - 2));
        assert!(!h.is_held(2 * VERIFY_HOLD_LEASE_MS - 1));
    }

    /// Renewal moves the lease, never the ceiling. A screen cannot hold pushes
    /// forever by pinging faithfully.
    #[test]
    fn renewal_cannot_push_past_the_hard_ceiling() {
        let h = VerifyHold::default();
        h.begin(0);
        // Ping every second for well past the ceiling.
        let mut t = 0;
        while t < VERIFY_HOLD_MAX_MS + 10_000 {
            t += 1_000;
            h.begin(t);
        }
        // Still "engaged" as a flag, but the ceiling has bound it.
        assert!(!h.is_held(VERIFY_HOLD_MAX_MS));
        assert!(!h.is_held(VERIFY_HOLD_MAX_MS + 10_000));
    }

    /// `now_unix_millis` is wall-clock, not monotonic. A jump BACKWARDS must
    /// read as lapsed — the one direction where the alternative (a saturating
    /// subtraction, i.e. "no time has passed") would let a hold outlive both of
    /// its bounds.
    #[test]
    fn a_backward_clock_jump_lapses_rather_than_extending() {
        let h = VerifyHold::default();
        h.begin(1_000_000);
        assert!(h.is_held(1_000_000));
        assert!(!h.is_held(999_999));
    }

    /// A large forward jump releases early. That degrades to the pre-fix
    /// behaviour (the head can move again), never to a stuck hold.
    #[test]
    fn a_forward_clock_jump_releases_rather_than_sticking() {
        let h = VerifyHold::default();
        h.begin(1_000);
        assert!(!h.is_held(1_000 + VERIFY_HOLD_MAX_MS * 10));
    }

    /// A ping after a LEASE lapse resumes the hold — the screen is evidently
    /// still open, and refusing would strand the ceremony. But it resumes under
    /// the ORIGINAL ceiling: going quiet must not buy a fresh five minutes.
    #[test]
    fn a_ping_after_a_lease_lapse_resumes_under_the_original_ceiling() {
        let h = VerifyHold::default();
        h.begin(0);
        let lapsed = VERIFY_HOLD_LEASE_MS + 1;
        assert!(!h.is_held(lapsed));
        h.begin(lapsed);
        assert!(h.is_held(lapsed));
        // The ceiling is still measured from 0, not from the re-arm.
        assert!(!h.is_held(VERIFY_HOLD_MAX_MS));
    }

    /// A ping after the CEILING is spent does not resurrect the hold. This is
    /// the difference between a ceiling and a suggestion: a screen pinging once
    /// a second must not be able to re-anchor itself forever.
    #[test]
    fn a_ping_after_the_ceiling_does_not_resurrect_the_hold() {
        // A LIVE screen, which is what "a ping" means: it renews about once a
        // second, so its lease is never fully lapsed. That is what distinguishes
        // it from an abandoned hold, and it is why the ceiling still binds
        // against a screen somebody left open on a desk.
        //
        // The previous version of this test jumped from 0 straight to the
        // ceiling with no pings in between, which is indistinguishable from
        // abandonment, and pinned the behaviour that produced the lockout below.
        let h = VerifyHold::default();
        h.begin(0);
        let mut t = 0;
        while t < VERIFY_HOLD_MAX_MS {
            t += VERIFY_HOLD_LEASE_MS / 3;
            h.begin(t);
        }
        let spent = VERIFY_HOLD_MAX_MS + 1;
        assert!(!h.is_held(spent), "the ceiling binds against a live screen");
        h.begin(spent);
        assert!(
            !h.is_held(spent),
            "and pinging does not buy another ceiling"
        );

        // An explicit release followed by a fresh arm starts over.
        h.end();
        h.begin(spent);
        assert!(h.is_held(spent));
    }

    /// A new ceremony after an ABANDONED one gets its full ceiling, with no
    /// `end` in between.
    ///
    /// This is the case the lockout broke, and it is the one that matters most:
    /// recovery from a spent ceiling used to route only through `end`, which is
    /// the one call a dead WebView cannot make, and this module exists because
    /// the WebView can die without telling anyone. One abandoned ceremony
    /// therefore disabled the hold for the rest of the process, silently,
    /// reverting every later compare to the false-mismatch behaviour that
    /// `threat-model.md` §7 names as the only TOFU-bootstrap mitigation.
    #[test]
    fn a_new_ceremony_after_an_abandoned_one_gets_its_own_ceiling() {
        let h = VerifyHold::default();
        h.begin(0);
        // The screen dies. Nobody pings, nobody calls `end`.
        let much_later = VERIFY_HOLD_MAX_MS * 3;
        assert!(!h.is_held(much_later));

        // A new ceremony opens.
        h.begin(much_later);
        assert!(h.is_held(much_later), "a new ceremony must arm");

        // And it gets its FULL ceiling rather than the remains of the abandoned
        // one. Pinged the way a live screen pings, because `is_held` wants both
        // a fresh lease and an unspent ceiling: a hold nobody renews lapses on
        // the lease first, which is the whole point of the lease.
        let mut t = much_later;
        while t < much_later + VERIFY_HOLD_MAX_MS - VERIFY_HOLD_LEASE_MS {
            t += VERIFY_HOLD_LEASE_MS / 3;
            h.begin(t);
            assert!(h.is_held(t), "still inside the new ceremony's own ceiling");
        }
        assert!(
            !h.is_held(much_later + VERIFY_HOLD_MAX_MS),
            "which still ends at its own ceiling"
        );
    }

    /// `end` before `begin` is not an error: the UI releases on every unmount
    /// path and cannot always know which one ran first.
    #[test]
    fn end_without_begin_is_a_no_op() {
        let h = VerifyHold::default();
        h.end();
        assert!(!h.is_held(0));
        h.begin(500);
        assert!(h.is_held(500));
    }

    #[test]
    fn the_singleton_is_stable_across_calls() {
        assert!(core::ptr::eq(verify_hold(), verify_hold()));
    }
}
