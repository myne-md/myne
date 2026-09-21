//! WAV decode + 16 kHz-mono resample for the transcription front end
//! (voice-to-text, MYND-550; SYNC-V3).
//!
//! Whisper consumes **16 kHz mono f32** PCM (`candle-transformers` `whisper`,
//! `SAMPLE_RATE = 16000`). Myne voice notes are stored as canonical `audio/wav`
//! — a 16-bit PCM RIFF/WAVE container written by the desktop `cpal` encoder
//! (`attachments::voice::encoder`, mono, device-native rate ~44.1/48 kHz) or the
//! mobile WebView path (mono, 16 kHz). This module bridges the two:
//! `wav_to_mono_16k(bytes) -> Vec<f32>` = parse → downmix → resample.
//!
//! **No decode/resample crate** (SYNC-V3): the parser is a hand-rolled RIFF
//! chunk-walk (mirroring the deliberately hand-rolled *encoder*), and the
//! resampler is dependency-free linear interpolation — keeping the ML surface to
//! the single already-audited Candle row (TB9; "adding a dependency is a
//! security decision"). Higher-order resampling (e.g. windowed-sinc) is a
//! localized quality swap behind this same signature if ever needed.
//!
//! Logging: DENY-list clean (`src-tauri/AGENTS.md`). The decoded PCM is
//! AS1-class decrypted audio — **never logged**; [`AudioError`] carries no
//! sample data, only a bounded kind.

// Consumed by the task-5 `transcribe` command; until that wiring lands the
// non-test build sees these as dead.
#![cfg_attr(not(test), allow(dead_code))]

use myne_core::inference::error::EngineError;
use serde::Serialize;

/// Sample rate the Whisper front end requires (`pcm_to_mel` input).
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Accepted `fmt ` sample-rate range, stated rather than implied: 4 kHz is below
/// telephony (8 kHz), 384 kHz above any consumer or professional capture rate.
/// Both ends bound the ratio the resampler derives from the header, so the
/// expansion is at most 4x and the contraction at most 24x. See `parse_wav` for
/// why the bound exists at all (myne#315).
///
/// Module scope rather than function-local, because the ceiling's own test
/// derives the worst reachable output from `MIN` and would otherwise restate the
/// number.
use crate::audio_rate::{MAX_SAMPLE_RATE_HZ, MIN_SAMPLE_RATE_HZ};

/// Failure modes of WAV decode. Closed + content-free (DENY-list): no sample
/// data, no path, no raw error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, thiserror::Error)]
pub enum AudioError {
    /// Missing/short `RIFF` header or not a `WAVE` form.
    #[error("not a RIFF/WAVE container")]
    NotWave,
    /// No `fmt ` chunk, or it was truncated.
    #[error("missing or truncated fmt chunk")]
    NoFmtChunk,
    /// No `data` chunk.
    #[error("missing data chunk")]
    NoDataChunk,
    /// `audio_format` is not PCM (1). Compressed WAV (e.g. float/ADPCM) is out
    /// of scope — Myne stores canonical 16-bit PCM.
    #[error("unsupported WAV audio format (not PCM)")]
    UnsupportedFormat,
    /// `bits_per_sample` is not 16. The Myne encoder is 16-bit PCM.
    #[error("unsupported bit depth (expected 16-bit PCM)")]
    UnsupportedBitDepth,
    /// Zero channels, or a channel/frame count that does not divide evenly.
    #[error("malformed channel/frame layout")]
    BadLayout,
    /// The decoded clip has no samples.
    #[error("empty audio")]
    Empty,
    /// The clip would resample to more than [`MAX_PCM_SAMPLES`] at 16 kHz.
    ///
    /// Its own variant rather than [`AudioError::BadLayout`], because the header
    /// is well-formed and the refusal is about size: folding the two would make
    /// `BadLayout`'s own doc line false for a case that reaches it in normal
    /// operation. `commands.rs` maps it to `EngineError::AudioTooLong`, which is
    /// what lets the user read "this recording is too long" instead of "failed,
    /// try again" and lets the surface suppress a retry that cannot help.
    #[error("audio too long to transcribe")]
    TooLong,
}

impl AudioError {
    /// Bounded, content-free tag for structured logging (DENY-list safe).
    /// Forward-declared like `EngineError::kind` — consumed once the transcribe
    /// command logs a decode-failure stage.
    #[allow(dead_code)]
    pub fn kind(&self) -> &'static str {
        match self {
            AudioError::NotWave => "not_wave",
            AudioError::NoFmtChunk => "no_fmt_chunk",
            AudioError::NoDataChunk => "no_data_chunk",
            AudioError::UnsupportedFormat => "unsupported_format",
            AudioError::UnsupportedBitDepth => "unsupported_bit_depth",
            AudioError::BadLayout => "bad_layout",
            AudioError::Empty => "empty",
            AudioError::TooLong => "too_long",
        }
    }
}

/// Output samples `frames` at `sample_rate` will resample to at 16 kHz, rounded
/// UP.
///
/// A named function rather than an expression inline in `parse_wav`, so the
/// ceiling's agreement with `resample_linear` can be tested against the formula
/// the parser actually uses. Written inline, the only way to check that
/// agreement was to restate the arithmetic in the test, which is a copy compared
/// against a second copy: reverting this to truncating division left every test
/// green.
///
/// Rounding up is the load-bearing part. `resample_linear` derives its own
/// `out_len` with `f64::round`, and `ceil >= round` for every input, so this
/// bound is never looser than the one downstream. A floor here leaves a band of
/// (frames, rate) pairs that pass the parse-time guard and are then refused by
/// the resampler, after the `Vec<i16>` and the mono `Vec<f32>` have already been
/// built, which is the allocation the parse-time placement exists to avoid.
///
/// `u128` because `frames * WHISPER_SAMPLE_RATE` overflows `u64` for a `data`
/// slice near `isize::MAX`, and this must not be the arithmetic that panics.
///
/// `None` on a zero rate rather than a doc line asking callers not to do it.
/// `div_ceil(0)` panics, and the clamp in `parse_wav` does reject zero first, so
/// this arm is unreachable through the one production caller. Its sibling
/// `resample_linear` makes the same guarantee explicit for the same reason
/// stated there: the block exists for a caller that did not come through the
/// clamp, and hardening one helper by construction and the other by comment is
/// the inconsistency, not the caution.
fn projected_out_samples(frames: usize, sample_rate: u32) -> Option<u128> {
    if sample_rate == 0 {
        return None;
    }
    Some(((frames as u128) * (WHISPER_SAMPLE_RATE as u128)).div_ceil(sample_rate as u128))
}

/// Raw decoded PCM: interleaved 16-bit samples plus the format the WAV declared.
struct RawPcm {
    samples: Vec<i16>,
    channels: u16,
    sample_rate: u32,
}

