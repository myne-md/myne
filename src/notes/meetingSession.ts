// The desktop meeting-session controller (myne-md/myne#789).
//
// This lives desktop-side rather than in `@myne/editor` because it needs three
// things the shared package must not import: the note-creation path, the
// transcription binding, and the i18n catalog. The editor reaches it through one
// seam member (`EditorHost.meetingSession`), mirroring `voiceRecord`, and the
// shared bar it mounts comes back the other way from `@myne/editor`.
//
// # Why the note is written at STOP rather than at start
//
// The session's note is created once, with its final body, when the session
// ends. The alternative (create and open it at the start so the user can
// annotate during the meeting, then append the transcript at the end) is what
// the feature's grill chose, and it is a better product. It is not what is
// built here, and the reason is a data-loss one rather than a convenience one:
// a note that is open and possibly dirty when a second writer touches it is the
// exact shape `src/AGENTS.md` documents twice as silently destructive, and
// making it safe needs a flush-then-reload handshake through the live pane.
// Creating the note once at the end has no second writer at all, so the failure
// cannot happen rather than being guarded against. The deviation is recorded in
// `agent-tooling/features/meeting-notes/progress.md`.
//
// # Transcription
//
// Each clip is transcribed as the backend emits it, through the EXISTING
// `plugin:local-inference|transcribe` command. No new command, no new engine
// surface, and the `MYE1` cache is untouched.

import { mountMeetingBar, type MeetingBarHandle } from "@myne/editor/attachments/meetingBar";
import type { ImportedAttachment } from "@myne/editor";
import i18n from "../i18n";
import { prefsRead } from "../lib/prefs";
import { createNoteFromBody } from "./newNoteFromTemplate";
import { buildMeetingNote, meetingNoteHasContent } from "./meetingNote";
import {
  meetingSessionCancel,
  meetingSessionStart,
  meetingSessionStop,
  onMeetingClip,
  onMeetingClipFailed,
  onMeetingLevel,
  onMeetingSource,
  onMeetingTapSilence,
  onMeetingTrayStop,
} from "../lib/meeting-notes";
import { startTranscription } from "../lib/transcribe";

/** The one live session. A module-scope value, cleared on teardown, so a second
 *  start while one runs is refused here as well as in the backend. */
interface MeetingSessionHandle {
  /** `null` only between claiming the slot and mounting the bar. */
  bar: MeetingBarHandle | null;
  unlisten: Array<() => void>;
  /** Per-clip transcription runs, so stop can await them. Without this the last
   *  clip's text was missing from the note whenever its transcription was still
   *  running when the session ended, which is the normal case for the final
   *  clip: its event lands at stop. */
  pending: Set<Promise<void>>;
}

let active: MeetingSessionHandle | null = null;

/**
 * Whether the feature is offered at all. Read from `vault.prefs` at the moment
 * of use rather than captured at boot, so turning Developer mode on takes
 * effect without a restart. Turning it OFF during a session must NOT stop the
 * session: the gate is visibility, which is the rule every developer-gated
 * setting follows, and this function is only consulted on the start path.
 */
async function meetingSessionEnabled(): Promise<boolean> {
  try {
    return (await prefsRead()).developer_mode === true;
  } catch {
    // An unreadable prefs blob is not a licence to offer an unvetted feature.
    return false;
  }
}

/**
 * Start a meeting session and mount its bar.
 *
 * `view` is unused today and threaded for parity with `voiceRecord`, which needs
 * it to insert the recording embed at the cursor. A meeting's output goes to its
 * own note instead, so there is nothing to insert into the current document.
 */
export async function startMeetingSession(_view: unknown): Promise<void> {
  if (active) return;
  // Claimed BEFORE the first await, so a second start inside the prefs round
  // trip is refused rather than overwriting this one and orphaning its bar.
  const claimed: MeetingSessionHandle = { bar: null, unlisten: [], pending: new Set() };
  active = claimed;
  if (!(await meetingSessionEnabled())) {
    // Not a silent no-op: a caller that reached here with the gate off is a
    // wiring bug, and saying so is cheaper than debugging an absent bar.
    console.warn("meeting session refused: developer_mode is off");
    active = null;
    return;
  }

  // One session's transcripts, keyed by clip id so the note's order is the
  // clips' capture order rather than the order transcription happened to
  // finish in. Cleared here rather than pruned later: a session starts with an
  // empty map by construction.
  transcripts.clear();

  const bar = mountMeetingBar({
    onStop: () => void stopMeetingSession(),
    onCancel: () => void cancelMeetingSession(),
  });
  const unlisten: Array<() => void> = [];
  claimed.bar = bar;
  claimed.unlisten = unlisten;

  try {
    unlisten.push(await onMeetingLevel((level) => bar.setLevel(level)));
    unlisten.push(
      await onMeetingClip((clip) => {
        const run = transcribeClipIntoBar(clip, bar).finally(() => {
          active?.pending.delete(run);
        });
        active?.pending.add(run);
      }),
    );
    unlisten.push(await onMeetingClipFailed(() => bar.warnClipFailed()));
    unlisten.push(await onMeetingTapSilence(() => bar.warnTapSilence()));
    unlisten.push(
      await onMeetingSource((available) => bar.setSystemAudioAvailable(available)),
    );
    // The menubar indicator's click arrives here rather than stopping
    // host-side, because the stop path has to write the note and that is a
    // frontend operation.
    unlisten.push(await onMeetingTrayStop(() => void stopMeetingSession()));
    await meetingSessionStart();
  } catch (e) {
    // A refused start leaves nothing behind: tear the bar down and re-throw so
    // the caller (the slash command) surfaces it.
    teardown();
    throw e;
  }
}

