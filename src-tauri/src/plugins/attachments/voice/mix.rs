//! Mono mix of two capture sources (meeting notes, myne-md/myne#789).
//!
//! A meeting has two voices: the microphone hears the user, the system-audio
//! tap hears the other participants, and neither alone is a record of the
//! meeting. This module sums them into the one mono stream the rest of the
//! pipeline already understands, so the encoder, the clip boundary and the
//! transcription path are untouched.
//!
//! Two properties are deliberate and worth stating rather than inferring.
//!
//! **The clocks are never aligned.** The microphone runs on its own device
//! clock and the tap on its aggregate device's; they drift against each other
//! by tens of parts per million, which over an hour is a fraction of a second.
//! Nothing here compensates for that, because a mono SUM has no timeline to
//! align to: a sample from one input is added to whatever the other input
//! produced at that moment, and drift only changes which moment that is. The
//! alternative (resampling one clock onto the other) would buy alignment the
//! transcript cannot observe, at the cost of a drift estimator that can be
//! wrong.
//!
//! **Both inputs are resampled to one common rate before summing**, which is
//! not optional: adding 44.1 kHz samples to 48 kHz samples misaligns every
//! frame after the first. [`LinearResampler`] is streaming and stateful, so the
//! fractional read position and one sample of history carry across polls and
//! the concatenation of per-poll outputs is the same stream as one pass over
//! the concatenated input.
//!
//! Nothing in this module touches the disk, the protocol or a load-bearing
//! identifier: the mix is PCM in RAM, and what it feeds is an ordinary `MYA1`
//! attachment.

use super::capture::AudioSource;

/// A mono-i16 source that sums two other sources.
///
/// `!Send` like every [`AudioSource`]: it owns its inner sources, which own
/// device handles, and it is therefore built and driven inside the capture
/// thread and never moved across one.
pub struct MixSource {
    a: Box<dyn AudioSource>,
    b: Box<dyn AudioSource>,
    sample_rate: u32,
    /// `None` when that input already runs at the common rate, which is the
    /// common case (both sides of a desktop meeting are usually 48 kHz) and
    /// costs nothing to special-case.
    a_resampler: Option<LinearResampler>,
    b_resampler: Option<LinearResampler>,
    a_raw: Vec<i16>,
    b_raw: Vec<i16>,
    /// Peak of the second input on the most recent poll, for the silence
    /// warning. Recorded from the RAW samples, before resampling, because the
    /// question is whether the device produced anything and not what the
    /// resampler made of it.
    b_peak: f32,
}

impl MixSource {
    /// Mix `mic` and `tap` into one stream at the higher of their two rates.
    ///
    /// The two inputs are not interchangeable: the SECOND is the system-audio
    /// side, and [`AudioSource::tap_level`] reports its peak. Callers build a
    /// mix through [`build_meeting_mix`], which upholds that.
    ///
    /// The higher rate is chosen rather than the lower because downsampling
    /// discards information the transcription front end would otherwise have,
    /// and because the tap's rate is the one that carries the meeting.
    pub fn new(mic: Box<dyn AudioSource>, tap: Box<dyn AudioSource>) -> Self {
        let mic_rate = mic.sample_rate();
        let tap_rate = tap.sample_rate();
        let sample_rate = mic_rate.max(tap_rate);
        Self {
            a_resampler: LinearResampler::for_rates(mic_rate, sample_rate),
            b_resampler: LinearResampler::for_rates(tap_rate, sample_rate),
            a: mic,
            b: tap,
            sample_rate,
            a_raw: Vec::new(),
            b_raw: Vec::new(),
            b_peak: 0.0,
        }
    }
}

impl AudioSource for MixSource {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn poll(&mut self) -> Vec<i16> {
        self.a_raw = self.a.poll();
        self.b_raw = self.b.poll();
        self.b_peak = super::capture::peak_level(&self.b_raw);

        // Resample in place when needed. The two arms are separate so the
        // identity case (no resampler) never allocates a second buffer.
        let a: &[i16] = match self.a_resampler.as_mut() {
            Some(r) => {
                let mut out = std::mem::take(&mut self.a_raw);
                r.process_in_place(&mut out);
                self.a_raw = out;
                &self.a_raw
            }
            None => &self.a_raw,
        };
        let b: &[i16] = match self.b_resampler.as_mut() {
            Some(r) => {
                let mut out = std::mem::take(&mut self.b_raw);
                r.process_in_place(&mut out);
                self.b_raw = out;
                &self.b_raw
            }
            None => &self.b_raw,
        };

        // The two inputs are drained independently and one may legitimately be
        // empty while the other has data: a silent input contributes silence,
        // never a panic and never a dropped sample from the other side.
        let n = a.len().max(b.len());
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let x = i32::from(a.get(i).copied().unwrap_or(0));
            let y = i32::from(b.get(i).copied().unwrap_or(0));
            // Saturating, not wrapping. Two loud inputs at full scale would
            // otherwise fold a positive peak into a negative one, which is
            // audible as a click and is the kind of corruption nothing
            // downstream can detect.
            out.push((x + y).clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16);
        }
        out
    }

    fn tap_level(&self) -> Option<f32> {
        Some(self.b_peak)
    }
}

