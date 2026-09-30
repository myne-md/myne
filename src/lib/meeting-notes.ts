// The desktop meeting-session backend behind the editor's `meeting` seam
// (myne-md/myne#789).
//
// Same split as `voice-record.ts` next door, for the same reason: the shared
// `@myne/editor` package owns the session UI and must not import
// `@tauri-apps/api`, so the IPC calls live here and arrive through the host
// seam. `scripts/check-platform-seam.mjs` enforces that.
//
// # What is deliberately NOT here
//
// Transcription. The existing `plugin:local-inference|transcribe` command is
// attachment-keyed and already reachable from the frontend, so the controller
// transcribes each clip as the backend emits it. That keeps the engine surface,
// the `Engine` trait and the `MYE1` cache untouched, which is what the feature
// promises: no new command, no new engine surface.

import { invoke } from "../platform/core";
import { listen } from "../platform/event";
import type { ImportedAttachment } from "@myne/editor";

/** Backend→UI mixed input-level updates (0..1) driving the meter. */
const LEVEL_EVENT = "meeting:level";
/** Backend→UI finished clips, in capture order, as they land. */
const CLIP_EVENT = "meeting:clip";
/** Backend→UI: a clip failed to import, so the session can flag the gap. */
const CLIP_FAILED_EVENT = "meeting:clip-failed";
/** Backend→UI: the system-audio side is silent while the microphone is live. */
const TAP_SILENCE_EVENT = "meeting:tap-silence";
/** Backend→UI: whether this session armed a system-audio source. */
const SOURCE_EVENT = "meeting:source";
/** Backend→UI: the menubar indicator was clicked. The frontend owns the stop
 *  because the note write is a frontend operation. */
const TRAY_STOP_EVENT = "meeting:tray-stop";

/** What `meeting_session_stop` returns: every clip, in capture order. */
export interface MeetingSessionResult {
  clips: ImportedAttachment[];
}

/** Begin a meeting session. Rejects when the platform refuses (locked vault, no
 *  input device, or a session already in flight: the backend enforces one at a
 *  time). */
export async function meetingSessionStart(): Promise<void> {
  await invoke("plugin:attachments|meeting_session_start");
}

/** Finalize and return the session's clips in capture order. */
export async function meetingSessionStop(): Promise<MeetingSessionResult> {
  return await invoke<MeetingSessionResult>("plugin:attachments|meeting_session_stop");
}

/** Abandon the session, keeping whatever clips already committed. Best-effort by
 *  contract: the caller tears its bar down regardless of the outcome. */
export async function meetingSessionCancel(): Promise<void> {
  await invoke("plugin:attachments|meeting_session_cancel");
}

/** Subscribe to mixed input-level updates. Resolves to an unsubscribe fn. */
export async function onMeetingLevel(cb: (level: number) => void): Promise<() => void> {
  return await listen<number>(LEVEL_EVENT, (e) => cb(e.payload));
}

/** Subscribe to clips as they land. Resolves to an unsubscribe fn. */
export async function onMeetingClip(
  cb: (clip: ImportedAttachment) => void,
): Promise<() => void> {
  return await listen<ImportedAttachment>(CLIP_EVENT, (e) => cb(e.payload));
}

/** Subscribe to clip-import failures. Resolves to an unsubscribe fn. */
export async function onMeetingClipFailed(cb: () => void): Promise<() => void> {
  return await listen<null>(CLIP_FAILED_EVENT, () => cb());
}

/** Subscribe to the session's source answer. Resolves to an unsubscribe fn. */
export async function onMeetingSource(cb: (available: boolean) => void): Promise<() => void> {
  return await listen<boolean>(SOURCE_EVENT, (e) => cb(e.payload));
}

/** Subscribe to the system-audio silence warning. Resolves to an unsubscribe fn. */
export async function onMeetingTapSilence(cb: () => void): Promise<() => void> {
  return await listen<null>(TAP_SILENCE_EVENT, () => cb());
}

/** Subscribe to the menubar indicator's stop click. Resolves to an unsubscribe
 *  fn. */
export async function onMeetingTrayStop(cb: () => void): Promise<() => void> {
  return await listen<null>(TRAY_STOP_EVENT, () => cb());
}
