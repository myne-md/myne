// The desktop voice-capture backend behind `EditorHost.voice`
// (MYND-259; moved here by phase3-web-client task 76).
//
// # Why it moved out of `@myne/editor`
//
// `editor/src/attachments/voiceRecord.ts` owns the recorder's UI — the bar, the
// level meter, the live continuation-clip inserts — and that part is genuinely
// shared. What it ALSO did was `invoke("plugin:attachments|voice_record_start")`
// and `listen("voice-record:level")` at module scope, which put
// `@tauri-apps/api` into any bundle that reached the file. Both clients happened
// to be Tauri, so it worked; the browser is the third client and is not.
//
// So the five platform calls live here and arrive through the seam. The IPC
// command strings and the two event names are byte-unchanged — this is a move,
// not a redesign.
//
// # The filename is stamped here, deliberately
//
// `voice_record_stop` takes the display filename, and the shared package used to
// build it. It still does: `voiceNoteFilename` is exported from `@myne/editor`
// and imported here, so the naming convention stays one implementation shared by
// every client rather than something each host reinvents.

import { invoke } from "../platform/core";
import { listen } from "../platform/event";
import { voiceNoteFilename } from "@myne/editor/attachments/voiceRecord";
import type { ImportedAttachment } from "@myne/editor";

/** Backend→UI input-level updates (0..1) driving the meter. */
const LEVEL_EVENT = "voice-record:level";
/** Backend→UI continuation clips: a long recording past the per-clip cap emits
 *  each finished clip here so its embed inserts live, mid-recording. */
const CLIP_EVENT = "voice-record:clip";

/** Begin native capture. Rejects when the platform refuses (no device, denied,
 *  or a recording already in flight — the backend enforces one at a time too). */
export async function voiceRecordStart(): Promise<void> {
  await invoke("plugin:attachments|voice_record_start");
}

/** Stop and store the clip.
 *
 * `null` means every byte already went out as a continuation clip through
 * {@link onVoiceClip} and there is no final sub-cap remainder to insert — not
 * that the recording failed. */
export async function voiceRecordStop(): Promise<ImportedAttachment | null> {
  return await invoke<ImportedAttachment | null>("plugin:attachments|voice_record_stop", {
    filename: voiceNoteFilename(new Date()),
  });
}

/** Abandon the capture, storing nothing. Best-effort by contract: the caller
 *  tears its bar down regardless of the outcome. */
export async function voiceRecordCancel(): Promise<void> {
  await invoke("plugin:attachments|voice_record_cancel");
}

/** Subscribe to input-level updates. Resolves to an unsubscribe fn. */
export async function onVoiceLevel(cb: (level: number) => void): Promise<() => void> {
  return await listen<number>(LEVEL_EVENT, (e) => cb(e.payload));
}

/** Subscribe to continuation clips. Resolves to an unsubscribe fn. */
export async function onVoiceClip(cb: (clip: ImportedAttachment) => void): Promise<() => void> {
  return await listen<ImportedAttachment>(CLIP_EVENT, (e) => cb(e.payload));
}
