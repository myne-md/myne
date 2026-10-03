//! Rolling per-source silence detection for a meeting session
//! (myne-md/myne#789).
//!
//! A CoreAudio process tap created without the system-audio recording
//! permission still delivers buffers, **zeroed**. There is no public API to
//! preflight or request that permission, so from inside the process a denied
//! tap is indistinguishable from a silent one, and the failure mode is the
//! worst kind: the session runs, the transcript is produced, and it quietly
//! contains only the user's own voice.
//!
//! The existing save-time guard is the wrong instrument for this. `is_silent`
//! is evaluated once, when the recording stops, which is after the meeting is
//! over; and it asks whether the WHOLE mix was silent, which a live microphone
//! never is. What a meeting needs is a per-source question asked continuously:
//! **is the system-audio side silent while the microphone side is live?**
//!
//! That asymmetry is the whole discriminator. A quiet user is normal. A quiet
//! meeting is normal. A quiet tap while the user is talking is a permission
//! problem, and it is the one combination that fires.
//!
//! This is a pure state machine over `(now, mic_peak, tap_peak)` triples, with
//! no clock and no I/O of its own, so it is fully testable without a device or
//! a session. The caller owns the clock.

use std::time::{Duration, Instant};

use super::capture::SILENCE_PEAK_THRESHOLD;

/// How long the system-audio side must stay silent, while the microphone side
/// is live, before the session warns.
///
/// Twenty seconds is chosen against the two errors. Too short and a pause in
/// the meeting fires a warning the user learns to ignore; too long and the user
/// records most of a meeting before learning the other side was never captured.
/// Twenty seconds is also comfortably longer than any natural gap between
/// sentences in a live conversation, so it does not fire on speech cadence.
pub const DEFAULT_TAP_SILENCE_WINDOW: Duration = Duration::from_secs(20);

/// Rolling detector over one session's per-source levels.
///
/// Fires at most once per run of silence: a warning the user has already seen
/// is not made more useful by being repeated every poll, and re-arming on the
/// first live tap sample means a genuinely recovered permission is not
/// re-warned about.
pub struct SilenceWatch {
    window: Duration,
    /// When the current run of tap silence began, if the microphone was already
    /// live at that moment.
    silent_since: Option<Instant>,
    /// Whether any microphone sample above the threshold has arrived. Without
    /// this the detector would fire on a meeting that has not started.
    mic_live: bool,
    /// Whether the warning has already fired for the current run.
    fired: bool,
}

impl SilenceWatch {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            silent_since: None,
            mic_live: false,
            fired: false,
        }
    }

    /// Feed one poll. `tap_peak` is `None` when this session has no
    /// system-audio source at all (Linux, or macOS below 14.2), in which case
    /// there is nothing to warn about: the UI has already said the other side
    /// will not be captured, and warning that it is not being captured would be
    /// a second, louder way of saying the same thing.
    ///
    /// Returns `true` exactly once per run of tap silence, at the moment the
    /// window elapses.
    pub fn observe(&mut self, now: Instant, mic_peak: f32, tap_peak: Option<f32>) -> bool {
        let tap_peak = match tap_peak {
            Some(p) => p,
            None => return false,
        };
        if mic_peak >= threshold() {
            self.mic_live = true;
        }
        if tap_peak >= threshold() {
            // The other side is audible: re-arm rather than staying latched, so
            // a permission the user grants mid-meeting stops the warning from
            // coming back on the next quiet patch.
            self.silent_since = None;
            self.fired = false;
            return false;
        }
        // The tap is silent. Start the clock only once the user has actually
        // spoken, because until then a silent tap is indistinguishable from a
        // meeting that has not begun.
        if !self.mic_live {
            return false;
        }
        let since = match self.silent_since {
            Some(s) => s,
            None => {
                self.silent_since = Some(now);
                return false;
            }
        };
        if self.fired || now.duration_since(since) < self.window {
            return false;
        }
        self.fired = true;
        true
    }
}

