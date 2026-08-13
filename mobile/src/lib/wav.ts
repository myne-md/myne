// Voice-note WAV container encoder (mobile counterpart of the desktop Rust
// `src-tauri/src/plugins/attachments/voice/encoder.rs::encode_wav`, MYND-259).
//
// A hand-rolled canonical 44-byte-header PCM WAV writer — no codec dependency
// (a dependency is a security decision; WAV is a header we own). The mobile
// recorder captures raw PCM in the WebView (Web Audio), converts to mono 16-bit,
// and wraps it here so a stored recording is byte-structurally identical to a
// desktop-recorded one: the shared `myne-core` sniffer recognizes the emitted
// `RIFF`…`WAVE` container as `audio/wav`, so it imports + serves + syncs +
// cross-fleet-plays with ZERO backend change. Deliberately audio/wav (not a
// compressed MediaRecorder container) so an Android-recorded note plays on the
// user's iPhone/Mac too — WebM/Opus does not play in Apple WebViews.
//
// Pure — no DOM, no IPC — so the framing is unit-testable in isolation.

/** Canonical PCM WAV header length (RIFF + fmt + data chunk headers). */
export const WAV_HEADER_LEN = 44;

/** Encode `channels`×16-bit PCM `samples` as a canonical WAV byte buffer at
 *  `sampleRate`. Little-endian throughout, PCM format tag (1). Mirrors the Rust
 *  `encode_wav` byte-for-byte. */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const BITS_PER_SAMPLE = 16;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataLen = samples.length * 2;
  // RIFF chunk size = 4 ("WAVE") + (8 + 16 fmt) + (8 + data_len).
  const riffLen = 36 + dataLen;

  const out = new Uint8Array(WAV_HEADER_LEN + dataLen);
  const view = new DataView(out.buffer);
  let o = 0;
  const putAscii = (s: string) => {
    for (let i = 0; i < s.length; i++) out[o++] = s.charCodeAt(i);
  };
  const putU32 = (n: number) => {
    view.setUint32(o, n >>> 0, true);
    o += 4;
  };
  const putU16 = (n: number) => {
    view.setUint16(o, n & 0xffff, true);
    o += 2;
  };

  putAscii("RIFF");
  putU32(riffLen);
  putAscii("WAVE");
  // fmt sub-chunk
  putAscii("fmt ");
  putU32(16); // PCM fmt chunk size
  putU16(1); // audio format = PCM
  putU16(channels);
  putU32(sampleRate);
  putU32(byteRate);
  putU16(blockAlign);
  putU16(BITS_PER_SAMPLE);
  // data sub-chunk
  putAscii("data");
  putU32(dataLen);
  // PCM samples (little-endian 16-bit).
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(o, samples[i], true);
    o += 2;
  }
  return out;
}

/** Downmix + resample interleaved Float32 capture buffers to a single mono
 *  16-bit PCM stream at `targetRate`. Nearest-neighbour resample is adequate for
 *  a voice note (speech, not music); it keeps the file small (a WAV at the
 *  device-native 44.1/48 kHz would be ~3× larger for no perceptible gain). */
export function floatToMono16(
  chunks: Float32Array[],
  sourceRate: number,
  targetRate: number,
): Int16Array {
  // Concatenate the captured mono float frames.
  let total = 0;
  for (const c of chunks) total += c.length;
  const mono = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    mono.set(c, at);
    at += c.length;
  }

  // Resample (nearest source frame) when the context rate differs from target.
  const ratio = sourceRate / targetRate;
  const outLen = ratio > 0 ? Math.floor(mono.length / ratio) : mono.length;
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = mono[Math.floor(i * ratio)] ?? 0;
    // Clamp to [-1, 1] then scale to the full 16-bit signed range.
    const s = src < -1 ? -1 : src > 1 ? 1 : src;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH-MM-SS` in local time — mirrors the desktop
 *  `editor/src/attachments/insert.ts::fileNameTimestamp`. */
export function fileNameTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`
  );
}

/** Auto-name a recording `Voice note YYYY-MM-DD HH-MM-SS.wav` — the same scheme
 *  the desktop `voiceNoteFilename` uses, so a note reads identically on any
 *  client. `now`-injectable for deterministic tests. */
export function voiceNoteFilename(now: Date): string {
  return `Voice note ${fileNameTimestamp(now)}.wav`;
}
