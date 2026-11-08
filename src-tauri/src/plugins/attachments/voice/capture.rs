// SPDX-License-Identifier: AGPL-3.0
//! Microphone capture for voice notes (MYND-259).
//!
//! Native Rust capture via `cpal`, NOT the WebView's MediaRecorder: captured
//! PCM stays Rust-side where it is `Zeroize`-able and never enters the JS heap,
//! the codec is consistent across all three OS WebViews, and the unreliable
//! WebKitGTK MediaRecorder path is avoided (`decisions.md` voice-notes entry).
//!
//! The capture pipeline is a chain of swappable stages so the record flow is
//! testable on a headless runner (no mic): the [`AudioSource`] seam has a real
//! [`CpalSource`] and a deterministic [`FixtureSource`]; the WAV [`Encoder`]
//! (`super::encoder`) is the sibling seam for a future Opus swap.
//!
//! The in-progress recording is buffered in RAM only (`Zeroizing<Vec<i16>>`) —
//! NEVER a plaintext temp `.wav` on disk, which would trip the MYND-171
//! stray-file scan. It is bounded per-clip by the 64 MiB `MYA1` cap; at the cap
//! the full clip is flushed (`drain_full_clips`) and capture continues
//! seamlessly into the next clip with no dropped samples (the cpal callback
//! keeps filling its shared buffer across the cheap split).

use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

use super::encoder::WAV_HEADER_LEN;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// The per-clip sample ceiling, derived from the 64 MiB `MYA1` blob cap minus
/// the WAV header, at 2 bytes/sample. At this boundary the current clip is
/// flushed and capture continues into a new clip (seamless continuation, not a
/// hard stop).
pub const MAX_SAMPLES: usize = (protocol::MAX_ATTACHMENT_LEN - WAV_HEADER_LEN) / 2;

/// Sample rate the transcription front end resamples to, and the ceiling on the
/// samples it will materialize there.
///
/// Duplicated from `local_inference::audio` on purpose: that module is behind
/// the `local-inference` feature and this one is not, so a direct reference
/// would make the recorder's clip boundary depend on whether the AI build was
/// selected. The two are held together by a compile-time assertion and a test in
/// `audio.rs`, which is the half that can see both.
const TRANSCRIPTION_SAMPLE_RATE_HZ: u32 = 16_000;
const TRANSCRIPTION_CEILING_SAMPLES: usize = protocol::MAX_ATTACHMENT_LEN / 2;

/// Accessors so `local_inference::audio` can assert, at compile time, that the
/// two copies agree. `const fn` rather than `pub const` to keep the values
/// themselves private to this module.
///
/// Gated on the FEATURE, not on `cfg(test)`. Their only caller is a pair of
/// `const _: () = assert!(...)` in `local_inference::audio`, which compiles only
/// with `local-inference` on, so exported unconditionally they are dead code in
/// a `--no-default-features` build and `-D warnings` refuses it. That is not
/// hypothetical: `cargo clippy -p myne-desktop --all-targets
/// --no-default-features -- -D warnings` failed on exactly this, and the
/// existing AI-free gate missed it because it runs `cargo check` without
/// `--all-targets` and so never compiles test code. Gating on the feature also
/// lets the assertions leave the test module, so the two copies are compared on
/// every default build rather than only under `cargo test`.
#[cfg(feature = "local-inference")]
pub const fn transcription_sample_rate_hz() -> u32 {
    TRANSCRIPTION_SAMPLE_RATE_HZ
}
#[cfg(feature = "local-inference")]
pub const fn transcription_ceiling_samples() -> usize {
    TRANSCRIPTION_CEILING_SAMPLES
}