fn le_u16(b: &[u8]) -> u16 {
    u16::from_le_bytes([b[0], b[1]])
}
fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// Parse a canonical PCM RIFF/WAVE byte stream: walk chunks to find `fmt ` +
/// `data`, tolerating (and skipping) any interleaved chunks (`LIST`, `fact`,
/// …). Only 16-bit PCM is accepted.
fn parse_wav(bytes: &[u8]) -> Result<RawPcm, AudioError> {
    // RIFF<size:4>WAVE = 12 bytes minimum.
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(AudioError::NotWave);
    }

    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (audio_format, channels, rate, bits)
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = le_u32(&bytes[pos + 4..pos + 8]) as usize;
        let body_start = pos + 8;
        let body_end = body_start.saturating_add(size);
        if body_end > bytes.len() {
            // Truncated chunk. If it's the fmt chunk we can't proceed; a
            // truncated trailing data chunk we still try to use up to EOF.
            if id == b"fmt " {
                return Err(AudioError::NoFmtChunk);
            }
            if id == b"data" {
                data = Some(&bytes[body_start..bytes.len()]);
            }
            break;
        }

        if id == b"fmt " {
            if size < 16 {
                return Err(AudioError::NoFmtChunk);
            }
            let f = &bytes[body_start..body_start + 16];
            fmt = Some((
                le_u16(&f[0..2]),
                le_u16(&f[2..4]),
                le_u32(&f[4..8]),
                le_u16(&f[14..16]),
            ));
        } else if id == b"data" {
            data = Some(&bytes[body_start..body_end]);
        }

        // Chunks are word-aligned: an odd size carries a pad byte.
        pos = body_end + (size & 1);
    }

    let (audio_format, channels, sample_rate, bits) = fmt.ok_or(AudioError::NoFmtChunk)?;
    let data = data.ok_or(AudioError::NoDataChunk)?;

    // WAVE_FORMAT_PCM = 1. (WAVE_FORMAT_EXTENSIBLE=0xFFFE would need the subformat
    // GUID; Myne never writes it, so treat non-PCM as unsupported.)
    if audio_format != 1 {
        return Err(AudioError::UnsupportedFormat);
    }
    if bits != 16 {
        return Err(AudioError::UnsupportedBitDepth);
    }
    if channels == 0 {
        return Err(AudioError::BadLayout);
    }
    // A `sample_rate` outside the range real audio uses is a malformed `fmt `
    // chunk, and the resampler's expansion is driven straight off it.
    //
    // Zero was already rejected — it sends `to_rate / from_rate` to +inf, so
    // `out_len` becomes `usize::MAX` and `Vec::with_capacity` capacity-overflow
    // panics. But the guard stopped one value short of the problem (myne#315):
    // `sample_rate = 1` is a finite, "valid" number that expands the clip
    // 16,000× on the way to Whisper's 16 kHz. A short clip then asks for tens
    // of GB, and neither outcome is catchable — where the allocator refuses,
    // `handle_alloc_error` **aborts** (not a panic, so the `spawn_blocking`
    // JoinError arm never runs); where the OS overcommits, the fill loop
    // touches every page and the process is OOM-killed. Either way the vault is
    // dropped mid-session and edits since the last autosave tick are lost.
    //
    // The adversary is **A7**, not the A6 this comment used to name, and the
    // route matters because the A6 reading was wrong twice over. A6 is a lost or
    // stolen device with the app already open, where an attacker needs no WAV at
    // all. And the correction that landed on mobile (myne#485) does not stop at
    // renaming the row. The premise that a hostile WAV must arrive by SYNC,
    // where the blob is AEAD-verified before it is written so its author
    // already holds `itemsKey`, covers one ingress out of three.
    // `sniff_content_type` maps any `RIFF`…`WAVE` to `audio/wav`, `audio/wav`
    // is in `ALLOWLISTED_CONTENT_TYPES`, `attachment_import` admits anything
    // that sniffs onto that list, and the Transcribe row is gated on the type,
    // so a WAV a user is SENT and attaches (file picker, paste or drop)
    // reaches this parser with no key material involved. That is the same route
    // the threat model's OCR paragraph names, and it reaches A7 the same way:
    // an attacker who can get a file into the user's hands. A7 is ⚠️
    // Best-effort there, so this stays hardening inside a conceded boundary
    // rather than a new guarantee. The conclusion is unchanged; the
    // reachability is not.
    //
    // Two ingresses that do NOT reach here, checked rather than assumed,
    // because the obvious guess is wrong for both. The Obsidian importer has no
    // binary-attachment path at all. The browser clipper's per-image
    // `attachment_import` seam is unimplemented (`clipper/envelope.rs` says so),
    // so nothing it accepts becomes an attachment yet. The reason is worth
    // stating precisely rather than by its name, because `resniff_image`
    // (`clipper/validation.rs`) reads like the filter and is not one: it is
    // `#[allow(dead_code)]` with no production caller, and its body is
    // `sniff_content_type`, which answers `audio/wav` for a WAV. When that seam
    // lands, this file gains a third ingress and nothing here will say so.
    //
    // The sync route is still the sharpest of the three: `transcribe` takes an
    // `attachment_id` and reads the WAV out of the vault (`commands.rs`), so a
    // blob written by a compromised second device reaches this parser without
    // the user picking a file, and `transcription_enabled` defaults ON.
    //
    // The range itself, and why those two numbers, is on the constants.
    if !(MIN_SAMPLE_RATE_HZ..=MAX_SAMPLE_RATE_HZ).contains(&sample_rate) {
        return Err(AudioError::BadLayout);
    }

    // BEFORE the size projection, and before the collect. Both placements matter
    // and they are different properties.
    //
    // Before the COLLECT is the allocation property: `samples.len()` is
    // `data.len() / 2` by construction, so the check needs no samples, and
    // running it after meant a malformed 64 MiB attachment allocated and filled
    // 64 MiB of `i16` and was then rejected one branch from the refusal that
    // exists to stop exactly that.
    //
    // Before the PROJECTION is the diagnosis property, and it was missing. A WAV
    // that is BOTH malformed and oversized was reported as `TooLong`, because
    // the size bound ran first and returned. `TooLong` is the one refusal in
    // this enum that reaches the user as a specific, actionable sentence about
    // the clip's length, and it deliberately suppresses a retry; saying it about
    // a file whose channel layout does not divide sends the user to shorten
    // something that will be refused at any length. The layout is a fact about
    // the header alone, so it is cheaper and it is answerable first.
    if !(data.len() / 2).is_multiple_of(channels as usize) {
        return Err(AudioError::BadLayout);
    }

    // Bound the decode HERE, where the size is first knowable and nothing has
    // been allocated from it yet. `data.len() / 2` is the i16 count the collect
    // below would produce, dividing by `channels` gives frames, and the
    // resample to 16 kHz scales that by `WHISPER_SAMPLE_RATE / sample_rate`.
    //
    // The ceiling has to live at this altitude rather than only inside
    // `resample_linear`, for two reasons the resampler cannot see. It runs
    // BEFORE all four buffers this decode holds live (these `data` bytes, the
    // `Vec<i16>` below, the mono `Vec<f32>`, and the resampled output), even
    // though the quantity it bounds is only the fourth: the other three are
    // bounded by the § 9.9 attachment cap, and the point here is that the
    // refusal happens before any of them is built. And it covers the identity
    // path, which `resample_linear`'s `from_rate == to_rate` fast-path would
    // otherwise exempt: 16 kHz is exactly what the mobile WebView recorder
    // writes (`mobile/src/lib/voiceRecord.ts`), and those clips arrive here by
    // sync, so on desktop the unmeasured path was every phone-recorded voice
    // note.
    //
    // `div_ceil`, not truncating division, and that is load-bearing rather than
    // fussy. `resample_linear` derives its own `out_len` with `f64::round`, so a
    // floor here is LOOSER than the check downstream: there is a band of
    // (frames, rate) pairs, constructible well inside the attachment cap, where
    // a clip passes this guard and is then refused by the resampler after the
    // `Vec<i16>` and the mono `Vec<f32>` are already allocated. Rounding up
    // makes this bound never looser than that one, which is what turns the
    // resampler's copy into real defence in depth instead of the live path.
    //
    // `u128` because `frames * WHISPER_SAMPLE_RATE` overflows `u64` for a
    // `data` slice near `isize::MAX`, and this must not be the arithmetic that
    // panics.
    let frames = (data.len() / 2) / channels as usize;
    match projected_out_samples(frames, sample_rate) {
        // Unreachable: the clamp above rejected zero. Spelled out rather than
        // unwrapped so a future reordering of the two guards cannot panic here.
        None => return Err(AudioError::BadLayout),
        Some(projected) if projected > MAX_PCM_SAMPLES as u128 => return Err(AudioError::TooLong),
        Some(_) => {}
    }

    // i16 LE samples; a trailing odd byte (never expected for 16-bit) is dropped.
    let samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    Ok(RawPcm {
        samples,
        channels,
        sample_rate,
    })
}