/// The peak level, in `[0, 1]`, at or above which a source counts as live.
/// Derived from the sample threshold rather than restated, so the two cannot
/// drift into disagreeing about what silence is.
fn threshold() -> f32 {
    f32::from(SILENCE_PEAK_THRESHOLD) / f32::from(i16::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> SilenceWatch {
        SilenceWatch::new(Duration::from_secs(20))
    }

    const LIVE: f32 = 0.3;
    const QUIET: f32 = 0.0;

    #[test]
    fn a_live_tap_never_warns() {
        let mut w = watch();
        let t0 = Instant::now();
        for i in 0..100 {
            assert!(!w.observe(t0 + Duration::from_secs(i), LIVE, Some(LIVE)));
        }
    }

    #[test]
    fn a_silent_tap_while_the_user_talks_warns_after_the_window() {
        let mut w = watch();
        let t0 = Instant::now();
        // The user speaks immediately, the tap is dead.
        assert!(!w.observe(t0, LIVE, Some(QUIET)));
        assert!(!w.observe(t0 + Duration::from_secs(19), LIVE, Some(QUIET)));
        assert!(
            w.observe(t0 + Duration::from_secs(20), LIVE, Some(QUIET)),
            "the warning fires once the window elapses"
        );
    }

    #[test]
    fn the_warning_fires_once_per_run_of_silence() {
        let mut w = watch();
        let t0 = Instant::now();
        assert!(!w.observe(t0, LIVE, Some(QUIET)));
        assert!(w.observe(t0 + Duration::from_secs(20), LIVE, Some(QUIET)));
        // Still silent, twenty more seconds: no second warning.
        assert!(!w.observe(t0 + Duration::from_secs(40), LIVE, Some(QUIET)));
    }

    #[test]
    fn a_recovered_tap_re_arms_the_warning() {
        let mut w = watch();
        let t0 = Instant::now();
        assert!(!w.observe(t0, LIVE, Some(QUIET)));
        assert!(w.observe(t0 + Duration::from_secs(20), LIVE, Some(QUIET)));
        // The user grants the permission mid-meeting.
        assert!(!w.observe(t0 + Duration::from_secs(21), LIVE, Some(LIVE)));
        // It goes quiet again later, which is a new run and warns again.
        let t1 = t0 + Duration::from_secs(30);
        assert!(!w.observe(t1, LIVE, Some(QUIET)));
        assert!(w.observe(t1 + Duration::from_secs(20), LIVE, Some(QUIET)));
    }

    #[test]
    fn a_quiet_meeting_does_not_warn() {
        // Nobody has spoken: a silent tap is indistinguishable from a meeting
        // that has not started, and warning here would be a false positive on
        // every session that begins with small talk before the call connects.
        let mut w = watch();
        let t0 = Instant::now();
        for i in 0..60 {
            assert!(
                !w.observe(t0 + Duration::from_secs(i), QUIET, Some(QUIET)),
                "a fully quiet session must not warn"
            );
        }
    }

    #[test]
    fn the_clock_starts_when_the_user_first_speaks_not_at_session_start() {
        let mut w = watch();
        let t0 = Instant::now();
        // Ten minutes of silence before anyone speaks.
        assert!(!w.observe(t0, QUIET, Some(QUIET)));
        assert!(!w.observe(t0 + Duration::from_secs(600), QUIET, Some(QUIET)));
        // The user speaks; the window runs from here.
        let spoken = t0 + Duration::from_secs(600);
        assert!(!w.observe(spoken, LIVE, Some(QUIET)));
        assert!(!w.observe(spoken + Duration::from_secs(19), LIVE, Some(QUIET)));
        assert!(w.observe(spoken + Duration::from_secs(20), LIVE, Some(QUIET)));
    }

    #[test]
    fn a_session_with_no_tap_never_warns() {
        // Linux, or macOS below 14.2. The UI already states the limitation; a
        // warning would be a louder second copy of it.
        let mut w = watch();
        let t0 = Instant::now();
        for i in 0..60 {
            assert!(!w.observe(t0 + Duration::from_secs(i), LIVE, None));
        }
    }

    #[test]
    fn a_new_session_starts_fresh() {
        // The session builds a new watch per start rather than resetting one,
        // so a previous session's state cannot carry over. This asserts the
        // property that makes that safe: a fresh watch behaves as if the
        // microphone had never been live.
        let mut first = watch();
        let t0 = Instant::now();
        assert!(!first.observe(t0, LIVE, Some(QUIET)));
        assert!(first.observe(t0 + Duration::from_secs(20), LIVE, Some(QUIET)));

        let mut second = watch();
        let t1 = t0 + Duration::from_secs(100);
        assert!(
            !second.observe(t1, QUIET, Some(QUIET)),
            "a fresh watch has not seen the microphone live yet"
        );
        assert!(!second.observe(t1 + Duration::from_secs(1), LIVE, Some(QUIET)));
        assert!(second.observe(t1 + Duration::from_secs(21), LIVE, Some(QUIET)));
    }

    #[test]
    fn the_threshold_is_derived_from_the_sample_threshold() {
        // A guard against the two drifting apart: the level threshold is the
        // sample threshold expressed as a fraction of full scale, so a change
        // to one moves the other.
        assert!((threshold() - 64.0 / 32767.0).abs() < 1e-9);
    }
}
