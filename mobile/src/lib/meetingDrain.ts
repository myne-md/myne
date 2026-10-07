// Watch meeting-capture drain (myne-md/myne#812, task 3) — the JS half of the
// lane whose Rust half seals each arrived audio chunk into a device-local entry
// (`plugin:captures|seal_meeting_chunk`) and groups them by session in the
// pending-meeting manifest.
//
// It sits BESIDE `captures.ts` (`drainPendingCaptures` for the dictated queue),
// and follows the same discipline, with one difference the meeting lane forces:
// a dictated capture drains to a note directly, while a meeting drains to
// *attachments* first.
//
//   • drainPendingMeetings() — on unlock, ask the Rust plugin to decrypt every
//     pending session's sealed chunks and import each into the vault library as
//     an ordinary `MYA1` attachment (host-side — the up-to-64 MiB audio never
//     crosses the WebView). Then, per session: transcribe each imported
//     attachment through the existing attachment-keyed command, build the body
//     with the SHARED `buildMeetingNote` (`@myne/meeting-note`), create the note
//     via the ordinary `noteCreate` path, and ONLY THEN delete the device-local
//     entries + manifest record (`plugin:captures|ack_meeting_session`).
//
// # At-least-once
//
// The ack is last, exactly as `drainPendingCaptures` acks after `noteCreate`: a
// crash between note-create and ack re-drains the session. The re-import dedups
// on the content-addressed attachment id, so the cost is a rare duplicate note
// rather than a lost meeting. `isDraining` serialises the whole pass, so a
// StrictMode double-mount cannot double-create.
//
// # An incomplete session is still a meeting
//
// A session missing a chunk (the watch never delivered it, or its entry could
// not be opened) still produces a note from the chunks that arrived, and the gap
// is reported — the Rust drain returns `missing_chunk_indices`, and this module
// surfaces it once with a toast. Losing one chunk is never losing the meeting.

import i18n from "@myne/i18n";
import {
  appendMeetingChunk,
  buildMeetingNote,
  meetingNoteHasContent,
  type MeetingNoteCopy,
} from "@myne/meeting-note";
import { invoke } from "../platform/core";
import { showToast } from "../components/ToastHost";
import { patchTitleField } from "../dialect/surgery";
import { noteCreate, noteRead, noteUpdate } from "./notes";
import { startTranscription } from "./transcribe";

/** One sealed chunk that drained into the vault library, in capture order
 *  (mirror of the Rust `DrainedMeetingChunk`). */
interface DrainedMeetingChunk {
  /** The wire-supplied chunk index (the watch's ordering position). */
  chunk_index: number;
  /** The `MYA1` attachment id (hex) the note's embed resolves against. */
  attachment_id: string;
}

/** One drained session (mirror of the Rust `DrainedMeeting`). */
interface DrainedMeeting {
  session_id: string;
  /** Session start, milliseconds since the Unix epoch. */
  started_at: number;
  /** Successfully imported chunks, ascending by `chunk_index`. */
  chunks: DrainedMeetingChunk[];
  /** Chunk indices gone for good (never delivered, or unopenable). Safe to ack. */
  missing_chunk_indices: number[];
  /** Chunk indices whose import failed TRANSIENTLY. Their entries must survive,
   *  so they are NOT acked and the session re-drains on the next unlock. */
  retryable_chunk_indices: number[];
  /** The vault note this session already drained into, when an earlier drain
   *  created one. A re-drain APPENDS to it instead of creating a second note, so
   *  a transiently-failed chunk that later resolves cannot fragment the meeting
   *  (myne-md/myne#812 review). */
  note_id?: string | null;
}

let isDraining = false;

/**
 * Drain every pending watch meeting into the vault. Returns the number of notes
 * created. Serialised by `isDraining`; inert (returns 0) without a host / plugin
 * or when the vault re-locks mid-drain.
 */
