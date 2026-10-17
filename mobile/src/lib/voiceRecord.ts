// Mobile voice-note capture controller (MYND — mobile voice notes).
//
// The mobile analog of the desktop `editor/src/attachments/voiceRecord.ts`. The
// desktop records with a native `cpal` mic (Rust-side, zeroizable PCM); that
// crate does NOT cross-compile as a mic source for iOS/Android, so mobile
// captures raw PCM in the WebView via the Web Audio API (`getUserMedia` +
// `ScriptProcessorNode`), wraps it as `audio/wav` (`./wav`), and hands the File
// to the existing `attachment_import` bytes path — SAME MYA1 blob, SAME form-C
// embed, SAME cross-fleet playback as desktop, with zero backend change.
//
// This module is HEADLESS: it owns the mic + PCM buffer + level meter, but the
// UI (record bar, timer, Stop) lives in `RecordingSheet.tsx`, which drives this
// handle. The encoded WAV lives briefly in the JS heap (not zeroizable, unlike
// desktop's Rust PCM) — an accepted mobile-stack consequence documented in the
// main repo `docs/decisions.md` 2026-07-12: the WebView already holds every
// note's plaintext and every imported attachment's bytes, so a voice clip is the
// same trust class, not a new exposure.

import { encodeWav, floatToMono16, voiceNoteFilename } from "./wav";

/** Voice notes are speech, not music — 16 kHz mono keeps a 2-minute clip ≈ 3.8 MB
 *  (far under the 64 MiB import cap) with no perceptible quality loss. */
const TARGET_SAMPLE_RATE = 16_000;

/** The classified reason a capture could not start / continue. Drives the
 *  RecordingSheet UX (permission-denied → the SYS-02 "Microphone access is off"
 *  state; everything else → an inline error). */
export type VoiceCaptureErrorKind =
  | "permissionDenied"
  | "noInputDevice"
  | "captureBusy"
  | "unsupported"
  | "empty"
  | "generic";

export class VoiceCaptureError extends Error {
  readonly kind: VoiceCaptureErrorKind;
  constructor(kind: VoiceCaptureErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "VoiceCaptureError";
    this.kind = kind;
  }
}

/** Map a `getUserMedia` rejection (a DOMException) to our closed error kind. */
function classifyGetUserMediaError(err: unknown): VoiceCaptureErrorKind {
  const name = err !== null && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "permissionDenied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "noInputDevice";
    case "NotReadableError":
    case "AbortError":
      return "captureBusy";
    default:
      return "generic";
  }
}

/** A live capture. `stop()` finalizes to a WAV `File`; `cancel()` discards. */
export interface VoiceCaptureHandle {
  /** Subscribe to the input level (0..1 RMS) for the waveform meter. */
  onLevel(cb: (level: number) => void): void;
  /** Stop, encode the captured PCM as `audio/wav`, and return it as a File.
   *  Rejects `VoiceCaptureError("empty")` when nothing was captured. */
  stop(): Promise<File>;
  /** Abort and release the mic without producing a file. Idempotent. */
  cancel(): void;
}

// One recording at a time, app-wide (mirrors the desktop single-recording rule).
let active = false;

/** Whether a recording is currently in progress. */
export function isRecording(): boolean {
  return active;
}

/** Request the mic and begin capturing. Rejects with a `VoiceCaptureError`
 *  (`unsupported` if the WebView has no `getUserMedia`, `permissionDenied` if the
 *  user/OS denies, etc.) — the caller shows the matching UX. */
export async function startVoiceCapture(): Promise<VoiceCaptureHandle> {
  if (active) throw new VoiceCaptureError("captureBusy", "already recording");

  // iOS WKWebView exposed `mediaDevices` only from ~14.3 secure contexts; a
  // missing API is the one hard smoke-test failure — surface it as `unsupported`
  // rather than a cryptic TypeError.
  const md = navigator.mediaDevices;
  if (!md || typeof md.getUserMedia !== "function") {
    throw new VoiceCaptureError("unsupported", "getUserMedia unavailable in this WebView");
  }

  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({ audio: true });
  } catch (err) {
    throw new VoiceCaptureError(classifyGetUserMediaError(err), "getUserMedia rejected");
  }

  active = true;

  const AudioCtor: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  const ctx = new AudioCtor();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it needs no
  // separately-bundled worklet module and works uniformly across WKWebView +
  // Android WebView + desktop Chromium — the right robustness trade for v1.
  const proc = ctx.createScriptProcessor(4096, 1, 1);

  const chunks: Float32Array[] = [];
  let levelCb: ((level: number) => void) | null = null;
  let finished = false;

  proc.onaudioprocess = (e: AudioProcessingEvent) => {
    if (finished) return;
    const input = e.inputBuffer.getChannelData(0);
    // COPY — the input buffer is reused across callbacks.
    chunks.push(new Float32Array(input));
    if (levelCb) {
      let sumSq = 0;
      for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
      levelCb(Math.min(1, Math.sqrt(sumSq / input.length) * 4)); // ×4: perceptual gain
    }
  };

  // ScriptProcessor only fires while connected to the graph destination. We never
  // write `e.outputBuffer`, so the node emits silence — no mic feedback loop.
  source.connect(proc);
  proc.connect(ctx.destination);

  const teardown = () => {
    finished = true;
    proc.onaudioprocess = null;
    try {
      source.disconnect();
      proc.disconnect();
    } catch {
      /* already disconnected */
    }
    stream.getTracks().forEach((t) => t.stop()); // release mic + clear the iOS recording indicator
    void ctx.close().catch(() => undefined);
    active = false;
  };

  return {
    onLevel(cb) {
      levelCb = cb;
    },
    async stop() {
      if (finished) throw new VoiceCaptureError("generic", "already stopped");
      const sourceRate = ctx.sampleRate;
      teardown();
      const pcm = floatToMono16(chunks, sourceRate, TARGET_SAMPLE_RATE);
      if (pcm.length === 0) throw new VoiceCaptureError("empty", "no audio captured");
      const wav = encodeWav(pcm, TARGET_SAMPLE_RATE, 1);
      // `File` extends `Blob`; back it with the WAV's own ArrayBuffer (the
      // Uint8Array owns its full buffer, so no copy). The bytes then flow through
      // `importFile` → `attachment_import` (the `bytes_b64` arm, which is the one
      // that does not make the WebView materialize a number per byte).
      return new File([wav.buffer as ArrayBuffer], voiceNoteFilename(new Date()), { type: "audio/wav" });
    },
    cancel() {
      if (finished) return;
      teardown();
    },
  };
}