/// The per-clip sample ceiling at `sample_rate`: the tighter of the § 9.9 blob
/// cap and what transcription will accept.
///
/// [`MAX_SAMPLES`] is that blob cap expressed in samples, and a sample count is
/// not a duration. At 48 kHz it is 11 min 39 s; at 8 kHz the same number of
/// samples is 69 min 54 s. Transcription bounds the other axis: it refuses a
/// clip whose projection to 16 kHz passes `TRANSCRIPTION_CEILING_SAMPLES`, which
/// is a flat 34 min 57 s of audio at any declared rate.
///
/// The two agree at or above 16 kHz, where the resample contracts and the blob
/// cap binds first. Below it the resample EXPANDS, so `MAX_SAMPLES` frames at
/// 8 kHz project to twice the transcription ceiling and the recorder would emit
/// a clip its own decoder then refuses, permanently, with a message the user
/// cannot act on. That rate is reachable: `CpalSource::start` takes whatever
/// `default_input_config()` reports, and Bluetooth HFP/SCO is 8 kHz on all three
/// desktop platforms (myne-md/myne#510).
///
/// Taking the tighter bound costs nothing the user sees. The boundary is a
/// seamless flush, not a stop, so a low-rate recording becomes more clips rather
/// than a shorter one.
pub fn max_samples_for_rate(sample_rate: u32) -> usize {
    if sample_rate == 0 {
        // Unreachable through `CpalSource` (cpal never reports zero) and the
        // fixture source is fixed at 48 kHz, but a zero here would compute a
        // boundary of zero and `drain_full_clips` would emit empty clips
        // forever. Fall back to the cap that does not divide.
        return MAX_SAMPLES;
    }
    // `ceil(f * 16000 / rate) <= CEILING` iff `f * 16000 <= CEILING * rate`, so
    // the largest admissible frame count is the floor of that quotient. u64
    // because the product exceeds u32 at every real rate.
    let transcribable = ((TRANSCRIPTION_CEILING_SAMPLES as u64) * (sample_rate as u64)
        / (TRANSCRIPTION_SAMPLE_RATE_HZ as u64)) as usize;
    transcribable.min(MAX_SAMPLES)
}

/// How often the session loop drains the source and checks for a stop signal.
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// A capture failure that is not the user's fault. Kept coarse — device error
/// detail is neither security-sensitive nor actionable to the UI beyond the
/// "no input device" case (which drives the disabled-record affordance).
#[derive(Debug, Clone, Copy)]
pub enum RecordError {
    /// No input device is available (or mic access is unavailable).
    NoInputDevice,
    /// The capture device/stream could not be configured, built, or started,
    /// or uses an unsupported sample format.
    CaptureFailed,
    /// The input device reports a sample rate outside the window `parse_wav`
    /// accepts, so a clip recorded at it would be refused by this application's
    /// own decoder. Distinct from `CaptureFailed` because nothing failed: the
    /// device works and the rate is the problem, which is what a user needs to
    /// be told.
    ///
    /// A unit variant rather than one carrying the rate: the rate is logged at
    /// the refusal site, where a bug report picks it up, and threading it to the
    /// frontend would change the serialized error shape for a number the UI has
    /// no copy to render. A field nothing reads is a `dead_code` error under
    /// `-D warnings` in both build configurations, which is how this was found.
    UnsupportedSampleRate,
}

/// Finalized mono PCM from one recording session. `samples` is `Zeroizing` so
/// the captured plaintext audio is wiped when the session result is dropped.
pub struct CapturedAudio {
    pub samples: Zeroizing<Vec<i16>>,
    pub sample_rate: u32,
}

/// How a session ends.
#[derive(Debug, Clone, Copy)]
pub enum StopKind {
    /// Keep the recording → finalize + encode + import.
    Finalize,
    /// Discard the recording → wipe the buffer, create nothing.
    Cancel,
}

/// The outcome the capture thread sends back when it stops.
pub enum SessionResult {
    Captured(CapturedAudio),
    Canceled,
    Error(RecordError),
}

/// A pull-based mono-i16 capture source. Not `Send` — `CpalSource` owns a cpal
/// `Stream` which is `!Send` on macOS CoreAudio, so a source is always built
/// and used inside the capture thread, never moved across threads.
pub trait AudioSource {
    /// The native capture sample rate (Hz).
    fn sample_rate(&self) -> u32;
    /// Drain the mono i16 samples captured since the last poll (empty if none
    /// ready yet).
    fn poll(&mut self) -> Vec<i16>;
    /// Peak level of the SYSTEM-AUDIO half of this source on the most recent
    /// `poll`, in `[0, 1]`, or `None` when the source has no such half.
    ///
    /// The meeting session's silence warning is driven by this rather than by
    /// the mixed level, because a denied CoreAudio tap delivers zeroed buffers
    /// rather than an error: a quiet microphone is normal, a quiet tap while
    /// the user is talking is a permission problem, and only a per-source
    /// answer can tell those apart. A microphone-only source (the voice-note
    /// flow, and a meeting on a platform with no tap) answers `None`.
    fn tap_level(&self) -> Option<f32> {
        None
    }
}

