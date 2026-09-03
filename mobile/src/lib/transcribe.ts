// Transcription IPC wrapper (mobile, MYND-563) — the SINGLE call path to the
// local-inference `transcribe` command, used by the audio-attachment surface.
// It does NOT yet reach the in-note audio widget: this comment claimed it did,
// "through `EditorHost.transcribe`", and mobile populates no such slot (grep
// `mobile/src` for `transcribe:`). That matters beyond tidiness, because the
// widget indexes its hint table by the EDITOR's union and this module's union
// carries `"not_ready"`, which has no row there; wiring the slot without
// reconciling the two would render an empty hint (myne-md/myne#510).
//
// It opens a per-segment streaming `Channel<string>`
// feeding `onSegment`, and resolves with the FULL transcript when transcription
// ends. The decrypted PCM + transcript never leave Rust except as this final
// string / the streamed segments — AS1-class content, never logged here.
//
// Mirrors the desktop `src/lib/transcribe.ts`, with one mobile adaptation left
// (the import difference this comment used to name is gone — mobile has a
// `mobile/src/platform/` seam now, myne#492, so both clients import `Channel`
// and `invoke` from `../platform/core`):
//   - `stop()` is a no-op for now: the mobile transcription backend does not yet
//     register a cancel command (the desktop `chat_stop` shares the chat surface,
//     which this transcription-only port dropped). Cancellation via a dedicated
//     command is a follow-up; a run is short (one attachment) and completes.

import { Channel, invoke } from "../platform/core";

/** A normalized transcription failure. `kind: "not_ready"` = transcription off /
 *  no model available (surface a "turn it on / no model" hint); `"too_long"` =
 *  the clip is past the decoder's ceiling and will be refused every time, so the
 *  caller must NOT offer a retry (myne#485); `"failed"` = any other engine /
 *  decrypt / decode failure. */
export interface TranscribeError {
  readonly kind: "not_ready" | "too_long" | "failed";
}

/** A running transcription. `done` resolves with the full transcript and rejects
 *  with a {@link TranscribeError}; `stop()` is a no-op on mobile (see file note). */
export interface TranscribeRun {
  readonly done: Promise<string>;
  stop: () => void;
}

/** Start transcribing audio attachment `attachmentId`. `onSegment` (optional)
 *  receives each streamed per-segment partial transcript. */
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
    // No cancel command on mobile yet (see file note) — the run completes on its
    // own; kept in the shape so a future cancel wiring is a one-line change.
    stop: () => {},
  };
}

/** Read an already-cached transcript for `attachmentId` without re-running the
 *  engine (`null` when none is cached). */
export async function readTranscript(attachmentId: string): Promise<string | null> {
  return await invoke<string | null>("plugin:local-inference|read_transcript", {
    attachmentId,
  }).catch(() => null);
}

/** Map the raw IPC rejection (a serialized `EngineError` — a bare variant string
 *  like `"NotReady"`, or a `{ kind }` object carrying the snake_case tag from
 *  `EngineError::kind()`) to a normalized kind. Three arms: `"not_ready"`,
 *  `"too_long"`, and `"failed"` for everything else. The catch-all stays a
 *  catch-all deliberately: an unknown variant must degrade to the retryable
 *  message, never to `"too_long"`, which suppresses the retry button. */
function normalizeTranscribeError(raw: unknown): TranscribeError {
  const tag =
    typeof raw === "string"
      ? raw
      : raw !== null && typeof raw === "object" && "kind" in raw
        ? String((raw as { kind: unknown }).kind)
        : "";
  // Normalized to snake_case first rather than each spelling written twice.
  // Tauri serializes a unit variant as its identifier (`AudioTooLong`) while
  // `EngineError::kind` emits snake_case (`audio_too_long`), and hand-writing
  // both rows put a silent fall-through to `"failed"` one transcription error
  // away, twice per cause. The desktop normalizer was rewritten this way in
  // myne-md/myne#510; this is the same fix on the twin, which keeps its own
  // deliberately coarser three-arm union.
  switch (tag.replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase()) {
    case "not_ready":
      return { kind: "not_ready" };
    case "audio_too_long":
      return { kind: "too_long" };
    default:
      return { kind: "failed" };
  }
}