export async function drainPendingMeetings(): Promise<number> {
  if (isDraining) return 0;
  isDraining = true;
  let created = 0;
  try {
    let sessions: DrainedMeeting[];
    try {
      // One call does the decrypt→import for EVERY session (host-side); the
      // WebView never sees the audio bytes, only the attachment ids.
      sessions = await invoke<DrainedMeeting[]>("plugin:captures|drain_pending_meetings");
    } catch {
      return 0; // no host / plugin — nothing to drain
    }
    for (const session of sessions) {
      let madeNote = false;
      let noteId: string | null = null;
      try {
        const result = await writeMeetingNote(session);
        madeNote = result.created;
        noteId = result.noteId;
      } catch {
        // Vault locked mid-drain (or note-create failure): stop and leave the
        // un-acked sessions for the next unlock. Never ack on failure.
        return created;
      }
      // Record the note the session drained into BEFORE the ack, so a later
      // drain that resolves a previously-retryable chunk appends to THIS note
      // instead of creating a second, fragmenting one (myne-md/myne#812 review).
      // Best-effort: a failed record costs a rare duplicate note, never audio.
      if (noteId !== null) {
        await invoke("plugin:captures|set_meeting_session_note", {
          sessionId: session.session_id,
          noteId,
        }).catch(() => {});
      }
      // Ack only AFTER the note exists (at-least-once), and only the chunks the
      // drain RESOLVED: imported, or gone for good. A chunk whose import failed
      // transiently (no space, a momentary error) keeps its sealed entry and its
      // manifest row, and the session re-drains on the next unlock. Deleting it
      // here turned "the import failed this once" into permanent audio loss.
      const resolved = [
        ...session.chunks.map((c) => c.chunk_index),
        ...session.missing_chunk_indices,
      ];
      await invoke("plugin:captures|ack_meeting_session", {
        sessionId: session.session_id,
        resolvedChunkIndices: resolved,
      }).catch(() => {});
      if (madeNote) created += 1;

      // The note is safe (or there was nothing to keep); report the gap
      // (best-effort, one toast per affected session). A retryable chunk is NOT
      // reported: its audio is still queued and comes back next unlock, so
      // telling the user it is missing would be wrong.
      if (session.missing_chunk_indices.length > 0) {
        showToast(i18n.t("editor.meeting.chunksMissing"));
      }
    }
  } finally {
    isDraining = false;
  }
  return created;
}

/**
 * Transcribe the session's chunks, build the body with the shared builder, and
 * create the note. Returns `true` when a note was created, `false` when the
 * session carried nothing worth a note (all chunks failed to import). Throws
 * only when the note could not be created — a failed transcription is not a
 * failed meeting (the audio is still in the note), so it is caught per chunk and
 * the transcript simply omits that chunk.
 */
async function writeMeetingNote(
  session: DrainedMeeting,
): Promise<{ created: boolean; noteId: string | null }> {
  const copy: MeetingNoteCopy = {
    transcriptHeading: i18n.t("editor.meeting.transcriptHeading"),
    machineNotice: i18n.t("editor.meeting.machineNotice"),
  };
  // Transcribe each chunk once, paired with its clip, so the append path can
  // place each transcript under the right embed.
  const chunkTexts: { attachmentId: string; text: string }[] = [];
  for (const chunk of session.chunks) {
    let text = "";
    try {
      text = (await startTranscription(chunk.attachment_id).done).trim();
    } catch {
      // Transcription unavailable / failed: the audio is still committed to the
      // note. Omit this chunk's text rather than failing the note.
    }
    chunkTexts.push({ attachmentId: chunk.attachment_id, text });
  }

  // A session that already produced a note re-drains into THAT note: append each
  // newly-resolved chunk instead of creating a second, fragmenting one. The
  // append is idempotent on the attachment id, so a chunk already embedded (a
  // re-imported, content-addressed duplicate) is left alone.
  if (session.note_id) {
    let body = await noteRead(session.note_id);
    for (const c of chunkTexts) {
      body = appendMeetingChunk(body, { attachmentId: c.attachmentId }, c.text, copy);
    }
    await noteUpdate(session.note_id, body);
    return { created: false, noteId: session.note_id };
  }

  const clips = chunkTexts.map((c) => ({ attachmentId: c.attachmentId }));
  const transcript = chunkTexts
    .map((c) => c.text)
    .filter((t) => t.length > 0)
    .join("\n\n");
  const body = buildMeetingNote(clips, transcript, copy);
  if (!meetingNoteHasContent(body)) return { created: false, noteId: null };
  // Title from the SESSION START, not from now. The phone can stay locked for
  // hours after the meeting ends, so titling from `now` dated a 09:00 walking
  // 1:1 at 18:00. `started_at` is the one field that carries the real moment.
  const name = i18n.t("editor.meeting.noteTitle", { date: localTimestamp(session.started_at) });
  const noteId = await createTitledNote(body, name);
  return { created: true, noteId };
}

/** Create a note from an explicit body + title, at the vault root. Mirrors the
 *  desktop `createNoteFromBody` tail (`src/notes/newNoteFromTemplate.ts`) and the
 *  mobile `daily.ts` twin, so a meeting note carries the same `title:` frontmatter
 *  the desktop meeting writes. `folder: null` puts it at the root, exactly where
 *  a blank note from the same context lands. */
async function createTitledNote(body: string, name: string): Promise<string> {
  let bytes: Uint8Array = new TextEncoder().encode(body);
  bytes = patchTitleField(bytes, name);
  return await noteCreate(new TextDecoder().decode(bytes), null);
}

/** Local `YYYY-MM-DD HH:MM` from a millisecond epoch (the session's start),
 *  matching the desktop meeting title's shape. UTC formatting would title an
 *  evening meeting with the previous day west of Greenwich, and titling from the
 *  drain time would date a meeting by when the phone happened to be unlocked. */
function localTimestamp(epochMillis: number): string {
  const when = new Date(epochMillis);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