/// Streaming linear resampler over mono `i16`.
///
/// Linear rather than windowed-sinc on purpose: this is a sample-rate bridge
/// between two capture devices feeding an ASR front end, the house style is
/// already linear (`local_inference::audio::resample_linear`), and a windowed
/// kernel would be a new numerical surface with no test that could tell it was
/// wrong. The decoder's resampler is not reusable here because it targets
/// 16 kHz and this one targets an arbitrary common rate.
///
/// State is the fractional read position plus the previous input sample, so the
/// stream is continuous across calls: `process` over `[a, b]` in two calls
/// produces the same output as one call over `a ++ b`.
struct LinearResampler {
    /// Input samples per output sample, as the reduced fraction `num / den`.
    num: u64,
    den: u64,
    /// Read position, in input samples scaled by `den`. Exact integer
    /// arithmetic rather than an accumulated `f64`: adding `1/3` to a float
    /// three times is not `1`, so a float position drifts across a long
    /// session and, worse, makes the loop's exit depend on how the error
    /// happened to land. That is not hypothetical: the first version of this
    /// resampler emitted one extra sample per poll boundary, which the
    /// continuity test below caught.
    pos: u64,
    /// The last input sample of the previous buffer, used to interpolate across
    /// the boundary.
    last: i16,
    have_last: bool,
    /// Output buffer, reused across calls.
    out: Vec<i16>,
}

impl LinearResampler {
    /// `None` when the rates already match, so the caller can skip the copy.
    fn for_rates(from: u32, to: u32) -> Option<Self> {
        if from == 0 || to == 0 || from == to {
            return None;
        }
        let g = gcd(u64::from(from), u64::from(to));
        Some(Self {
            num: u64::from(from) / g,
            den: u64::from(to) / g,
            pos: 0,
            last: 0,
            have_last: false,
            out: Vec::new(),
        })
    }

    /// Resample `buf` in place. `buf` is replaced by the resampled output.
    fn process_in_place(&mut self, buf: &mut Vec<i16>) {
        if buf.is_empty() {
            return;
        }
        self.out.clear();
        // The virtual buffer is `[last, buf...]` once history exists, so index 0
        // is the previous buffer's final sample and index `i` is `buf[i - base]`.
        let base = usize::from(self.have_last);
        let len = base + buf.len();
        let at = |i: usize| -> f32 {
            if i < base {
                f32::from(self.last)
            } else {
                f32::from(buf[i - base])
            }
        };
        // The last index with a successor to interpolate toward, scaled by
        // `den`. `buf` is non-empty, so `len >= 1` and this is never negative.
        let limit = ((len - 1) as u64) * self.den;
        while self.pos < limit {
            let i = (self.pos / self.den) as usize;
            let frac = (self.pos % self.den) as f64 / self.den as f64;
            let a = at(i);
            let b = at(i + 1);
            let v = a + (b - a) * frac as f32;
            self.out
                .push(v.round().clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16);
            self.pos += self.num;
        }
        // Re-anchor: the next buffer's virtual index 0 is THIS buffer's final
        // sample, so the position restarts relative to that. The loop leaves
        // `pos >= limit`, so this never underflows.
        self.pos -= limit;
        self.last = buf[buf.len() - 1];
        self.have_last = true;
        std::mem::swap(buf, &mut self.out);
    }
}

/// Greatest common divisor, so the rate fraction is reduced and the fixed-point
/// position cannot overflow on a long session.
fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = b;
        b = a % b;
        a = t;
    }
    a.max(1)
}