/// Downmix interleaved i16 frames to mono f32 in `[-1.0, 1.0]` by averaging
/// channels (division by 32768 keeps the range symmetric; i16::MIN maps to
/// -1.0).
fn downmix_to_mono_f32(pcm: &RawPcm) -> Vec<f32> {
    let ch = pcm.channels as usize;
    if ch == 1 {
        return pcm.samples.iter().map(|&s| s as f32 / 32768.0).collect();
    }
    pcm.samples
        .chunks_exact(ch)
        .map(|frame| {
            let sum: f32 = frame.iter().map(|&s| s as f32).sum();
            (sum / ch as f32) / 32768.0
        })
        .collect()
}

/// The length [`resample_linear`] would allocate, or the refusal.
///
/// The ROUNDING AND THE COMPARISON, in one function, and that pairing is the
/// point. A named function for the same reason [`projected_out_samples`] is
/// one, and the omission was found the same way: `the_two_ceilings_agree_...`
/// drove the parser's half through the real formula and restated this one, so
/// injecting `out_len >= MAX_PCM_SAMPLES` (the exact off-by-one the test is
/// named for) left every test green. Extracting only the length did not fix it:
/// the test still spelled `<= MAX_PCM_SAMPLES` itself, so the injected
/// comparison was still the one nobody called. A copy compared against a second
/// copy checks nothing, and the copy can be either half.
///
/// `f64::round`, not `div_ceil`: this is the real output length, and
/// `projected_out_samples` rounds UP so the parse-time bound is never looser
/// than the comparison here.
///
/// Refuse rather than truncate: a silently shortened clip would transcribe the
/// first fraction of the audio and report it as the whole thing.
fn resample_out_len(input_len: usize, from_rate: u32, to_rate: u32) -> Result<usize, AudioError> {
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input_len as f64) * ratio).round() as usize;
    if out_len > MAX_PCM_SAMPLES {
        return Err(AudioError::TooLong);
    }
    Ok(out_len)
}

