// Meeting-note body builder (myne-md/myne#789).
//
// A meeting session produces an ordered list of audio clips and a transcript.
// This turns those into the note body the editor receives: the clips as
// ordinary `![[att:<id>]]` embeds at the top, in capture order, then the
// transcript beneath a heading and a notice.
//
// Three properties are deliberate.
//
// **Pure.** No editor, no IPC, no i18n import. The copy is passed in by the
// caller, which is what lets the whole thing be asserted by a unit test rather
// than only by driving a session.
//
// **The transcript is verbatim.** No summarizing, no cleanup, no de-duplication
// of the seam between clips. Decision `0334` records that an ASR transcript is a
// lossy, model-dependent guess, and the honest response to a guess is to present
// it as one rather than to launder it into prose the user will trust more.
//
// **The notice is not decoration.** It is the same obligation `0334` states for
// the voice-note flow, and it is why this function takes the notice text rather
// than hardcoding an English string: the caller resolves it through i18n, and
// the test asserts it is present rather than asserting its wording.

/** One audio clip of a meeting session, in capture order. */
export interface MeetingClipRef {
  /** The content-addressed attachment id the embed resolves against. */
  attachmentId: string;
}

/** The caller-resolved copy, so this module needs no i18n import. */
export interface MeetingNoteCopy {
  /** Heading above the transcript, e.g. "Transcript". */
  transcriptHeading: string;
  /** The machine-transcript notice, rendered above the transcript text. */
  machineNotice: string;
}

/**
 * Build the meeting note's body.
 *
 * An empty clip list is a legitimate input (a session whose clips all failed to
 * import still has a transcript worth keeping) and produces a valid body with
 * no embeds, which is why the embeds and the transcript are joined rather than
 * concatenated unconditionally.
 */
export function buildMeetingNote(
  clips: ReadonlyArray<MeetingClipRef>,
  transcript: string,
  copy: MeetingNoteCopy,
): string {
  const parts: string[] = [];

  // One embed per clip. Decision 0208 records that a long recording is a
  // sequence of ordinary embeds with no grouping metadata, and a meeting keeps
  // that: a one-hour session opens with several players, which is the accepted
  // consequence of not inventing a second embed shape.
  for (const clip of clips) {
    parts.push(`![[att:${clip.attachmentId}]]`);
  }

  const body = transcript.trim();
  if (body.length > 0) {
    // The notice goes ABOVE the text, because a reader who stops after the
    // first line is exactly the reader it exists for.
    parts.push(`## ${copy.transcriptHeading}`);
    parts.push(`_${copy.machineNotice}_`);
    parts.push(body);
  }

  return parts.join("\n\n");
}

/**
 * Whether a note body built by {@link buildMeetingNote} carries anything worth
 * opening. A session that captured nothing at all is a failed session, and the
 * caller says so rather than opening an empty note.
 */
export function meetingNoteHasContent(body: string): boolean {
  return body.trim().length > 0;
}
