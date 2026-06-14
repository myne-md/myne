//! WAV/PCM encoder for voice notes (MYND-259).
//!
//! A hand-rolled canonical 44-byte-header PCM WAV writer — no `hound`/codec
//! dependency (a dependency is a security decision; WAV is a header we own).
//! v0.1 records mono 16-bit at the device-native sample rate; the `Encoder`
//! seam exists so a future `OpusEncoder` is a localized swap, not a rewrite.
//!
//! The sniffer recognizes the emitted `RIFF`…`WAVE` container as `audio/wav`
//! so a stored recording renders inline as a voice note.

/// Canonical PCM WAV header length (RIFF + fmt + data chunk headers).
pub const WAV_HEADER_LEN: usize = 44;

/// Encode mono/`channels` 16-bit PCM `samples` as a canonical WAV byte buffer
/// at `sample_rate`. Little-endian throughout, PCM format tag (1).
pub fn encode_wav(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    const BITS_PER_SAMPLE: u16 = 16;
    let bytes_per_sample = u32::from(BITS_PER_SAMPLE) / 8;
    let byte_rate = sample_rate * u32::from(channels) * bytes_per_sample;
    let block_align = channels * (BITS_PER_SAMPLE / 8);
    let data_len = samples.len() * 2;
    // RIFF chunk size = 4 ("WAVE") + (8 + 16 fmt) + (8 + data_len).
    let riff_len = 36 + data_len;

    let mut out = Vec::with_capacity(WAV_HEADER_LEN + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(riff_len as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    // fmt sub-chunk
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    // data sub-chunk
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u32_le(bytes: &[u8]) -> u32 {
        u32::from_le_bytes(bytes.try_into().unwrap())
    }
    fn u16_le(bytes: &[u8]) -> u16 {
        u16::from_le_bytes(bytes.try_into().unwrap())
    }

    #[test]
    fn header_is_canonical_riff_wave() {
        let wav = encode_wav(&[0, 0, 0], 48_000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
    }

    #[test]
    fn header_fields_match_inputs() {
        let samples = [1i16, -1, 2, -2, 3];
        let wav = encode_wav(&samples, 44_100, 1);
        // fmt: PCM(1), 1 channel, 44100 Hz, 16-bit.
        assert_eq!(u16_le(&wav[20..22]), 1); // PCM
        assert_eq!(u16_le(&wav[22..24]), 1); // channels
        assert_eq!(u32_le(&wav[24..28]), 44_100); // sample rate
        assert_eq!(u32_le(&wav[28..32]), 44_100 * 2); // byte rate (mono 16-bit)
        assert_eq!(u16_le(&wav[32..34]), 2); // block align
        assert_eq!(u16_le(&wav[34..36]), 16); // bits per sample
                                              // data chunk size = samples * 2 bytes.
        assert_eq!(u32_le(&wav[40..44]), (samples.len() * 2) as u32);
        assert_eq!(wav.len(), WAV_HEADER_LEN + samples.len() * 2);
    }

    #[test]
    fn samples_round_trip_little_endian() {
        let samples = [0i16, 32_767, -32_768, 1234, -4321];
        let wav = encode_wav(&samples, 16_000, 1);
        let decoded: Vec<i16> = wav[WAV_HEADER_LEN..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(decoded, samples);
    }

    #[test]
    fn empty_samples_yield_header_only() {
        let wav = encode_wav(&[], 48_000, 1);
        assert_eq!(wav.len(), WAV_HEADER_LEN);
        assert_eq!(u32_le(&wav[40..44]), 0); // data size 0
    }
}