/// Which source the capture thread builds. `Send` (unlike the source itself),
/// so it can cross into the spawned thread which then builds the source.
#[derive(Debug, Clone, Copy)]
pub enum SourceFactory {
    /// Real microphone via cpal.
    ///
    /// Unconstructed under `voice-capture-stub` — that build exists precisely
    /// so no code path reaches a real device. The allow is scoped to this
    /// variant rather than the module, so genuine dead code elsewhere in the
    /// file still fails the build under the stub feature (the
    /// `local-inference-stub` precedent puts its allow at module scope and
    /// loses that).
    #[cfg_attr(feature = "voice-capture-stub", allow(dead_code))]
    Cpal,
    /// Deterministic synthetic tone — for E2E on a headless runner + tests.
    ///
    /// Gated (myne#389 item D). The defect this closes was not "an env var
    /// existed" but "a synthetic-audio source was selectable in a shipped
    /// binary": gate only the selector and this variant survives as a `pub`
    /// item one `if` away from being re-wired by somebody reading `capture.rs`
    /// and not the issue. Gated, re-introducing it does not compile.
    ///
    /// The `test` disjunct keeps the four unit tests below running under a
    /// plain `cargo test`, so the gate costs no test coverage — strictly
    /// cleaner than the `local-inference-stub` precedent, which leans on
    /// `#![cfg_attr(…, allow(dead_code))]` because it could not use `test`.
    #[cfg(any(test, feature = "voice-capture-stub"))]
    Fixture,
    /// The same synthetic tone at a STATED rate, for the tests that exercise
    /// the per-rate clip clamp. `Fixture` is fixed at 48 kHz, where that clamp
    /// is `MAX_SAMPLES` and therefore invisible.
    #[cfg(test)]
    FixtureAt(u32),
    /// A meeting session (myne-md/myne#789): the microphone mixed with the
    /// system-audio tap where this platform can supply one. Never selected by
    /// the voice-note flow, which stays microphone-only.
    ///
    /// The tap is optional rather than required, and that is the platform
    /// matrix rather than a degradation: on Linux, and on macOS below 14.2,
    /// there is no system-audio capture path to build, and the session runs on
    /// the microphone alone with the UI saying so.
    Meeting,
}

impl SourceFactory {
    fn build(self) -> Result<Box<dyn AudioSource>, RecordError> {
        match self {
            SourceFactory::Cpal => Ok(Box::new(CpalSource::start()?)),
            #[cfg(any(test, feature = "voice-capture-stub"))]
            SourceFactory::Fixture => Ok(Box::new(FixtureSource::default())),
            #[cfg(test)]
            SourceFactory::FixtureAt(rate) => Ok(Box::new(FixtureSource::at_rate(rate))),
            SourceFactory::Meeting => {
                #[cfg(feature = "voice-capture-stub")]
                let mic: Box<dyn AudioSource> = Box::new(FixtureSource::default());
                #[cfg(not(feature = "voice-capture-stub"))]
                let mic: Box<dyn AudioSource> = Box::new(CpalSource::start()?);
                Ok(super::mix::build_meeting_mix(mic, meeting_tap_source()))
            }
        }
    }
}

/// The system-audio half of a meeting mix, where this platform can supply one.
///
/// `None` is a supported answer, not a failure: Linux has no app-facing
/// system-audio capture path short of the desktop portal, and macOS only grew
/// the CoreAudio process tap in 14.2. The session still runs in both cases, on
/// the microphone alone, and the UI states the limitation before the session
/// starts rather than after.
///
/// The stub build returns a second fixture at a DIFFERENT rate from the
/// microphone's, so the E2E drives the mix and the resampler with no device.
#[cfg(all(feature = "voice-capture-stub", not(test)))]
fn meeting_tap_source() -> Option<Box<dyn AudioSource>> {
    Some(Box::new(FixtureSource::at_rate(44_100)))
}

#[cfg(all(target_os = "macos", not(feature = "voice-capture-stub"), not(test)))]
fn meeting_tap_source() -> Option<Box<dyn AudioSource>> {
    // A refused tap is not a refused session: the microphone is still a valid
    // meeting, and the UI has already said the other side will not be captured.
    super::tap::TapSource::start()
        .ok()
        .map(|t| Box::new(t) as Box<dyn AudioSource>)
}

