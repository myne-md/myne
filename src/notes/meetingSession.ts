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
import { toast } from "../components/toast/toastStore";
import { clearMeetingAiOffer, offerMeetingAi } from "../components/meeting/meetingAiStore";
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
  /** The sidebar surface captured at start, so stop can register + open the
   *  note it just wrote. `null` when the caller could not supply one (a lock
   *  path, or a harness); the note is still written, it just does not open. */
  ctx: MeetingSidebarSurface | null;
}

/**
 * The slice of the sidebar surface this module needs. Structural rather than
 * `UseSelectedNoteReturn` so tests can pass a stub and so the dependency is
 * visible at the call site: `refreshOne` registers the fresh note in the
 * sidebar cache, `open` is what makes it appear in a pane.
 */
export interface MeetingSidebarSurface {
  refreshOne: (id: string) => Promise<void>;
  open: (id: string) => Promise<string>;
}

/**
 * Bind the sidebar surface this module uses. Called from the desktop editor
 * screen, which is the only place both surfaces exist. The seam member
 * `EditorHost.meetingSession` carries only the `EditorView`, by design.
 *
 * Held in a module-scope variable rather than passed through every call so the
 * STOP path (reached from the bar's callbacks and from the tray) can use it
 * without a React context of its own.
 */
let sidebarSurface: MeetingSidebarSurface | null = null;

export function setMeetingSidebarSurface(surface: MeetingSidebarSurface | null): void {
  sidebarSurface = surface;
}

/** The surface captured at start, falling back to the one bound at boot. */
function noteSurface(handle: MeetingSessionHandle | null): MeetingSidebarSurface | null {
  return handle?.ctx ?? sidebarSurface;
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
 *
 * `ctx` is the sidebar selection surface. It is needed at STOP, to register and
 * open the note this session creates; it is copied into the session handle here
 * because the stop path is reached from the bar's own callbacks, which have no
 * React context of their own.
 */
export async function startMeetingSession(
  _view: unknown,
  ctx?: MeetingSidebarSurface,
): Promise<void> {
  if (active) return;
  // Claimed BEFORE the first await, so a second start inside the prefs round
  // trip is refused rather than overwriting this one and orphaning its bar.
  const claimed: MeetingSessionHandle = {
    bar: null,
    unlisten: [],
    pending: new Set(),
    ctx: ctx ?? null,
  };
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

/** Transcribe one finished clip and append its text to the bar. The clip is
 *  still in the note as audio when this fails, so the failure is reported as a
 *  transcription problem rather than as lost audio (`warnClipFailed` says "a
 *  part of the meeting could not be saved", which is false on this path). */
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
    bar.warnTranscriptionFailed();
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
    const surface = noteSurface(current);
    teardown();
    // A note write that fails is the user's only output from the session, so a
    // silent unhandled rejection here meant a meeting produced no note and said
    // nothing. Surfaced as a toast, and the error is not re-thrown: the throw
    // reached the bar's `void stopMeetingSession()` as an unhandled rejection
    // nobody saw.
    try {
      await writeMeetingNote(result.clips, surface);
    } catch {
      toast({ message: i18n.t("editor.meeting.noteWriteFailed"), variant: "error" });
    }
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
  // The AI offer holds the note id and the full transcript (other people's
  // speech, AS1-class) so the dialog can read it. It must not outlive the
  // unlocked session: a lock or a vault switch with the offer live would leave
  // it resident, and the next Editor mount would re-render the dialog from the
  // same module value against the previous vault's note id.
  clearMeetingAiOffer();
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
async function writeMeetingNote(
  clips: ImportedAttachment[],
  surface: MeetingSidebarSurface | null,
): Promise<void> {
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
  const id = await createNoteFromBody(body, name, null);
  // The note exists on disk; without these two steps it is invisible until an
  // unrelated refresh. `refreshOne` caches the fresh record so the sidebar can
  // render it, and `open` is what actually puts it in a pane — the same pair
  // `Editor.tsx`'s daily/period-note creation performs for the same reason.
  // Best-effort: the note is already written, so a failure here must not look
  // like a failed meeting.
  if (surface !== null) {
    try {
      await surface.refreshOne(id);
      await surface.open(id);
    } catch {
      /* the note is on disk; the next sidebar refresh will show it */
    }
  }
  // Offer the AI pass, once, and only when the on-device AI beta is on. The
  // offer is a toast; taking it opens the dialog through the offer store (the
  // session module is not React). Gates beyond `ai_enabled` (an AI-excluded
  // folder, a missing generation model) are the dialog's concern.
  const prefs = await prefsRead().catch(() => null);
  // Offered only when the on-device AI beta is on. The meeting note is created
  // at the vault root (`createNoteFromBody(body, name, null)`), and the
  // `ai_excluded_folders` set holds non-empty folder paths, so a root note is
  // never excluded: there is no folder gate to apply here. A future change that
  // files the meeting note in a folder owes the `isNoteAiExcluded` check against
  // the folder it actually lands in.
  if (prefs?.ai_enabled === true) {
    toast({
      message: i18n.t("editor.meeting.ai.offer"),
      variant: "info",
      action: {
        label: i18n.t("editor.meeting.ai.offerAction"),
        onAction: () => offerMeetingAi(id, transcript),
      },
      testId: "meeting.ai-offer",
    });
  }
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
