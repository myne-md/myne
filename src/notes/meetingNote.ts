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
 * Append one more chunk (clip + transcript) to a note already built by
 * {@link buildMeetingNote}, for the re-drain of a session whose chunk arrived
 * late (myne-md/myne#812 review). The new clip's embed is inserted at the end of
 * the existing embed block (immediately before the transcript heading), and its
 * transcript text is appended to the transcript, so the note stays "one note"
 * with the clips still in capture order.
 *
 * Idempotent on the clip's attachment id: a chunk whose embed is already present
 * is left untouched, so an at-least-once re-drain cannot duplicate an embed. (The
 * transcript text is not de-duplicated — the same rare duplicate the
 * at-least-once contract already accepts.)
 */
export function appendMeetingChunk(
  body: string,
  clip: MeetingClipRef,
  transcript: string,
  copy: MeetingNoteCopy,
): string {
  const embed = `![[att:${clip.attachmentId}]]`;
  if (body.includes(embed)) return body;

  const text = transcript.trim();
  const heading = `## ${copy.transcriptHeading}`;
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((line) => line.trim() === heading);

  if (headingIdx === -1) {
    // No transcript section yet: add the embed, then a fresh section.
    const withEmbed = body.trim().length > 0 ? `${body.trimEnd()}\n\n${embed}` : embed;
    if (text.length === 0) return withEmbed;
    return `${withEmbed}\n\n${heading}\n\n_${copy.machineNotice}_\n\n${text}`;
  }

  // Insert the embed at the end of the embed block (just before the heading) and
  // append the new transcript text at the very end.
  const before = lines.slice(0, headingIdx).join("\n").trimEnd();
  const after = lines.slice(headingIdx).join("\n");
  const withEmbed = before.length > 0 ? `${before}\n\n${embed}\n\n${after}` : `${embed}\n\n${after}`;
  return text.length === 0 ? withEmbed : `${withEmbed.trimEnd()}\n\n${text}`;
}

/**
 * Whether a note body built by {@link buildMeetingNote} carries anything worth
 * opening. A session that captured nothing at all is a failed session, and the
 * caller says so rather than opening an empty note.
 */
export function meetingNoteHasContent(body: string): boolean {
  return body.trim().length > 0;
}
