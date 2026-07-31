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

/** Normalized transcription-failure cause (MYND-591). Each value except
 *  `"failed"` maps 1:1 to a distinct `EngineError` the transcribe command can
 *  return, so each surface renders the truthful reason instead of a hardcoded
 *  "no model" guess:
 *  - `"feature_off"`      — speech-to-text is switched off
 *  - `"vault_locked"`     — no unlocked vault / key material
 *  - `"no_model"`         — no transcription model available at all
 *  - `"model_load_failed"`— a model is present but could not be loaded
 *  - `"failed"`           — any other engine / decrypt / decode failure. */
export type TranscribeErrorKind =
  | "feature_off"
  | "vault_locked"
  | "no_model"
  | "model_load_failed"
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

/** Serialized-`EngineError` tag → normalized cause. Accepts the bare PascalCase
 *  variant string (the unit-variant serde form the command actually returns) and
 *  a defensive snake_case `{ kind }` object. A pre-MYND-591 backend collapsed
 *  every cause into `NotReady`, whose historical copy said "select a model", so
 *  legacy `NotReady` maps to `"no_model"`. */
const CAUSE_BY_TAG: Readonly<Record<string, TranscribeErrorKind>> = {
  FeatureOff: "feature_off",
  feature_off: "feature_off",
  VaultLocked: "vault_locked",
  vault_locked: "vault_locked",
  NoModel: "no_model",
  no_model: "no_model",
  ModelLoadFailed: "model_load_failed",
  model_load_failed: "model_load_failed",
  NotReady: "no_model", // legacy skew fallback
  not_ready: "no_model",
};

/** Map the raw IPC rejection (a serialized `EngineError` — a bare variant string
 *  like `"NoModel"`, or a `{ kind }` object) to a normalized cause. Anything
 *  unrecognized (including `"TranscriptionFailed"`) degrades to `"failed"`. */
export function normalizeTranscribeError(raw: unknown): TranscribeError {
  const tag = engineErrorTag(raw);
  return { kind: CAUSE_BY_TAG[tag] ?? "failed" };
}
