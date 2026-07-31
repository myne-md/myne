// Shared transcription IPC wrapper (voice-to-text MYND-552; SYNC-V5/V6/V9).
//
// The SINGLE call path to the local-inference `transcribe` command, used by BOTH
// the in-note audio widget (through the `EditorHost.transcribe` slot) and the
// Attachments Library (SYNC-V9) so neither surface grows a divergent call path.
// It opens a per-segment streaming `Channel<string>` (SYNC-V5) feeding
// `onSegment`, and resolves with the FULL transcript when transcription ends.
//
// Cancellation rides the shared local-inference cancel token (the same one
// `chat_stop` fires), so `stop()` aborts an in-flight run without a dedicated
// command. The decrypted PCM + transcript never leave Rust except as this final
// string / the streamed segments — AS1-class content, never logged here.

import { Channel, invoke } from "../platform/core";
import { engineErrorTag } from "./engine-error";

/** A normalized transcription failure. `kind: "not_ready"` = AI off / no
 *  transcription model side-loaded (SYNC-V3 — surface a "select a model" hint);
 *  `"failed"` = any other engine / decrypt / decode failure. */
export interface TranscribeError {
  readonly kind: "not_ready" | "failed";
}

/** A running transcription. `done` resolves with the full transcript and rejects
 *  with a {@link TranscribeError}; `stop()` cancels via the shared cancel token. */
export interface TranscribeRun {
  readonly done: Promise<string>;
  stop: () => void;
}

/** Start transcribing audio attachment `attachmentId`. `onSegment` (optional)
 *  receives each streamed per-segment partial transcript (SYNC-V5). */
export function startTranscription(
  attachmentId: string,
  onSegment?: (segment: string) => void,
): TranscribeRun {
  const channel = new Channel<string>();
  if (onSegment !== undefined) channel.onmessage = (segment) => onSegment(segment);

  const done = invoke<string>("plugin:local-inference|transcribe", {
    attachmentId,
    onSegment: channel,
  }).catch((raw: unknown) => {
    throw normalizeTranscribeError(raw);
  });

  return {
    done,
    stop: () => {
      // The shared cancel token (also fired by `chat_stop`) aborts the run; a
      // missing command (AI-free build) or a benign race is non-fatal.
      void invoke("plugin:local-inference|chat_stop").catch(() => {});
    },
  };
}

/** Map the raw IPC rejection (a serialized `EngineError` — see
 *  {@link engineErrorTag}) to a normalized kind. Anything not clearly not-ready
 *  degrades to `"failed"`. */
function normalizeTranscribeError(raw: unknown): TranscribeError {
  const tag = engineErrorTag(raw);
  const notReady = tag === "NotReady" || tag === "not_ready";
  return { kind: notReady ? "not_ready" : "failed" };
}