/** Transcribe one finished clip and append its text to the bar. A failure is
 *  swallowed into an empty block rather than shown: the clip is still in the
 *  note as audio, and a per-clip error toast during a meeting is noise. */
async function transcribeClipIntoBar(
  clip: ImportedAttachment,
  bar: MeetingBarHandle,
): Promise<void> {
  try {
    const text = await startTranscription(clip.id).done;
    // Recorded before it is shown, so the note's transcript is the same text
    // the user watched arrive rather than a second transcription of the same
    // audio.
    recordTranscript(clip.id, text);
    bar.addTranscript(text);
  } catch {
    bar.warnClipFailed();
  }
}

/** Stop the session and write its note. */
export async function stopMeetingSession(): Promise<void> {
  const current = active;
  if (!current) return;
  current.bar?.setBusy();
  try {
    const result = await meetingSessionStop();
    // Every in-flight transcription finishes BEFORE the listeners come down and
    // the body is built. Awaiting after teardown would read a map the runs can
    // no longer write to.
    await Promise.allSettled([...current.pending]);
    teardown();
    await writeMeetingNote(result.clips);
  } catch (e) {
    teardown();
    throw e;
  }
}

/** Abandon the session. Already-committed clips remain in the vault, matching
 *  the backend's checkpoint semantics, but no note is written. */
export async function cancelMeetingSession(): Promise<void> {
  if (!active) return;
  teardown();
  await meetingSessionCancel();
}

/**
 * Clear everything this module holds at module scope, for a vault-leaving path.
 *
 * Locking or switching a vault does not reload the WebView, and neither the
 * `transcripts` map (other people's speech, decoded from vault attachments) nor
 * the body-mounted bar goes away on its own. Without this the text of a locked
 * vault's meeting stayed resident into the next vault's session, and `active`
 * stayed set so `/meeting` was silently dead until the stale bar was cancelled.
 * The backend aborts the capture on the same paths; this is the frontend half.
 */
export function teardownMeetingSessionForLock(): void {
  transcripts.clear();
  teardown();
}

function teardown(): void {
  const current = active;
  active = null;
  if (!current) return;
  for (const fn of current.unlisten) {
    try {
      fn();
    } catch {
      // A failed unlisten must not stop the rest of the teardown, and the bar
      // is coming down regardless.
    }
  }
  current.bar?.teardown();
}

/**
 * Build the note body from the session's clips and write it as a new note.
 *
 * The transcript is collected from the transcription results the session
 * already produced; this function re-reads nothing and re-transcribes nothing.
 * The note is created through the ordinary `note_create` path, so no backend
 * writer touches a note that may be open.
 */
async function writeMeetingNote(clips: ImportedAttachment[]): Promise<void> {
  const transcript = transcriptFor(clips);
  const body = buildMeetingNote(
    clips.map((c) => ({ attachmentId: c.id })),
    transcript,
    {
      transcriptHeading: i18n.t("editor.meeting.transcriptHeading"),
      machineNotice: i18n.t("editor.meeting.machineNotice"),
    },
  );
  if (!meetingNoteHasContent(body)) return;
  // Local components, not `toISOString()`: the UTC string titled an evening
  // meeting with the previous day's date for anyone west of Greenwich, and the
  // wrong hour for everyone outside UTC.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = i18n.t("editor.meeting.noteTitle", {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  });
  await createNoteFromBody(body, name, null);
}

/** The transcript blocks the session collected, joined. Kept as a map keyed by
 *  attachment id so the note's order is the clips' capture order rather than the
 *  order transcription happened to finish in. */
const transcripts = new Map<string, string>();

/** Record a clip's transcript. Called by the controller as each resolves. */
export function recordTranscript(attachmentId: string, text: string): void {
  transcripts.set(attachmentId, text);
}

function transcriptFor(clips: ImportedAttachment[]): string {
  const parts: string[] = [];
  for (const clip of clips) {
    const text = transcripts.get(clip.id);
    if (text && text.trim().length > 0) parts.push(text.trim());
  }
  return parts.join("\n\n");
}
