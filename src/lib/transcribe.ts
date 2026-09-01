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
import { engineErrorTag, snakeCase } from "./engine-error";

/** Normalized transcription-failure cause (MYND-591). Each value except
 *  `"failed"` maps 1:1 to a distinct `EngineError` the transcribe command can
 *  return, so each surface renders the truthful reason instead of a hardcoded
 *  "no model" guess:
 *  - `"feature_off"`      — speech-to-text is switched off
 *  - `"vault_locked"`     — no unlocked vault / key material
 *  - `"no_model"`         — no transcription model available at all
 *  - `"model_load_failed"`— a model is present but could not be loaded
 *  - `"too_long"`         the clip is longer than the decoder will decode.
 *                           The same clip is refused every time, so the generic
 *                           "Please try again" copy would be advice that cannot
 *                           work (myne#510)
 *  - `"failed"`           — any other engine / decrypt / decode failure. */
export type TranscribeErrorKind =
  | "feature_off"
  | "vault_locked"
  | "no_model"
  | "model_load_failed"
  | "too_long"
  | "failed";

export interface TranscribeError {
  readonly kind: TranscribeErrorKind;
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

/** Serialized-`EngineError` tag → normalized cause.
 *
 *  Two spellings reach this seam: Tauri serializes a unit variant as its
 *  identifier (`AudioTooLong`) while `EngineError::kind` emits snake_case
 *  (`audio_too_long`). The tag is normalized through {@link snakeCase} first
 *  rather than written twice, which is the shape `normalizeProviderError` was
 *  refactored into for the reason stated there: hand-writing both rows put a
 *  silent fall-through to `"failed"` one transcription error away, twice per
 *  cause. This table went from ten rows to six by adopting it.
 *
 *  A `Map`, not an object literal, for that module's other stated reason: an
 *  object's lookup walks `Object.prototype`, so a tag of `constructor` or
 *  `toString` would resolve to a truthy function and be returned as a cause.
 *
 *  A pre-MYND-591 backend collapsed every cause into `NotReady`, whose
 *  historical copy said "select a model", so legacy `not_ready` maps to
 *  `"no_model"`. */
const CAUSE_BY_TAG = new Map<string, TranscribeErrorKind>([
  ["feature_off", "feature_off"],
  ["vault_locked", "vault_locked"],
  ["no_model", "no_model"],
  ["model_load_failed", "model_load_failed"],
  ["audio_too_long", "too_long"],
  ["not_ready", "no_model"], // legacy skew fallback
]);

/** Map the raw IPC rejection (a serialized `EngineError` — a bare variant string
 *  like `"NoModel"`, or a `{ kind }` object) to a normalized cause. Anything
 *  unrecognized (including `"TranscriptionFailed"`) degrades to `"failed"`. */
export function normalizeTranscribeError(raw: unknown): TranscribeError {
  const tag = snakeCase(engineErrorTag(raw));
  return { kind: CAUSE_BY_TAG.get(tag) ?? "failed" };
}
