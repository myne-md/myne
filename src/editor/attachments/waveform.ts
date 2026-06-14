// Waveform peak extraction for the inline audio player (voice notes, MYND-259).
//
// Two layers:
//   - `downsamplePeaks` — a PURE function (raw PCM samples → N normalized peak
//     heights). No browser APIs; this is the Vitest-covered behavior.
//   - `decodePeaks` — the browser glue: fetch the decrypted `attachment://`
//     bytes, `decodeAudioData` them, downsample channel 0, and CACHE the result
//     keyed by the (content-addressed) url so a re-render or a second embed of
//     the same clip never re-decodes. Not unit-tested (needs Web Audio).
//
// Playback necessarily decrypts audio into the WebView (you cannot visualize or
// play a clip without decoding it), so the peaks live in WebView memory — the
// same accepted playback-residue posture as the `<audio>` element itself
// (threat-model A6/A7/A10, decisions.md voice-notes entry). No plaintext on
// disk; the bytes come from the in-memory `attachment://` handler.

/**
 * Downsample raw mono PCM `samples` to `buckets` peak heights in `[0, 1]`,
 * normalized so the loudest bucket is 1 (visual height is independent of the
 * recording's gain). Each bucket is the max absolute amplitude over its slice.
 * Returns `[]` for an empty input or a non-positive bucket count. All-silence
 * input yields all-zero peaks (no divide-by-zero).
 */
export function downsamplePeaks(samples: Float32Array, buckets: number): number[] {
  if (buckets <= 0 || samples.length === 0) return [];
  const peaks = new Array<number>(buckets).fill(0);
  const blockSize = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * blockSize);
    const end = Math.min(samples.length, Math.floor((b + 1) * blockSize));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const amp = Math.abs(samples[i]);
      if (amp > peak) peak = amp;
    }
    peaks[b] = peak;
  }
  const max = peaks.reduce((m, p) => (p > m ? p : m), 0);
  if (max > 0) {
    for (let b = 0; b < buckets; b++) peaks[b] /= max;
  }
  return peaks;
}

/** Decoded-peak cache, keyed by `url#buckets`. The url carries the
 *  content-addressed attachment-id, so identical audio shares one entry. */
const peakCache = new Map<string, number[]>();

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Fetch the decrypted audio at `url` (the `attachment://<id>` handler),
 * decode it, and return `buckets` normalized peak heights. Cached by
 * `url#buckets`. Rejects if the environment has no Web Audio or decode fails —
 * callers fall back to the plain progress bar.
 */
export async function decodePeaks(url: string, buckets: number): Promise<number[]> {
  const cacheKey = `${url}#${buckets}`;
  const cached = peakCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const Ctor = audioContextCtor();
  if (Ctor === null) throw new Error("Web Audio unavailable");

  const resp = await fetch(url);
  const bytes = await resp.arrayBuffer();
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    // Channel 0 — our recordings are mono; for any stereo import the left
    // channel is a faithful-enough envelope for a thumbnail waveform.
    const channel = decoded.getChannelData(0);
    const peaks = downsamplePeaks(channel, buckets);
    peakCache.set(cacheKey, peaks);
    return peaks;
  } finally {
    void ctx.close();
  }
}