#[cfg(all(
    not(target_os = "macos"),
    not(feature = "voice-capture-stub"),
    not(test)
))]
fn meeting_tap_source() -> Option<Box<dyn AudioSource>> {
    // Linux has no app-facing system-audio capture path short of the desktop
    // portal, which is separate work. This is the stated platform matrix.
    None
}

/// Whether a meeting session on this build can arm a system-audio source.
///
/// The UI's platform notice renders only where this is false, so it must answer
/// the same question `meeting_tap_source` does rather than a nearby one: on the
/// stub build there is no real tap, and below macOS 14.2 there is no API.
#[cfg(all(target_os = "macos", not(feature = "voice-capture-stub")))]
pub fn meeting_tap_available() -> bool {
    super::tap::is_available()
}

#[cfg(not(all(target_os = "macos", not(feature = "voice-capture-stub"))))]
pub fn meeting_tap_available() -> bool {
    false
}

/// Under `cargo test` the tap is never reached: a unit test that built a real
/// aggregate device would open the microphone and ask for a permission prompt
/// on a developer's machine. The mix itself is exercised by `mix.rs`, and the
/// macOS path by the manual-test roster entry.
#[cfg(test)]
fn meeting_tap_source() -> Option<Box<dyn AudioSource>> {
    None
}

// --- fixture source (tests / E2E) ------------------------------------------

/// A deterministic 440 Hz sine source. Drives the record flow with no real
/// device so the E2E (record→save→reopen→playback) runs on a headless runner.
///
/// Absent from the shipped binary — see [`SourceFactory::Fixture`] for why the
/// generator is gated and not just its selector.
#[cfg(any(test, feature = "voice-capture-stub"))]
pub struct FixtureSource {
    sample_rate: u32,
    phase: f32,
    step: f32,
    samples_per_poll: usize,
}

#[cfg(any(test, feature = "voice-capture-stub"))]
impl FixtureSource {
    /// The default tone at a stated sample rate, so a test can drive the
    /// per-rate clip clamp in `run_session`, and so the meeting mix has a
    /// second source at a rate that differs from the microphone's (the E2E
    /// build's stand-in for the tap). Only the rate moves: the poll size stays
    /// at 480 samples so the clamp is reached in a bounded number of polls
    /// whatever the rate says.
    pub(super) fn at_rate(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            ..Self::default()
        }
    }
}

#[cfg(any(test, feature = "voice-capture-stub"))]
impl Default for FixtureSource {
    fn default() -> Self {
        let sample_rate = 48_000;
        let freq = 440.0_f32;
        Self {
            sample_rate,
            phase: 0.0,
            step: std::f32::consts::TAU * freq / sample_rate as f32,
            // ~10 ms of audio per poll, matching POLL_INTERVAL.
            samples_per_poll: 480,
        }
    }
}

#[cfg(any(test, feature = "voice-capture-stub"))]
impl AudioSource for FixtureSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn poll(&mut self) -> Vec<i16> {
        let mut out = Vec::with_capacity(self.samples_per_poll);
        for _ in 0..self.samples_per_poll {
            let amplitude = (self.phase.sin() * 0.5 * f32::from(i16::MAX)) as i16;
            out.push(amplitude);
            self.phase += self.step;
            if self.phase > std::f32::consts::TAU {
                self.phase -= std::f32::consts::TAU;
            }
        }
        out
    }
}

// --- cpal source (real microphone) -----------------------------------------

/// A real microphone source. The cpal data callback downmixes every frame to
/// one mono i16 and pushes into a shared buffer that [`poll`](AudioSource::poll)
/// drains. The `Stream` is held here and only ever exists inside the capture
/// thread.
pub struct CpalSource {
    _stream: cpal::Stream,
    shared: Arc<Mutex<Vec<i16>>>,
    sample_rate: u32,
}

