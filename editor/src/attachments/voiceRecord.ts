// Voice-note recording controller (MYND-259).
//
// Drives the three Rust commands (start / stop / cancel), shows the floating
// recording bar, streams the input level from the `voice-record:level` Tauri
// event to the meter, and on Stop inserts the resulting `![[att:<id>|name]]`
// embed at the cursor — the same form-C embed the player widget resolves. The
// recorded audio is encrypted Rust-side; only the attachment metadata crosses
// IPC back here (no raw PCM in the WebView).

import { getHost } from "../host";
import type { EditorView } from "@codemirror/view";
import i18n from "@myne/editor/i18n";
import { emitAttachmentEmbed } from "@myne/editor/host/notes/attachmentRef";
import { addCatalogRows } from "./catalog";
import { fileNameTimestamp, ownLineInsertion } from "./insert";
import { showAttachmentToast } from "./toast";
import { mountRecordingBar, type RecordingBarHandle } from "./recordingBar";

// The two backend→UI event names moved to the host with phase3-web-client task
// 76, alongside the three `invoke` calls — `EditorHost.voice` now exposes
// `onLevel` / `onClip` subscriptions instead of this file naming a transport it
// cannot have on every client.

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
  // Its own line, like every other embed Myne writes (myne-md/myne#604).
  const { insert, anchor } = ownLineInsertion(view.state.doc, at, embed);
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor },
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

  const voice = getHost().voice;
  if (voice === undefined) {
    // No capture backend on this host. `/record` is gated on the same absence
    // upstream; this is the belt for a stale keybinding.
    recording = false;
    showAttachmentToast(startErrorMessage(undefined), "error");
    return;
  }

  try {
    await voice.start();
  } catch (err) {
    recording = false;
    showAttachmentToast(startErrorMessage(err), "error");
    return;
  }

  const bar = mountRecordingBar({
    onStop: () => void finishRecording(view, bar),
    onCancel: () => void cancelRecording(bar),
  });

  try {
    const unlistenLevel = await voice.onLevel((level) => bar.setLevel(level));
    bar.onTeardown(unlistenLevel);
    // Continuation clips (long recordings past the per-clip cap) arrive here
    // mid-recording and insert their embed in order, live.
    const unlistenClip = await voice.onClip((clip) => insertVoiceEmbed(view, clip));
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
    const imported = await getHost().voice!.stop();
    if (imported !== null) insertVoiceEmbed(view, imported);
    view.focus();
  } catch (err) {
    showAttachmentToast(stopErrorMessage(err), "error");
  } finally {
    bar.teardown();
    recording = false;
  }
}

async function cancelRecording(bar: RecordingBarHandle): Promise<void> {
  try {
    await getHost().voice?.cancel();
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
    // Its own arm rather than falling through to `generic`. The Rust variant's
    // own doc says it is carried separately from `CaptureFailed` "so the user is
    // told what is actually wrong", and until this arm existed that sentence was
    // false: it landed on "Couldn't start recording", which names neither the
    // cause nor the one thing that fixes it.
    case "unsupportedSampleRate":
      return i18n.t("editor.attachment.voice.startError.unsupportedSampleRate");
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
    // Same reason as the start mapper, and worse here: the take is discarded, so
    // "Couldn't save the recording" reads as a transient save failure the user
    // should retry, and retrying on the same device fails identically.
    case "unsupportedSampleRate":
      return i18n.t("editor.attachment.voice.stopError.unsupportedSampleRate");
    default:
      return i18n.t("editor.attachment.voice.stopError.generic");
  }
}
