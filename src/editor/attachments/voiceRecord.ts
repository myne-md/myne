// Voice-note recording controller (MYND-259).
//
// Drives the three Rust commands (start / stop / cancel), shows the floating
// recording bar, streams the input level from the `voice-record:level` Tauri
// event to the meter, and on Stop inserts the resulting `![[att:<id>|name]]`
// embed at the cursor — the same form-C embed the player widget resolves. The
// recorded audio is encrypted Rust-side; only the attachment metadata crosses
// IPC back here (no raw PCM in the WebView).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EditorView } from "@codemirror/view";
import i18n from "../../i18n";
import { emitAttachmentEmbed } from "../../notes/attachmentRef";
import { addCatalogRows } from "./catalog";
import { fileNameTimestamp } from "./insert";
import { showAttachmentToast } from "./toast";
import { mountRecordingBar, type RecordingBarHandle } from "./recordingBar";

const LEVEL_EVENT = "voice-record:level";
const CLIP_EVENT = "voice-record:clip";

/** The subset of the Rust `ImportedAttachment` the insert path needs. */
interface ImportedAttachment {
  readonly id: string;
  readonly content_type: string;
  readonly filename: string;
  readonly size: number;
}

/** Insert one voice-note embed at the cursor and advance past it, so a sequence
 *  of continuation clips chains in order. */
function insertVoiceEmbed(view: EditorView, imported: ImportedAttachment): void {
  // The record→stop round-trip can outlive the editor: if the user switched
  // notes while recording, this `view` was destroyed and dispatching to it is a
  // silent no-op (the recording would appear to vanish). Bail on a detached view
  // — the audio is still stored in the vault and re-embeddable via the picker.
  if (!view.dom.isConnected) return;
  // Seed the editor catalog cache with the just-imported row FIRST, so the
  // embed resolves to its audio player immediately — otherwise it renders a
  // stale "deleted" tombstone until a note-reopen reloads the catalog (the same
  // seeding the paste/drop/picker path does via `insertEmbedsForOutcomes`).
  addCatalogRows(view, [
    {
      id: imported.id,
      contentType: imported.content_type,
      filename: imported.filename,
      size: imported.size,
    },
  ]);
  const embed = emitAttachmentEmbed(imported.id, imported.filename);
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: embed },
    selection: { anchor: at + embed.length },
    userEvent: "input.voice-note",
  });
}

// One recording at a time, app-wide (the backend enforces it too).
let recording = false;

/** Whether a recording is currently in progress. */
export function isRecording(): boolean {
  return recording;
}

/** Begin recording a voice note. Mounts the bar; Stop inserts an embed at the
 *  cursor, Cancel discards. A start failure surfaces a toast and no bar. */
export async function startVoiceRecording(view: EditorView): Promise<void> {
  if (recording) return;
  recording = true;

  try {
    await invoke("plugin:attachments|voice_record_start");
  } catch (err) {
    recording = false;
    showAttachmentToast(startErrorMessage(err));
    return;
  }

  const bar = mountRecordingBar({
    onStop: () => void finishRecording(view, bar),
    onCancel: () => void cancelRecording(bar),
  });

  try {
    const unlistenLevel = await listen<number>(LEVEL_EVENT, (e) => bar.setLevel(e.payload));
    bar.onTeardown(unlistenLevel);
    // Continuation clips (long recordings past the per-clip cap) arrive here
    // mid-recording and insert their embed in order, live.
    const unlistenClip = await listen<ImportedAttachment>(CLIP_EVENT, (e) =>
      insertVoiceEmbed(view, e.payload),
    );
    bar.onTeardown(unlistenClip);
  } catch {
    // No event stream → the meter stays flat / no live continuation inserts;
    // recording still works and the final clip inserts from stop's return.
  }
}

async function finishRecording(view: EditorView, bar: RecordingBarHandle): Promise<void> {
  bar.setBusy();
  try {
    // `null` when all audio already went out as continuation clips (each
    // inserted live via CLIP_EVENT); otherwise the final sub-cap clip.
    const imported = await invoke<ImportedAttachment | null>(
      "plugin:attachments|voice_record_stop",
      { filename: voiceNoteFilename(new Date()) },
    );
    if (imported !== null) insertVoiceEmbed(view, imported);
    view.focus();
  } catch (err) {
    showAttachmentToast(stopErrorMessage(err));
  } finally {
    bar.teardown();
    recording = false;
  }
}

async function cancelRecording(bar: RecordingBarHandle): Promise<void> {
  try {
    await invoke("plugin:attachments|voice_record_cancel");
  } catch {
    // Best-effort — tear the bar down regardless.
  }
  bar.teardown();
  recording = false;
}

/** Auto-name a recording `Voice note YYYY-MM-DD HH-MM-SS.wav`. Exported +
 *  `now`-injectable for deterministic tests. */
export function voiceNoteFilename(now: Date): string {
  return `Voice note ${fileNameTimestamp(now)}.wav`;
}

/** The `kind` discriminant of a serialized `VoiceRecordError`, or "". */
function errorKind(err: unknown): string {
  if (err !== null && typeof err === "object" && "kind" in err) {
    return String((err as { kind: unknown }).kind);
  }
  return "";
}

function startErrorMessage(err: unknown): string {
  switch (errorKind(err)) {
    case "locked":
      return i18n.t("editor.attachment.voice.startError.locked");
    case "alreadyRecording":
      return i18n.t("editor.attachment.voice.startError.alreadyRecording");
    case "noInputDevice":
      return i18n.t("editor.attachment.voice.startError.noInputDevice");
    case "captureFailed":
      return i18n.t("editor.attachment.voice.startError.captureFailed");
    default:
      return i18n.t("editor.attachment.voice.startError.generic");
  }
}

function stopErrorMessage(err: unknown): string {
  switch (errorKind(err)) {
    case "emptyRecording":
      return i18n.t("editor.attachment.voice.stopError.emptyRecording");
    case "silentRecording":
      return i18n.t("editor.attachment.voice.stopError.silentRecording");
    case "noInputDevice":
    case "captureFailed":
      return i18n.t("editor.attachment.voice.stopError.captureFailed");
    default:
      return i18n.t("editor.attachment.voice.stopError.generic");
  }
}