impl CpalSource {
    fn start() -> Result<Self, RecordError> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or(RecordError::NoInputDevice)?;
        let supported = device
            .default_input_config()
            .map_err(|_| RecordError::CaptureFailed)?;
        let sample_rate = supported.sample_rate().0;
        // The clip LENGTH is bounded by `max_samples_for_rate`; the RATE was not
        // bounded at all, and the invariant both `myne-agents/docs/threat-model.md` and
        // decision 0541 state as a construction ("no clip a Myne client records
        // is refused by a Myne decoder") holds only inside the decoder's window.
        // `parse_wav` refuses anything outside `MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ`,
        // and `default_input_config()` is whatever the OS reports, so a device
        // outside that window produced a clip its own decoder would reject.
        //
        // Refusing here rather than clamping is deliberate: clamping would either
        // mislabel the rate, which corrupts playback, or resample at capture time,
        // which is the decoder's job and would silently change what was recorded.
        // The bound is IMPORTED from the decoder rather than restated, so the two
        // cannot drift into disagreeing about the same window.
        if !(crate::audio_rate::MIN_SAMPLE_RATE_HZ..=crate::audio_rate::MAX_SAMPLE_RATE_HZ)
            .contains(&sample_rate)
        {
            tracing::warn!(
                sample_rate,
                min = crate::audio_rate::MIN_SAMPLE_RATE_HZ,
                max = crate::audio_rate::MAX_SAMPLE_RATE_HZ,
                "input device reports a sample rate outside the decodable window; refusing to record"
            );
            return Err(RecordError::UnsupportedSampleRate);
        }
        let channels = supported.channels();
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.config();

        let shared: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
        let err_cb = |_err| {
            // The error type may carry platform path detail; log a static label
            // only (DENY-list discipline — see ../../AGENTS.md).
            tracing::warn!(stage = "voice_capture", "cpal input stream error");
        };

        let stream = match sample_format {
            cpal::SampleFormat::F32 => {
                let sink = shared.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[f32], _| push_mono(&sink, data, channels, f32_to_i16),
                    err_cb,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let sink = shared.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[i16], _| push_mono(&sink, data, channels, |s| s),
                    err_cb,
                    None,
                )
            }
            cpal::SampleFormat::U16 => {
                let sink = shared.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[u16], _| push_mono(&sink, data, channels, u16_to_i16),
                    err_cb,
                    None,
                )
            }
            _ => return Err(RecordError::CaptureFailed),
        }
        .map_err(|_| RecordError::CaptureFailed)?;

        stream.play().map_err(|_| RecordError::CaptureFailed)?;
        Ok(Self {
            _stream: stream,
            shared,
            sample_rate,
        })
    }
}

impl AudioSource for CpalSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn poll(&mut self) -> Vec<i16> {
        // `append` moves the samples out while leaving the producer's buffer
        // with its CAPACITY intact. `mem::take` replaced it with a fresh empty
        // `Vec`, so the cpal callback re-allocated on its next buffer; the
        // capture poll runs at ~100 Hz per source, and the callback for a real
        // device is on an audio thread that must not allocate.
        let mut out = Vec::new();
        if let Ok(mut g) = self.shared.lock() {
            out.append(&mut g);
        }
        out
    }
}

fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16
}

fn u16_to_i16(s: u16) -> i16 {
    (i32::from(s) - 32_768) as i16
}

/// Downmix interleaved `data` (`channels` per frame) to one mono i16 per frame
/// (average of the frame's channels) and append to `sink`.
fn push_mono<T: Copy>(
    sink: &Arc<Mutex<Vec<i16>>>,
    data: &[T],
    channels: u16,
    to_i16: fn(T) -> i16,
) {
    let ch = channels.max(1) as usize;
    let Ok(mut buf) = sink.lock() else { return };
    for frame in data.chunks(ch) {
        let sum: i32 = frame.iter().map(|&s| i32::from(to_i16(s))).sum();
        let mono = (sum / frame.len() as i32) as i16;
        buf.push(mono);
    }
}

// --- session driver --------------------------------------------------------