/// Build the meeting mix when the platform can supply a system-audio source.
///
/// Kept here rather than in `capture.rs` so the "which two things are mixed"
/// question has one home. `tap` is `None` on every platform that cannot capture
/// system audio (macOS below 14.2, and Linux), which is the stated platform
/// matrix rather than a failure: the session still runs, on the microphone
/// alone, and the UI says so.
pub fn build_meeting_mix(
    mic: Box<dyn AudioSource>,
    tap: Option<Box<dyn AudioSource>>,
) -> Box<dyn AudioSource> {
    match tap {
        Some(tap) => Box::new(MixSource::new(mic, tap)),
        None => mic,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source that hands out a constant value, so a test can read the mix's
    /// arithmetic off the output without a device or a tone.
    struct ConstSource {
        rate: u32,
        value: i16,
        per_poll: usize,
        done: bool,
    }

    impl ConstSource {
        fn new(rate: u32, value: i16, per_poll: usize) -> Self {
            Self {
                rate,
                value,
                per_poll,
                done: false,
            }
        }
    }

    impl AudioSource for ConstSource {
        fn sample_rate(&self) -> u32 {
            self.rate
        }
        fn poll(&mut self) -> Vec<i16> {
            if self.done {
                return Vec::new();
            }
            vec![self.value; self.per_poll]
        }
    }

    /// One poll per source, then silence: enough to observe the arithmetic and
    /// the resampled length, with no timing dependence.
    fn one_shot(rate: u32, value: i16, n: usize) -> Box<dyn AudioSource> {
        Box::new(ConstSource::new(rate, value, n))
    }

    #[test]
    fn matching_rates_sum_sample_for_sample_without_resampling() {
        let mut mix = MixSource::new(one_shot(48_000, 1000, 8), one_shot(48_000, 2000, 8));
        assert_eq!(mix.sample_rate(), 48_000);
        let out = mix.poll();
        assert_eq!(out.len(), 8, "no rate change means no length change");
        assert!(out.iter().all(|&s| s == 3000));
    }

    #[test]
    fn the_common_rate_is_the_higher_of_the_two() {
        let mix = MixSource::new(one_shot(44_100, 0, 4), one_shot(48_000, 0, 4));
        assert_eq!(mix.sample_rate(), 48_000);
    }

    #[test]
    fn the_lower_rate_input_is_expanded_to_the_common_rate() {
        // The 48 kHz side is drained so the output length is the resampled
        // length and nothing else: `poll` returns `max(a, b)` samples, and a
        // live 48 kHz side would mask what the resampler produced.
        let mut drained = ConstSource::new(48_000, 0, 0);
        drained.done = true;
        let mut mix = MixSource::new(one_shot(16_000, 100, 160), Box::new(drained));
        assert_eq!(mix.sample_rate(), 48_000);
        let out = mix.poll();
        // 160 input samples at 16 kHz is 10 ms, which is 480 samples at 48 kHz.
        // The resampler cannot emit the final sample, which has no successor to
        // interpolate toward, so the count is short by exactly that one.
        assert_eq!(out.len(), 477);
    }

    #[test]
    fn a_silent_input_leaves_the_other_input_untouched() {
        let mut mix = MixSource::new(one_shot(48_000, 0, 6), one_shot(48_000, -4000, 6));
        let out = mix.poll();
        assert_eq!(out.len(), 6);
        assert!(out.iter().all(|&s| s == -4000));
    }

    #[test]
    fn an_empty_poll_on_one_side_does_not_shorten_the_other() {
        // The first source is drained (empty poll), the second still has data.
        let mut drained = ConstSource::new(48_000, 0, 4);
        drained.done = true;
        let mut mix = MixSource::new(Box::new(drained), one_shot(48_000, 700, 5));
        let out = mix.poll();
        assert_eq!(
            out.len(),
            5,
            "the live side is not truncated by the dead one"
        );
        assert!(out.iter().all(|&s| s == 700));
    }

    #[test]
    fn two_full_scale_inputs_saturate_rather_than_wrap() {
        // 32000 + 32000 = 64000, which is past i16::MAX. Wrapping would land on
        // -1536, a positive peak read as a negative one.
        let mut mix = MixSource::new(one_shot(48_000, 32_000, 4), one_shot(48_000, 32_000, 4));
        let out = mix.poll();
        assert!(out.iter().all(|&s| s == i16::MAX), "expected saturation");

        let mut mix = MixSource::new(one_shot(48_000, -32_000, 4), one_shot(48_000, -32_000, 4));
        let out = mix.poll();
        assert!(out.iter().all(|&s| s == i16::MIN), "expected saturation");
    }

    #[test]
    fn the_resampler_is_continuous_across_polls() {
        // The whole point of carrying state: two calls over 8 samples each must
        // produce the same stream as one call over all 16. Driven through the
        // resampler directly, because a source hands out its data in one poll.
        let mut split = LinearResampler::for_rates(16_000, 48_000).expect("rates differ");
        let mut first: Vec<i16> = (0..8).map(|i| (i * 100) as i16).collect();
        let mut second: Vec<i16> = (8..16).map(|i| (i * 100) as i16).collect();
        split.process_in_place(&mut first);
        split.process_in_place(&mut second);
        let mut whole = Vec::new();
        whole.extend_from_slice(&first);
        whole.extend_from_slice(&second);

        let mut one_shot_resampler =
            LinearResampler::for_rates(16_000, 48_000).expect("rates differ");
        let mut all: Vec<i16> = (0..16).map(|i| (i * 100) as i16).collect();
        one_shot_resampler.process_in_place(&mut all);

        assert_eq!(
            whole, all,
            "splitting the input across calls must not change the output"
        );
    }

    #[test]
    fn a_matching_rate_needs_no_resampler() {
        assert!(LinearResampler::for_rates(48_000, 48_000).is_none());
        assert!(LinearResampler::for_rates(0, 48_000).is_none());
        assert!(LinearResampler::for_rates(48_000, 0).is_none());
    }

    #[test]
    fn the_meeting_mix_falls_back_to_the_microphone_alone() {
        // No tap available (Linux, or macOS below 14.2): the session still runs.
        let mic = one_shot(48_000, 1234, 4);
        let mut source = build_meeting_mix(mic, None);
        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.poll(), vec![1234; 4]);
    }

    #[test]
    fn the_meeting_mix_sums_when_a_tap_is_present() {
        let mut source =
            build_meeting_mix(one_shot(48_000, 1000, 4), Some(one_shot(48_000, 24, 4)));
        assert_eq!(source.sample_rate(), 48_000);
        assert_eq!(source.poll(), vec![1024; 4]);
    }
}
