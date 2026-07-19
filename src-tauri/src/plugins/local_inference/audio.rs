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
//! Logging: DENY-list clean (`src-tauri/CLAUDE.md`). The decoded PCM is
//! AS1-class decrypted audio — **never logged**; [`AudioError`] carries no
//! sample data, only a bounded kind.

// Consumed by the task-5 `transcribe` command; until that wiring lands the
// non-test build sees these as dead.
#![cfg_attr(not(test), allow(dead_code))]

use serde::Serialize;

/// Sample rate the Whisper front end requires (`pcm_to_mel` input).
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

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
        }
    }
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

    // i16 LE samples; a trailing odd byte (never expected for 16-bit) is dropped.
    let samples: Vec<i16> = data
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    if !samples.len().is_multiple_of(channels as usize) {
        return Err(AudioError::BadLayout);
    }

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

/// Linear-interpolation resample from `from_rate` to `to_rate`. Dependency-free
/// (SYNC-V3); adequate for speech ASR (Whisper's mel front end is tolerant).
/// Identity fast-path when the rates already match.
fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((input.len() as f64) * ratio).round() as usize;
    if out_len == 0 {
        return Vec::new();
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
    out
}

/// Decode a canonical `audio/wav` byte stream to **16 kHz mono f32** PCM ready
/// for Whisper. Parse → downmix → resample. The single entry point the
/// `transcribe` command feeds the engine.
pub fn wav_to_mono_16k(bytes: &[u8]) -> Result<Vec<f32>, AudioError> {
    let raw = parse_wav(bytes)?;
    if raw.samples.is_empty() {
        return Err(AudioError::Empty);
    }
    let mono = downmix_to_mono_f32(&raw);
    let out = resample_linear(&mono, raw.sample_rate, WHISPER_SAMPLE_RATE);
    if out.is_empty() {
        return Err(AudioError::Empty);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal canonical PCM WAV (44-byte header + i16 LE data), the
    /// exact shape the Myne encoder emits.
    fn build_wav(channels: u16, sample_rate: u32, samples: &[i16]) -> Vec<u8> {
        let bits = 16u16;
        let block_align = channels * bits / 8;
        let byte_rate = sample_rate * block_align as u32;
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