/// Linear-interpolation resample from `from_rate` to `to_rate`. Dependency-free
/// (SYNC-V3); adequate for speech ASR (Whisper's mel front end is tolerant).
/// Identity fast-path when the rates already match.
fn resample_linear(input: Vec<f32>, from_rate: u32, to_rate: u32) -> Result<Vec<f32>, AudioError> {
    // A zero on either side, explicitly, before any float touches it. `0 / 0` is
    // NaN and `NaN as usize` saturates to 0 in Rust, so a `from_rate == to_rate
    // == 0` call would compute an `out_len` of zero, clear the ceiling and take
    // the identity arm with its length never measured. That is unreachable
    // through `wav_to_mono_16k` (the clamp rejects 0 and `to_rate` is always
    // `WHISPER_SAMPLE_RATE`), but this block exists precisely for a caller that
    // did not come through the clamp, so the one input that defeats it matters.
    if from_rate == 0 || to_rate == 0 {
        return Err(AudioError::BadLayout);
    }
    let out_len = resample_out_len(input.len(), from_rate, to_rate)?;
    // The refusal above is defence in depth behind `parse_wav`, whose bound
    // rounds UP so it is never looser than this one. Repeating it at the
    // allocation keeps the helper sound for a caller that reaches it directly,
    // and `resample_out_len` runs ABOVE the identity fast-path below: taken
    // after it, a clip already at the target rate would return its clone
    // unmeasured, and 16 kHz is exactly what the mobile recorder writes.
    if from_rate == to_rate || input.is_empty() {
        return Ok(input);
    }
    if out_len == 0 {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(out_len);
    let step = from_rate as f64 / to_rate as f64; // input samples per output sample
    for i in 0..out_len {
        let src = i as f64 * step;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let a = input[i0.min(input.len() - 1)];
        let b = input[(i0 + 1).min(input.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    Ok(out)
}

/// Ceiling on the resampled PCM this path will materialize, at Whisper's
/// 16 kHz mono `f32`.
///
/// **Derived from the § 9.9 attachment cap, not picked**, and the derivation is
/// the design rather than a shortcut.
///
/// What already bounds this decode is that cap. `transcribe` reads its WAV
/// through `decode_attachment_plaintext`, and `protocol::MAX_ATTACHMENT_LEN`
/// refuses anything over 64 MiB on the DECODE path, before allocation, so a
/// hostile blob arriving by sync is bounded before this file sees a byte of it.
/// Sixty-four MiB of mono 16-bit is exactly `MAX_ATTACHMENT_LEN / 2` frames,
/// which at 16 kHz is about 34 min 57 s: the longest clip a legal attachment
/// can hold at the rate Whisper wants.
///
/// Putting the ceiling exactly there gives it the property a picked number
/// cannot have. Nothing a legal attachment can carry at the target rate is ever
/// refused, so no recording any Myne client produced can hit it. The desktop
/// `cpal` encoder captures at 44.1/48 kHz, where a cap-sized attachment is at most
/// 12 min 41 s at 44.1 kHz and 11 min 39 s at 48 kHz (33,554,410 frames over each
/// rate, so the SLOWER rate is the longer clip),
/// and the mobile WebView recorder writes 16 kHz with no duration cap, whose
/// worst case is the 34 min 57 s above and syncs here to be transcribed. What IS
/// refused is a clip that reaches this length by EXPANSION from a lower declared
/// rate, and that is the case worth refusing: `parse_wav`'s clamp holds
/// expansion to 4x, so without this bound the same 64 MiB could still drive
/// 134 M output samples. That was a worst case of roughly 768 MiB across the
/// four buffers a decode used to hold live (the WAV bytes 64, the `Vec<i16>`
/// 64, the mono `Vec<f32>` 128, the output 512). It is now **320 MiB**, and the
/// figure is worth spelling out because the obvious reading of it is wrong.
///
/// `drop(raw)` retires the `Vec<i16>` before the resample, so at most three
/// buffers coexist. The worst case is NOT at 16 kHz: there `resample_linear`
/// takes its input by value and the identity arm hands the same allocation
/// back, so the peak is 64 + 64 + 128 = 256 MiB and it falls at the DOWNMIX. One
/// hertz above, the identity arm is gone, a second 128 MiB output buffer is
/// allocated beside the mono one, and the peak is 64 + 128 + 128 = 320 MiB at
/// the RESAMPLE. 16 001 Hz is the worst admissible rate, not a pathological one:
/// the parse-time bound accepts a cap-sized clip there. A first draft of this
/// comment recorded 256 MiB by measuring only the identity path, which is the
/// one rate the by-value change makes special (myne-md/myne#510 review).
///
/// **This supersedes a picked 8 hours** (`WHISPER_SAMPLE_RATE * 60 * 60 * 8` =
/// 460.8 M samples), which was inert: the cap and the 4x clamp together put it
/// out of reach, so it never refused anything and its own test never reached the
/// branch it was named for. Its doc line also claimed 2.3 GiB where the
/// arithmetic gives 1.72 GiB. myne#510; the mobile twin derived the same value
/// first, in myne#485.
///
/// **The first draft of that mobile fix picked 30 minutes and was wrong**, which
/// is why this is derived rather than re-picked. A 32-minute mobile voice note
/// is about 61 MiB, attaches cleanly under the cap, syncs to this desktop, and
/// would have failed to transcribe with a message the user cannot act on. A
/// ceiling that refuses content a Myne client let the user create is a bug
/// wearing a guard's clothes.
const MAX_PCM_SAMPLES: usize = protocol::MAX_ATTACHMENT_LEN / 2;

/// The two constants the recorder duplicates, compared at compile time.
///
/// `capture.rs` cannot name `MAX_PCM_SAMPLES` or `WHISPER_SAMPLE_RATE`: it
/// compiles in every build and this module is behind the `local-inference`
/// feature, so a direct reference would tie the recorder's clip boundary to
/// whether the AI build was selected. The duplication is justified and the drift
/// is what has to be impossible.
///
/// Module scope, not the test module. Inside `#[cfg(test)]` this ran only under
/// `cargo test`; here it runs on every build that compiles this file, which is
/// every default build.
const _: () = assert!(
    crate::plugins::attachments::voice::capture::transcription_ceiling_samples() == MAX_PCM_SAMPLES,
    "the recorder derives the transcription ceiling independently; the two must agree"
);
const _: () = assert!(
    crate::plugins::attachments::voice::capture::transcription_sample_rate_hz()
        == WHISPER_SAMPLE_RATE,
    "the recorder derives the transcription rate independently; the two must agree"
);

/// Decode a canonical `audio/wav` byte stream to **16 kHz mono f32** PCM ready
/// for Whisper. Parse → downmix → resample. The single entry point the
/// `transcribe` command feeds the engine.
pub fn wav_to_mono_16k(bytes: &[u8]) -> Result<Vec<f32>, AudioError> {
    let raw = parse_wav(bytes)?;
    if raw.samples.is_empty() {
        return Err(AudioError::Empty);
    }
    let mono = downmix_to_mono_f32(&raw);
    // Each guard names its own refusal. Collapsing the resampler's error into
    // `BadLayout` merged two: a too-long clip surfaced as "malformed
    // channel/frame layout", which is the wrong sentence AND, once `commands.rs`
    // routes `TooLong` to `EngineError::AudioTooLong`, the wrong affordance.
    let rate = raw.sample_rate;
    // `raw` holds the `Vec<i16>` and is dead after the downmix. Dropping it here
    // keeps the i16 buffer, the mono f32 buffer and the resampler output from
    // coexisting: about 64 MiB of the worst case, and `commands.rs` already uses
    // this idiom one frame up.
    drop(raw);
    let out = resample_linear(mono, rate, WHISPER_SAMPLE_RATE)?;
    if out.is_empty() {
        return Err(AudioError::Empty);
    }
    Ok(out)
}

// The audio-decode error's mapping onto the engine taxonomy.
//
// **It lives here rather than beside `EngineError`, and that is the merge of
// myne-md/myne#510 and myne-md/myne#456 forcing a choice.** #510 wrote this impl
// in the desktop's own `local_inference/error.rs`, where `AudioError` and
// `EngineError` were siblings. #456 then moved `EngineError` into `myne-core`
// and deleted that file, while `AudioError` stayed here, because the decoder is
// desktop-side. An impl needs one of its two types to be local, and after the
// move the local one is `AudioError`, so the impl belongs in its module.
//
// Nothing about the mapping changed. What it buys is unchanged too, and is the
// reason it is exhaustive rather than a `match` at the call site: a ninth decode
// failure stops the build here instead of arriving at the user as "transcription
// failed, please try again", which is the collapse `AudioTooLong` exists to undo.
impl From<AudioError> for EngineError {
    /// One mapping, in one place, so a new [`AudioError`](AudioError)
    /// variant cannot quietly land in a catch-all.
    ///
    /// The obvious form is `map_err(|e| match e { TooLong => …, _ => … })` at the
    /// call site, and it is what this replaced. That shape compiles forever: a
    /// ninth decode failure compile-fails `AudioError::kind` in `audio.rs` and
    /// then arrives at the user as "transcription failed, please try again",
    /// which is the exact collapse `AudioTooLong` exists to undo. Written here
    /// and exhaustively, adding a variant stops the build at this match.
    fn from(e: AudioError) -> Self {
        match e {
            // Not worth retrying: the same clip is refused every time.
            AudioError::TooLong => EngineError::AudioTooLong,
            // Every other decode failure is a malformed or unsupported
            // container, which the surface reports as a generic failure.
            AudioError::NotWave
            | AudioError::NoFmtChunk
            | AudioError::NoDataChunk
            | AudioError::UnsupportedFormat
            | AudioError::UnsupportedBitDepth
            | AudioError::BadLayout
            | AudioError::Empty => EngineError::TranscriptionFailed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::attachments::voice::encoder::WAV_HEADER_LEN;

    /// Build a minimal canonical PCM WAV (44-byte header + i16 LE data), the
    /// exact shape the Myne encoder emits.
    fn build_wav(channels: u16, sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let bits = 16u16;
        let block_align = channels * bits / 8;
        // Saturating: a fixture may declare an absurd rate on purpose (the
        // myne#315 rejection cases), and the header field is not what is under
        // test there.
        let byte_rate = sample_rate.saturating_mul(block_align as u32);
        let data_len = (samples.len() * 2) as u32;
        let mut w = Vec::new();
        w.extend_from_slice(b"RIFF");
        w.extend_from_slice(&(36 + data_len).to_le_bytes());
        w.extend_from_slice(b"WAVE");
        w.extend_from_slice(b"fmt ");
        w.extend_from_slice(&16u32.to_le_bytes());
        w.extend_from_slice(&1u16.to_le_bytes()); // PCM
        w.extend_from_slice(&channels.to_le_bytes());
        w.extend_from_slice(&sample_rate.to_le_bytes());
        w.extend_from_slice(&byte_rate.to_le_bytes());
        w.extend_from_slice(&block_align.to_le_bytes());
        w.extend_from_slice(&bits.to_le_bytes());
        w.extend_from_slice(b"data");
        w.extend_from_slice(&data_len.to_le_bytes());
        for &s in samples {
            w.extend_from_slice(&s.to_le_bytes());
        }
        w
    }

    #[test]
    fn rejects_non_riff() {
        assert_eq!(
            wav_to_mono_16k(b"not a wav at all"),
            Err(AudioError::NotWave)
        );
        assert_eq!(wav_to_mono_16k(&[]), Err(AudioError::NotWave));
    }

    #[test]
    fn decodes_mono_16k_identity() {
        let samples = vec![0i16, 16384, -16384, 32767, -32768];
        let wav = build_wav(1, 16_000, &samples);
        let out = wav_to_mono_16k(&wav).expect("decode");
        assert_eq!(out.len(), samples.len(), "16k stays same length");
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-4); // 16384/32768
        assert!((out[4] - (-1.0)).abs() < 1e-6); // -32768/32768
    }

    #[test]
    fn downmixes_stereo_to_mono() {
        // Two frames: L/R = (100,300) -> 200 ; (0, -200) -> -100
        let interleaved = vec![100i16, 300, 0, -200];
        let wav = build_wav(2, 16_000, &interleaved);
        let out = wav_to_mono_16k(&wav).expect("decode");
        assert_eq!(out.len(), 2, "stereo collapses to mono frame count");
        assert!((out[0] - (200.0 / 32768.0)).abs() < 1e-4);
        assert!((out[1] - (-100.0 / 32768.0)).abs() < 1e-4);
    }

    #[test]
    fn resamples_48k_down_to_16k_by_one_third() {
        // 48 kHz -> 16 kHz is a 3:1 decimation; a 300-sample clip -> ~100.
        let samples: Vec<i16> = (0..300).map(|i| (i % 100) as i16).collect();
        let wav = build_wav(1, 48_000, &samples);
        let out = wav_to_mono_16k(&wav).expect("decode");
        assert!(
            (out.len() as i64 - 100).abs() <= 1,
            "expected ~100 samples, got {}",
            out.len()
        );
    }

    #[test]
    fn rejects_non_pcm_and_bad_bits() {
        // Hand-forge a fmt chunk with audio_format=3 (IEEE float) -> unsupported.
        let mut wav = build_wav(1, 16_000, &[1, 2, 3]);
        // audio_format is the 2 bytes right after "fmt "+size (offset 20).
        wav[20] = 3;
        wav[21] = 0;
        assert_eq!(wav_to_mono_16k(&wav), Err(AudioError::UnsupportedFormat));
    }

    #[test]
    fn a_wav_that_is_both_malformed_and_oversized_is_reported_as_malformed() {
        // The ordering finding. The layout check used to sit BELOW the size
        // projection, so a WAV that is both malformed and oversized returned
        // `TooLong`.
        //
        // That is not a tie broken arbitrarily. `TooLong` is the one refusal in
        // this enum that reaches the user as a specific sentence about the
        // clip's LENGTH, and it deliberately suppresses the retry, so saying it
        // about a file whose channel layout does not divide sends the user to
        // shorten something that will be refused at any length. The layout is a
        // fact about the header alone.
        //
        // Two channels and an ODD i16 count is the malformed half: 3 samples do
        // not divide by 2. A declared rate of 4 kHz is the oversized half, since
        // it is the lowest admissible rate and therefore the largest expansion,
        // and `frames` here is computed from a `data` length that the projection
        // would take at face value.
        //
        // Constructed at a size that is oversized by PROJECTION rather than by
        // allocation, so the test costs bytes rather than gigabytes: the
        // projection multiplies frames by 4 at this rate, so a `data` slice just
        // over `MAX_PCM_SAMPLES / 4` frames crosses the ceiling.
        let frames = (MAX_PCM_SAMPLES / 4) + 16;
        let odd_sample_count = frames * 2 + 1;
        let samples = vec![0i16; odd_sample_count];
        let wav = build_wav(2, 4_000, &samples);

        assert_eq!(
            parse_wav(&wav).map(|_| ()),
            Err(AudioError::BadLayout),
            "a malformed header must be diagnosed as malformed even when the \
             clip would also be refused for length"
        );
    }

    #[test]
    fn rejects_zero_sample_rate_without_panicking() {
        // A malformed `fmt ` chunk declaring sample_rate=0 must be rejected at
        // parse time — otherwise the resampler's `to_rate / 0` ratio overflows to
        // usize::MAX and `Vec::with_capacity` panics the transcribe worker.
        let wav = build_wav(1, 0, &[1i16, 2, 3, 4]);
        assert_eq!(wav_to_mono_16k(&wav), Err(AudioError::BadLayout));
    }

    // ── myne#315: zero was one value short of the problem ──────────────────
    //
    // `sample_rate = 1` is finite and "valid", and it expands the clip 16,000×
    // on the way to Whisper's 16 kHz. Neither outcome is catchable: where the
    // allocator refuses, `handle_alloc_error` ABORTS (not a panic, so the
    // `spawn_blocking` JoinError arm never runs); where the OS overcommits, the
    // fill loop touches every page and the process is OOM-killed. One synced
    // attachment could do it to every device that tried to transcribe it.
    #[test]
    fn rejects_an_absurdly_low_sample_rate_before_the_resampler_allocates() {
        for rate in [1u32, 2, 100, 3_999] {
            let wav = build_wav(1, rate, &[1i16, 2, 3, 4]);
            // The state, not only the return value: the refusal comes from
            // `parse_wav` itself, so `downmix_to_mono_f32` never allocates the
            // mono buffer and `resample_linear` is never reached with a length
            // derived from this rate.
            assert!(
                matches!(parse_wav(&wav), Err(AudioError::BadLayout)),
                "sample_rate={rate} must be refused inside parse_wav, before any \
                 buffer is sized from it"
            );
            assert_eq!(wav_to_mono_16k(&wav), Err(AudioError::BadLayout));
        }
    }

    #[test]
    fn rejects_an_absurdly_high_sample_rate_too() {
        // The other end bounds the CONTRACTION and keeps the ratio arithmetic
        // in a range worth reasoning about.
        for rate in [384_001u32, 10_000_000, u32::MAX] {
            let wav = build_wav(1, rate, &[1i16, 2, 3, 4]);
            assert!(matches!(parse_wav(&wav), Err(AudioError::BadLayout)));
            assert_eq!(wav_to_mono_16k(&wav), Err(AudioError::BadLayout));
        }
    }

    #[test]
    fn real_capture_rates_still_decode() {
        // The other direction, and the one nobody thinks to inject. The guard
        // must still ADMIT every rate the encoders actually produce: telephony,
        // the mobile WebView path (16 kHz, arriving here by sync), and
        // device-native desktop `cpal` capture.
        for rate in [8_000u32, 16_000, 22_050, 44_100, 48_000, 96_000, 192_000] {
            // A second of audio, so the downsample to 16 kHz still leaves
            // samples: 4 frames at 192 kHz round to zero output and would come
            // back `Empty` for reasons that have nothing to do with the guard.
            let samples: Vec<i16> = (0..rate as usize).map(|i| (i % 1000) as i16).collect();
            let wav = build_wav(1, rate, &samples);
            assert!(
                wav_to_mono_16k(&wav).is_ok(),
                "sample_rate={rate} is a real capture rate and must decode"
            );
        }
    }

    #[test]
    fn the_resampler_refuses_rather_than_truncating_past_its_ceiling() {
        // Both directions of the real `out_len > MAX_PCM_SAMPLES` comparison,
        // executed against the real constant. Refusal rather than truncation:
        // a silently shortened clip would transcribe the first fraction of the
        // audio and report it as the whole thing.
        //
        // The refuse case drives the bound through the RATIO, so a 2-sample
        // input crosses the ceiling and the branch runs without anything
        // materialising it. Doing it by input length instead means allocating
        // `MAX_PCM_SAMPLES` output samples, which at 4 bytes each is the whole
        // point of having a ceiling.
        //
        // The version this replaces asserted `is_some()` twice and then asserted
        // the constant's own value, so it never reached the branch it is named
        // for, and could not have, because the old picked ceiling was above
        // anything the attachment cap and the rate clamp could produce
        // (myne#510).
        //
        // Rates outside `parse_wav`'s clamp on purpose: this guard is defence
        // in depth, so it has to hold for a caller that did not come through
        // that clamp.
        assert_eq!(
            resample_linear(vec![0.0, 1.0], 1, u32::MAX),
            Err(AudioError::TooLong),
            "a projected length past the ceiling must be refused, not truncated"
        );

        // The accept direction, so the guard is not passing by rejecting
        // everything: a legal 4x expansion still decodes and the length is the
        // ratio, not a clamp.
        let out = resample_linear(vec![0.0f32; 4_000], 4_000, 16_000)
            .expect("a legal expansion well under the ceiling must decode");
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn a_zero_rate_is_refused_rather_than_slipping_through_a_nan() {
        // `0 / 0` is NaN and `NaN as usize` saturates to 0, so without the
        // explicit guard this call clears the ceiling and takes the identity arm
        // with its length never measured. Cheap to prove, unlike the ordering it
        // protects, so it is proved.
        // `BadLayout`, not `TooLong`: a zero rate is a malformed header, and
        // `TooLong`'s user-facing sentence is wrong for it.
        assert_eq!(
            resample_linear(vec![0.0, 1.0], 0, 0),
            Err(AudioError::BadLayout)
        );
        assert_eq!(
            resample_linear(vec![0.0, 1.0], 0, WHISPER_SAMPLE_RATE),
            Err(AudioError::BadLayout)
        );
        assert_eq!(
            resample_linear(vec![0.0, 1.0], WHISPER_SAMPLE_RATE, 0),
            Err(AudioError::BadLayout)
        );
    }

    #[test]
    fn the_two_ceilings_agree_so_the_resampler_never_fires_in_production() {
        // `parse_wav` rounds UP and `resample_linear` rounds to nearest, so
        // parse-time refusal must be the first to trigger for every rate. A
        // truncating `parse_wav` left a band where a clip passed the parse guard
        // and was then refused by the resampler, after the `Vec<i16>` and the
        // mono `Vec<f32>` were already built, which is exactly what the
        // parse-time placement exists to prevent.
        //
        // Checked over the whole clamp range at the frame count that sits on the
        // boundary for each rate, rather than at one hand-picked pair.
        // Driven through `projected_out_samples`, the function `parse_wav`
        // itself calls, so weakening the parser's rounding fails here. Restating
        // the arithmetic instead is a copy compared against a second copy and
        // stays green when the division is reverted to truncating.
        // `16_001` is load-bearing, not filler. It is the smallest rate above the
        // target, so the parse-time bound's `div_ceil` and the resampler's
        // `f64::round` disagree there by the widest relative margin the clamp
        // admits; every other entry is a real capture rate or a clamp endpoint.
        for rate in [
            4_000u32, 8_000, 11_025, 16_000, 16_001, 22_050, 44_100, 384_000,
        ] {
            let boundary =
                ((MAX_PCM_SAMPLES as u128 * rate as u128) / WHISPER_SAMPLE_RATE as u128) as usize;
            for f in [
                boundary.saturating_sub(1),
                boundary,
                boundary + 1,
                boundary + 2,
            ] {
                let parse_accepts = projected_out_samples(f, rate).expect("a non-zero rate")
                    <= MAX_PCM_SAMPLES as u128;
                // Both halves through the functions production uses, so
                // weakening EITHER rounding or EITHER comparison fails here.
                let resampled = resample_out_len(f, rate, WHISPER_SAMPLE_RATE);
                let resample_accepts = resampled.is_ok();
                let resample_len = match resampled {
                    Ok(n) => n.to_string(),
                    Err(e) => format!("refused ({e})"),
                };
                assert!(
                    !parse_accepts || resample_accepts,
                    "rate={rate} frames={f}: parse_wav accepts but resample_linear \
                     refuses at {resample_len}, so the refusal would land after the \
                     Vec<i16> and the mono Vec<f32> were already allocated"
                );
            }
        }
    }

    #[test]
    fn the_ceiling_is_high_enough_to_never_refuse_a_real_recording() {
        // Asserted against DURATIONS, not against the constant's own definition.
        // `MAX_PCM_SAMPLES` IS `protocol::MAX_ATTACHMENT_LEN / 2`, so the obvious
        // form (`MAX_PCM_SAMPLES >= MAX_ATTACHMENT_LEN / 2`) is a copy compared
        // against a second copy of itself: it can fail only if somebody
        // redefines the constant, never if the thing it protects moves.
        //
        // Two recordings, because desktop transcribes clips from both encoders.
        // The mobile WebView recorder writes 16 kHz mono with no duration cap
        // (`mobile/src/lib/voiceRecord.ts`), so a 32-minute voice note is about
        // 61 MiB, attaches cleanly under the § 9.9 cap and syncs here, so it is
        // the recording the first draft of the mobile fix actually refused, so
        // it is the number carrying information. The desktop `cpal` encoder
        // captures at 44.1/48 kHz, where the cap itself allows at most about
        // 12 min 41 s at 44.1 kHz and 11 min 39 s at 48 kHz, and that must project
        // under the ceiling too.
        let thirty_two_minutes_at_16k = 32 * 60 * WHISPER_SAMPLE_RATE as usize;
        assert!(
            MAX_PCM_SAMPLES >= thirty_two_minutes_at_16k,
            "a 32-minute 16 kHz mono recording is {thirty_two_minutes_at_16k} \
             frames, attaches cleanly under the § 9.9 cap and syncs to this \
             client, yet exceeds the ceiling ({MAX_PCM_SAMPLES}): the app would \
             refuse audio it let the user record"
        );

        // Spelled as a DURATION, not as `MAX_ATTACHMENT_LEN / 2`. That is the
        // definition of `MAX_PCM_SAMPLES`, so the assertion would reduce to
        // `ceil(N * 16000 / 44100) <= N`, true for every N at every rate above
        // 16 kHz and therefore unable to fail: the copy-against-a-copy shape
        // this test's own opening paragraph rejects. Twelve minutes is PAST the
        // § 9.9 cap at 48 kHz (11 min 39 s) and just inside it at 44.1 kHz
        // (12 min 41 s), so it is not the boundary an earlier version of this
        // comment claimed. It is a sanity bound on the longest desktop recording
        // worth defending, with roughly a 2.9x margin (11.52 M against a 33.55 M
        // ceiling); it fails if the ceiling drops under about 11.5 M samples, and
        // it is honest about being loose rather than presented as tight.
        // The largest clip a legal attachment can hold at the target rate, which
        // is the input the derivation was chosen to protect and clears the
        // ceiling by 22 frames (about 1.4 ms). The REFUSE direction at that
        // boundary is tested; without this the pair was asymmetric, so a change
        // to how the 44-byte WAV header is counted would flip the largest legal
        // phone-recorded voice note to permanently refused with nothing red.
        let largest_legal_frames = (protocol::MAX_ATTACHMENT_LEN - WAV_HEADER_LEN) / 2;
        let margin = MAX_PCM_SAMPLES as u128
            - projected_out_samples(largest_legal_frames, WHISPER_SAMPLE_RATE)
                .expect("a non-zero rate");
        assert_eq!(
            margin,
            (WAV_HEADER_LEN / 2) as u128,
            "the largest legal 16 kHz clip clears the ceiling by exactly the header's worth of \
             frames; if that margin moves, the header accounting moved with it"
        );

        for rate in [44_100u32, 48_000] {
            let twelve_minutes_of_frames = 12 * 60 * rate as usize;
            assert!(
                projected_out_samples(twelve_minutes_of_frames, rate).expect("a non-zero rate")
                    <= MAX_PCM_SAMPLES as u128,
                "a 12-minute {rate} Hz desktop recording projects past the \
                 ceiling, so the app would refuse audio its own encoder produced"
            );
        }
    }

    /// The ceiling and the attachment cap must stay in step. A compile-time
    /// assertion, because it is a claim about two constants and needs no runner.
    const _: () = assert!(
        MAX_PCM_SAMPLES == protocol::MAX_ATTACHMENT_LEN / 2,
        "the transcription ceiling is derived from the attachment cap; a second \
         literal here is the drift the derivation exists to prevent"
    );

    /// The recorder's clip boundary and this ceiling, checked against each other
    /// through the functions both actually use.
    ///
    /// This is the invariant myne-md/myne#510's review found broken: a ceiling
    /// that refuses audio the app itself recorded. `MAX_SAMPLES` is a sample
    /// count, so at 8 kHz one legal clip ran to 69 min 54 s against a ceiling of
    /// 34 min 57 s, and `CpalSource::start` takes whatever
    /// `default_input_config()` reports (Bluetooth HFP/SCO is 8 kHz on all three
    /// desktop platforms). Asserted over the rate range a capture device can
    /// actually report rather than at one pair, and driven through
    /// `max_samples_for_rate` and `projected_out_samples` so weakening either
    /// side fails here.
    #[test]
    fn no_clip_the_recorder_emits_can_exceed_the_ceiling() {
        use crate::plugins::attachments::voice::capture::{max_samples_for_rate, MAX_SAMPLES};

        for rate in [
            MIN_SAMPLE_RATE_HZ,
            8_000,
            11_025,
            WHISPER_SAMPLE_RATE,
            22_050,
            44_100,
            48_000,
            96_000,
            192_000,
            MAX_SAMPLE_RATE_HZ,
        ] {
            let frames = max_samples_for_rate(rate);
            assert!(
                projected_out_samples(frames, rate).expect("a non-zero rate")
                    <= MAX_PCM_SAMPLES as u128,
                "a full clip the recorder emits at {rate} Hz ({frames} frames) projects past the \
                 ceiling, so the app would permanently refuse to transcribe audio it recorded"
            );
            // And the other direction, so the clamp is not passing by refusing
            // to record: at or above the target rate the resample contracts, so
            // the § 9.9 blob cap must still be the binding one.
            if rate >= WHISPER_SAMPLE_RATE {
                assert_eq!(
                    frames, MAX_SAMPLES,
                    "at {rate} Hz the blob cap binds first; the transcription clamp must not \
                     shorten a clip it has no reason to"
                );
            }
        }

        // One frame past the boundary really is refused, at the rate that
        // motivated the clamp. Asserted through the projection rather than by
        // decoding, because materialising it is a 33 MB fixture.
        let boundary = max_samples_for_rate(8_000);
        assert!(
            projected_out_samples(boundary + 1, 8_000).expect("a non-zero rate")
                > MAX_PCM_SAMPLES as u128
        );
    }

    #[test]
    fn the_ceiling_is_low_enough_to_ever_refuse_anything() {
        // The property that would have caught myne#510 the day it shipped, and
        // the reason the constant is derived rather than picked.
        //
        // A WAV reaching this decoder is an attachment, so it is already bounded
        // by `protocol::MAX_ATTACHMENT_LEN` on the decode path. That many bytes
        // of mono 16-bit is the frame count below, and `parse_wav`'s rate clamp
        // holds the expansion to at most 4x (4 kHz is the floor, 16 kHz the
        // target). A ceiling at or above that product can never refuse anything:
        // it is a number in a file, not a guard. The superseded 460.8 M is on
        // the wrong side of it, which is exactly what myne#510 reported.
        let max_frames = protocol::MAX_ATTACHMENT_LEN / 2;
        let max_ratio = (WHISPER_SAMPLE_RATE / MIN_SAMPLE_RATE_HZ) as usize;
        let max_reachable_out = max_frames * max_ratio;
        assert!(
            MAX_PCM_SAMPLES < max_reachable_out,
            "MAX_PCM_SAMPLES ({MAX_PCM_SAMPLES}) is at or above the largest output \
             the attachment cap can produce ({max_reachable_out}), so it would \
             refuse nothing"
        );
    }

    /// The ceiling at a rate OTHER than 16 kHz, on both sides of the boundary.
    ///
    /// Everything else that varies the rate feeds one second of audio, so all of
    /// it clears the ceiling by about 2000x and exercises the CLAMP alone:
    /// lowering `MAX_PCM_SAMPLES` toward 20 000 left the whole suite green. And
    /// this is not a hypothetical shape. A 35-minute 8 kHz mono import is 32 MiB,
    /// comfortably under the § 9.9 cap, at a rate the real-capture test lists as
    /// real, and its projection to 16 kHz is past the ceiling: a legitimate
    /// recording this change refuses, which is why `commands.rs` owes it a
    /// distinct `EngineError` and the user guide owes it a cause.
    #[test]
    fn the_ceiling_binds_at_a_rate_below_the_target_too() {
        let rate = 8_000u32;
        // The exact frame count whose projection lands ON the ceiling.
        let boundary = MAX_PCM_SAMPLES / 2;
        assert_eq!(
            projected_out_samples(boundary, rate).expect("a non-zero rate"),
            MAX_PCM_SAMPLES as u128
        );
        assert!(
            projected_out_samples(boundary + 1, rate).expect("a non-zero rate")
                > MAX_PCM_SAMPLES as u128
        );

        // Accept one frame below, refuse one above. Asserted through the
        // projection rather than by decoding, because materialising either side
        // is a 67 MB fixture.
        assert!(
            projected_out_samples(boundary - 1, rate).expect("a non-zero rate")
                < MAX_PCM_SAMPLES as u128
        );
    }

    /// `wav_to_mono_16k`, not `parse_wav`: nothing else drives the PUBLIC entry
    /// point to `TooLong`, so without this the refusal would be proved only at
    /// an internal helper.
    ///
    /// It does NOT cover the mapping into `EngineError`. An earlier version of
    /// this comment claimed it did, and the claim was false in both halves: this
    /// test asserts a return value from this module and never touches the
    /// conversion, and the conversion has since moved out of `commands.rs` into
    /// `error.rs`. That is the shipped-inert-wiring signature one layer up from
    /// where the comment looked for it. The mapping is covered by
    /// `error.rs::audio_error_mapping_tests`.
    /// The REAL parser at a projection landing exactly ON the ceiling.
    ///
    /// `the_ceiling_binds_at_a_rate_below_the_target_too` computes the boundary
    /// with `projected_out_samples` and then asserts against `MAX_PCM_SAMPLES`,
    /// which is the rounding half of the predicate checked against the same
    /// constant the rounding was derived from. The comparison half lives inline
    /// in `parse_wav` (`projected > MAX_PCM_SAMPLES`), and every other test that
    /// touches the parse-time bound restates `<= MAX_PCM_SAMPLES` itself or
    /// drives the parser at `MAX_PCM_SAMPLES + 1`. So nothing drove the real
    /// parser at the boundary, and a predicate is a rounding AND a comparison:
    /// flipping `>` to `>=` was green across the whole suite.
    ///
    /// 8 kHz because it is the rate the projection actually binds at (telephony
    /// and Bluetooth HFP/SCO report it on all three platforms), and because the
    /// halving makes the boundary exact rather than a rounding artefact.
    #[test]
    fn the_real_parser_accepts_a_projection_landing_on_the_ceiling() {
        let rate = 8_000u32;
        let boundary_frames = MAX_PCM_SAMPLES / 2;
        // Precondition, so a change to either constant fails HERE with a clear
        // cause rather than silently making this test assert something else.
        assert_eq!(
            projected_out_samples(boundary_frames, rate).expect("a non-zero rate"),
            MAX_PCM_SAMPLES as u128,
            "the fixture no longer lands on the ceiling",
        );

        let header_bytes = build_wav(1, rate, &[]);
        let header = header_bytes.len();
        let data_len = boundary_frames * 2;
        let mut wav = vec![0u8; header + data_len];
        wav[..header].copy_from_slice(&header_bytes);
        wav[header - 4..header].copy_from_slice(&(data_len as u32).to_le_bytes());

        // Accepted: the bound is `>`, so landing ON it is legal. Flipping that
        // comparison to `>=` in `parse_wav` makes this the only test that fails.
        let out = wav_to_mono_16k(&wav).expect("a projection on the ceiling is accepted");
        assert_eq!(out.len(), MAX_PCM_SAMPLES);
    }

    #[test]
    fn the_public_entry_point_refuses_too_long_as_its_own_kind() {
        // `vec![0u8; n]`, not `resize`: in the unoptimized test profile `resize`
        // is a per-byte `ptr::write` loop (measured 222 ms against 0.86 ms for
        // the zeroed allocation), and `parse_wav` refuses without ever reading
        // the data body, so the calloc'd pages are never faulted in either.
        let header_bytes = build_wav(1, WHISPER_SAMPLE_RATE, &[]);
        let header = header_bytes.len();
        let data_len = (MAX_PCM_SAMPLES + 1) * 2;
        let mut wav = vec![0u8; header + data_len];
        wav[..header].copy_from_slice(&header_bytes);
        wav[header - 4..header].copy_from_slice(&(data_len as u32).to_le_bytes());
        assert_eq!(wav_to_mono_16k(&wav), Err(AudioError::TooLong));
    }

    #[test]
    fn the_ceiling_also_binds_a_clip_that_needs_no_resampling() {
        // The identity fast-path, which on desktop is every phone-recorded voice
        // note: the mobile WebView recorder writes 16 kHz, those clips arrive
        // here by sync, and `from_rate == to_rate` is what they take. A ceiling
        // checked after that branch exempted exactly that input, which is how a
        // bound ends up describing everything except a normal case.
        //
        // The `data` chunk has to really be there: the walker clamps a
        // truncated trailing chunk to EOF, so a merely DECLARED length would be
        // measured as zero and this test would pass while proving nothing.
        // Built as one zeroed `resize` rather than `MAX_PCM_SAMPLES` pushes, and
        // `parse_wav` refuses before the `Vec<i16>`, so the cost is a single
        // `(MAX_PCM_SAMPLES + 1) * 2`-byte buffer (64 MiB at the current
        // constant) and no output vector at all. Stated symbolically on purpose.
        let data_len = (MAX_PCM_SAMPLES + 1) * 2;
        let header_bytes = build_wav(1, WHISPER_SAMPLE_RATE, &[]);
        let header = header_bytes.len();
        // `vec![0u8; n]` rather than `resize`, for the reason given on the
        // sibling fixture: `resize` is a per-byte write loop in the test profile.
        let mut wav = vec![0u8; header + data_len];
        wav[..header].copy_from_slice(&header_bytes);
        wav[4..8].copy_from_slice(&((36 + data_len) as u32).to_le_bytes());
        wav[header - 4..header].copy_from_slice(&(data_len as u32).to_le_bytes());
        assert!(
            matches!(parse_wav(&wav), Err(AudioError::TooLong)),
            "a 16 kHz clip past the ceiling must be refused before it is decoded"
        );
    }

    #[test]
    fn skips_unknown_chunk_before_data() {
        // Insert a LIST chunk between fmt and data; the walker must skip it.
        let samples = vec![1000i16, -1000, 500];
        let base = build_wav(1, 16_000, &samples);
        // base layout: [0..44) header incl. "data"+len at [36..44); data after.
        let header = &base[..36]; // through end of fmt chunk
        let data_hdr = &base[36..44]; // "data"+len
        let data_body = &base[44..];
        let list_body = b"INFOxxxx"; // 8 bytes, even
        let mut w = Vec::new();
        w.extend_from_slice(header);
        w.extend_from_slice(b"LIST");
        w.extend_from_slice(&(list_body.len() as u32).to_le_bytes());
        w.extend_from_slice(list_body);
        w.extend_from_slice(data_hdr);
        w.extend_from_slice(data_body);
        // Fix the RIFF size field.
        let riff_size = (w.len() - 8) as u32;
        w[4..8].copy_from_slice(&riff_size.to_le_bytes());
        let out = wav_to_mono_16k(&w).expect("decode with interleaved LIST chunk");
        assert_eq!(out.len(), samples.len());
    }
}

#[cfg(test)]
mod audio_error_mapping_tests {
    use super::*;
    use myne_core::inference::error::EngineError;

    /// The split, not the mapping.
    ///
    /// This existed as a `map_err` catch-all at the call site and had no test on
    /// either side, which myne-md/myne#510's review proved by injection:
    /// rewriting the arm to `TooLong => TranscriptionFailed` left the whole
    /// desktop lib suite green (1228 passed), clippy clean, and the JS taxonomy
    /// drift-lock unmoved, because that lock parses `kind()`'s arms and
    /// `AudioTooLong` is still one of them. The four-layer chain from the decoder
    /// to the user's sentence collapsed with nothing red.
    ///
    /// So both directions are asserted. The refusal maps to its own variant, and
    /// a sibling decode failure does not: a test that only checked the first
    /// would pass against a `From` that answered `AudioTooLong` for everything.
    #[test]
    fn too_long_maps_to_its_own_engine_error_and_nothing_else_does() {
        assert_eq!(
            EngineError::from(AudioError::TooLong),
            EngineError::AudioTooLong
        );
        for other in [
            AudioError::NotWave,
            AudioError::NoFmtChunk,
            AudioError::NoDataChunk,
            AudioError::UnsupportedFormat,
            AudioError::UnsupportedBitDepth,
            AudioError::BadLayout,
            AudioError::Empty,
        ] {
            assert_eq!(
                EngineError::from(other),
                EngineError::TranscriptionFailed,
                "{other:?} is a malformed-container failure and must stay retryable"
            );
        }
    }

    /// The tag the frontend keys off, so the Rust half of the wire is pinned to
    /// the string `src/lib/transcribe.ts` normalizes.
    #[test]
    fn the_too_long_kind_tag_is_the_one_the_frontend_maps() {
        assert_eq!(EngineError::AudioTooLong.kind(), "audio_too_long");
    }
}