/// Run one capture session to completion on the calling (dedicated) thread.
/// Builds the source, then polls it on [`POLL_INTERVAL`] — appending mono i16
/// into a `Zeroizing` buffer bounded by [`MAX_SAMPLES`] — until a stop signal
/// arrives. `Finalize` returns the captured audio; `Cancel` (or a dropped
/// sender) wipes the buffer and returns `Canceled`.
pub fn run_session(
    factory: SourceFactory,
    stop_rx: &Receiver<StopKind>,
    level_sink: &(dyn Fn(f32, Option<f32>) + Send),
    clip_sink: &(dyn Fn(Zeroizing<Vec<i16>>, u32) + Send),
    max_samples: usize,
) -> SessionResult {
    let mut source = match factory.build() {
        Ok(s) => s,
        Err(e) => return SessionResult::Error(e),
    };
    let sample_rate = source.sample_rate();
    // The caller passes the § 9.9 blob cap; the rate is only knowable here,
    // after the source is built, so the transcription half of the boundary is
    // applied at this point. See `max_samples_for_rate`.
    let max_samples = max_samples_for_rate(sample_rate).min(max_samples);
    let mut buffer: Zeroizing<Vec<i16>> = Zeroizing::new(Vec::new());

    loop {
        match stop_rx.try_recv() {
            Ok(StopKind::Finalize) => break,
            Ok(StopKind::Cancel) | Err(TryRecvError::Disconnected) => {
                // Zeroizing drops here → in-flight tail wiped.
                return SessionResult::Canceled;
            }
            Err(TryRecvError::Empty) => {}
        }
        let chunk = source.poll();
        // Stream the input level so the meter moves — and so macOS's
        // denial-as-silence surfaces as a flat meter, not a silent success.
        // The second value is the system-audio side's own peak where the source
        // has one, which is what the meeting session's silence warning watches.
        level_sink(peak_level(&chunk), source.tap_level());
        buffer.extend_from_slice(&chunk);
        // Seamless continuation: flush every full clip at the cap. The flush is
        // a cheap buffer swap (split_off) — the cpal callback keeps filling its
        // shared buffer throughout, so the next poll picks up whatever arrived
        // during the flush. NO samples are dropped at the boundary. The
        // expensive encrypt+import runs OFF this thread, in the clip consumer.
        for clip in drain_full_clips(&mut buffer, max_samples) {
            clip_sink(Zeroizing::new(clip), sample_rate);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    // Final drain so the tail isn't lost between the last poll and the stop,
    // including any full clip the tail completes.
    let tail = source.poll();
    buffer.extend_from_slice(&tail);
    for clip in drain_full_clips(&mut buffer, max_samples) {
        clip_sink(Zeroizing::new(clip), sample_rate);
    }

    // Whatever remains (< max_samples) is the final clip.
    SessionResult::Captured(CapturedAudio {
        samples: buffer,
        sample_rate,
    })
}

/// Peak input level of `chunk` in `[0, 1]` (max absolute sample / i16::MAX).
pub(super) fn peak_level(chunk: &[i16]) -> f32 {
    chunk
        .iter()
        .map(|s| s.unsigned_abs())
        .max()
        .map_or(0.0, |m| f32::from(m) / f32::from(i16::MAX))
}

/// Below this absolute amplitude a sample counts as silence — a muted or denied
/// mic yields ~zero samples; real audio easily exceeds it (~0.2% of full scale).
pub(super) const SILENCE_PEAK_THRESHOLD: u16 = 64;

/// Whether `samples` is effectively silent (no sample reaches the threshold).
/// Empty input is silent. Drives the save-time silence guard so a muted-mic
/// recording is discarded with an explanation instead of stored.
pub fn is_silent(samples: &[i16]) -> bool {
    samples
        .iter()
        .all(|s| s.unsigned_abs() < SILENCE_PEAK_THRESHOLD)
}

/// Split off every full `max`-sized clip from the front of `buffer`, returning
/// them in order and leaving the (< `max`) remainder in `buffer`. The
/// concatenation of the returned clips followed by the remainder always equals
/// the original `buffer` — no sample is lost or duplicated at a boundary. A
/// non-positive `max` returns nothing (unbounded buffer).
fn drain_full_clips(buffer: &mut Vec<i16>, max: usize) -> Vec<Vec<i16>> {
    let mut clips = Vec::new();
    if max == 0 {
        return clips;
    }
    while buffer.len() >= max {
        let remainder = buffer.split_off(max);
        let clip = std::mem::replace(buffer, remainder);
        clips.push(clip);
    }
    clips
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `sample_rate == 0` arm, which every other guard in this change got a
    /// named test for and this one did not. Unreachable through `CpalSource`
    /// (cpal never reports zero) and through the 48 kHz fixture source, so it is
    /// documented defensive code: the point is that it returns the cap that does
    /// not divide rather than a boundary of zero, which `drain_full_clips` would
    /// turn into empty clips forever.
    #[test]
    fn a_zero_rate_falls_back_to_the_blob_cap_rather_than_a_zero_boundary() {
        assert_eq!(max_samples_for_rate(0), MAX_SAMPLES);
    }

    /// Below the target rate the transcription bound is the tighter one; at or
    /// above it the blob cap is. Both directions, so the clamp cannot pass by
    /// always returning one of them.
    #[test]
    fn the_tighter_of_the_two_bounds_wins_at_each_rate() {
        assert!(max_samples_for_rate(8_000) < MAX_SAMPLES);
        assert_eq!(max_samples_for_rate(8_000), MAX_SAMPLES / 2 + 11);
        assert_eq!(max_samples_for_rate(16_000), MAX_SAMPLES);
        assert_eq!(max_samples_for_rate(48_000), MAX_SAMPLES);
    }

    use std::sync::mpsc;

    #[test]
    fn fixture_source_produces_nonsilent_audio() {
        let mut src = FixtureSource::default();
        assert_eq!(src.sample_rate(), 48_000);
        let chunk = src.poll();
        assert_eq!(chunk.len(), 480);
        // A 440 Hz sine is not silent.
        assert!(chunk.iter().any(|&s| s.abs() > 1000));
    }

    #[test]
    fn fixture_session_finalize_captures_audio() {
        let (tx, rx) = mpsc::channel();
        let levels = Arc::new(Mutex::new(Vec::<f32>::new()));
        let levels_cb = levels.clone();
        let handle = std::thread::spawn(move || {
            run_session(
                SourceFactory::Fixture,
                &rx,
                &move |l, _tap| levels_cb.lock().unwrap().push(l),
                &|_, _| {},
                MAX_SAMPLES,
            )
        });
        // Let a few polls accumulate, then finalize.
        std::thread::sleep(Duration::from_millis(60));
        tx.send(StopKind::Finalize).unwrap();
        match handle.join().unwrap() {
            SessionResult::Captured(audio) => {
                assert_eq!(audio.sample_rate, 48_000);
                assert!(!audio.samples.is_empty());
            }
            _ => panic!("expected Captured"),
        }
        // The level sink was driven with non-silent values (440 Hz tone).
        let observed = levels.lock().unwrap();
        assert!(observed.iter().any(|&l| l > 0.1));
    }

    #[test]
    fn fixture_session_cancel_discards() {
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            run_session(
                SourceFactory::Fixture,
                &rx,
                &|_, _tap| {},
                &|_, _| {},
                MAX_SAMPLES,
            )
        });
        std::thread::sleep(Duration::from_millis(30));
        tx.send(StopKind::Cancel).unwrap();
        assert!(matches!(handle.join().unwrap(), SessionResult::Canceled));
    }

    #[test]
    fn fixture_session_continues_into_multiple_clips_at_a_small_cap() {
        // A tiny per-clip cap forces continuation; assert clips are flushed
        // and each is exactly the cap size (the final remainder is < cap).
        const SMALL: usize = 200;
        let (tx, rx) = mpsc::channel();
        let clips = Arc::new(Mutex::new(Vec::<usize>::new()));
        let clips_cb = clips.clone();
        let handle = std::thread::spawn(move || {
            run_session(
                SourceFactory::Fixture,
                &rx,
                &|_, _tap| {},
                &move |samples, _| clips_cb.lock().unwrap().push(samples.len()),
                SMALL,
            )
        });
        std::thread::sleep(Duration::from_millis(60));
        tx.send(StopKind::Finalize).unwrap();
        let final_clip = match handle.join().unwrap() {
            SessionResult::Captured(a) => a.samples.len(),
            _ => panic!("expected Captured"),
        };
        let emitted = clips.lock().unwrap();
        assert!(
            !emitted.is_empty(),
            "small cap should force continuation clips"
        );
        assert!(
            emitted.iter().all(|&n| n == SMALL),
            "flushed clips are cap-sized"
        );
        assert!(final_clip < SMALL, "the final remainder is below the cap");
    }

    #[test]
    fn the_per_rate_clamp_bounds_a_session_and_not_only_the_helper() {
        // `run_session`'s `max_samples_for_rate(sample_rate).min(max_samples)`
        // was covered by nothing: `max_samples_for_rate` has its own unit tests,
        // and every session test runs the 48 kHz fixture, where the clamp equals
        // `MAX_SAMPLES` and is therefore invisible. Deleting that line left the
        // whole desktop suite green.
        //
        // **Why not 8 kHz, which is the rate the clamp exists for.** At 8 kHz
        // the bound is `MAX_SAMPLES / 2 + 11`, which is 16,777,216 samples. The
        // fixture emits 480 per poll on a 10 ms interval, so driving one clip to
        // that boundary is roughly an hour of wall clock. `max_samples_for_rate`
        // asserts the 8 kHz value directly one test above; what is untested
        // there is whether `run_session` APPLIES it, and that is arithmetic over
        // whatever `source.sample_rate()` returns rather than anything about
        // telephony.
        //
        // So the rate here is chosen to make the same bound small: at 1 Hz it is
        // `TRANSCRIPTION_CEILING_SAMPLES / 16000`, 2097 samples, four polls. The
        // rate is unphysical and says so; the line under test does not know that
        // and cannot.
        const RATE: u32 = 1;
        let expected = max_samples_for_rate(RATE);
        assert!(
            expected < MAX_SAMPLES,
            "the chosen rate must make the per-rate bound the tighter one, \
             or this test passes with the clamp deleted"
        );

        let (tx, rx) = mpsc::channel();
        let clips = Arc::new(Mutex::new(Vec::<usize>::new()));
        let clips_cb = clips.clone();
        let handle = std::thread::spawn(move || {
            run_session(
                SourceFactory::FixtureAt(RATE),
                &rx,
                &|_, _tap| {},
                &move |samples, _| clips_cb.lock().unwrap().push(samples.len()),
                // The caller's cap is the blob cap, deliberately: the RATE bound
                // has to be what binds, so a regression cannot hide behind this
                // argument being the smaller of the two.
                MAX_SAMPLES,
            )
        });
        std::thread::sleep(Duration::from_millis(120));
        tx.send(StopKind::Finalize).unwrap();
        let final_clip = match handle.join().unwrap() {
            SessionResult::Captured(a) => a.samples.len(),
            _ => panic!("expected Captured"),
        };

        let emitted = clips.lock().unwrap();
        assert!(
            !emitted.is_empty(),
            "the per-rate bound must force a continuation clip; it did not, so \
             `run_session` is using the caller's cap of {MAX_SAMPLES}"
        );
        assert!(
            emitted.iter().all(|&n| n == expected),
            "every flushed clip must be exactly the per-rate bound {expected}, got {emitted:?}"
        );
        assert!(
            final_clip < expected,
            "the final remainder is below the bound"
        );
    }

    #[test]
    fn peak_level_is_normalized_and_silence_is_zero() {
        assert_eq!(peak_level(&[]), 0.0);
        assert_eq!(peak_level(&[0, 0, 0]), 0.0);
        assert!((peak_level(&[i16::MAX]) - 1.0).abs() < 1e-6);
        assert!(peak_level(&[100, -16_000, 50]) > 0.4);
    }

    #[test]
    fn is_silent_flags_muted_audio_only() {
        assert!(is_silent(&[]));
        assert!(is_silent(&[0, 1, -2, 3])); // dither-level noise → silent
        assert!(!is_silent(&[0, 5_000, 0])); // a real peak → not silent
        assert!(!is_silent(&[i16::MIN])); // i16::MIN handled via unsigned_abs
    }

    #[test]
    fn drain_full_clips_loses_no_sample_at_a_boundary() {
        let original: Vec<i16> = (0..25).collect();
        let mut buf = original.clone();
        let clips = drain_full_clips(&mut buf, 10);
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0], (0..10).collect::<Vec<_>>());
        assert_eq!(clips[1], (10..20).collect::<Vec<_>>());
        assert_eq!(buf, (20..25).collect::<Vec<_>>());
        // Concatenation of clips + remainder reconstructs the input EXACTLY.
        let mut reconstructed: Vec<i16> = clips.concat();
        reconstructed.extend_from_slice(&buf);
        assert_eq!(reconstructed, original);
    }

    #[test]
    fn drain_full_clips_noops_below_cap_or_zero_max() {
        let mut buf: Vec<i16> = vec![1, 2, 3];
        assert!(drain_full_clips(&mut buf, 10).is_empty());
        assert_eq!(buf, vec![1, 2, 3]);
        assert!(drain_full_clips(&mut buf, 0).is_empty());
        assert_eq!(buf, vec![1, 2, 3]);
    }
}
