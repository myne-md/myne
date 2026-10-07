// Meeting AI: compose and write the AI sections into the meeting note
// (meeting-ai task 3).
//
// The AI output is appended BENEATH the transcript, as ordinary markdown, under
// a machine-generated notice that is deliberately distinct from the meeting
// note's machine-TRANSCRIPT notice: one says the speech-to-text may be wrong,
// the other says the summary may be wrong, and conflating them would be a false
// statement about one of them.
//
// The block is wrapped in two HTML comment markers. They are ordinary markdown
// and render as nothing, and they are what makes REGENERATION safe: replace
// finds the previous block between the markers and rewrites exactly that region,
// so a user's own text after the block survives, and the transcript above it is
// never in the replaced range. Without a marker the only way to find a previous
// block would be to guess at its headings, which cuts user text.
//
// The IO is injected (read + save), the same shape `notes/ai/summarize.ts` uses
// for its accept path: the pure compose is testable, and the caller owns the
// note-save path plus the flush-then-reload handshake an open pane needs
// (`src/AGENTS.md`: an out-of-band writer must flush the pane before it writes
// and reload it after, or the pane's next autosave clobbers the write).

import {
  MEETING_SECTION_HEADINGS,
  MEETING_SECTION_IDS,
  type MeetingSections,
} from "./meetingSections";

/** Opening marker of the AI block. Renders as nothing. */
export const MEETING_AI_START = "<!-- myne:meeting-ai:start -->";
/** Closing marker of the AI block. Renders as nothing. */
export const MEETING_AI_END = "<!-- myne:meeting-ai:end -->";

/** The default English notice. The caller may pass a localized one. */
export const MEETING_AI_NOTICE =
  "AI-generated from the transcript above. It can be wrong; the transcript is the record.";

/**
 * Compose the AI block: the notice, then each PRESENT section under its heading,
 * in the canonical order, between the markers. Absent sections are omitted, so a
 * summary-only run does not print three empty headings.
 */
export function buildAiBlock(sections: MeetingSections, notice: string): string {
  const parts: string[] = [MEETING_AI_START, `_${notice}_`];
  for (const id of MEETING_SECTION_IDS) {
    const text = sections[id]?.trim();
    if (text !== undefined && text.length > 0) {
      parts.push(`## ${MEETING_SECTION_HEADINGS[id]}`);
      parts.push(text);
    }
  }
  parts.push(MEETING_AI_END);
  return parts.join("\n\n");
}

/**
 * Insert `block` into `body`. If a previous block exists (its start marker is
 * present), it is replaced in place, preserving everything before and after it;
 * otherwise the block is appended. The transcript is never in the replaced
 * range, because the range is the marker pair and nothing else.
 */
export function upsertAiBlock(body: string, block: string): string {
  const start = body.indexOf(MEETING_AI_START);
  if (start !== -1) {
    const endMarker = body.indexOf(MEETING_AI_END, start);
    // Replace ONLY when the marker pair is complete. A body with the start
    // marker and no end marker is NOT a licence to slice to end-of-body: that
    // would delete every byte after it, including user text the block promises
    // never to touch. A missing end marker means the pair is broken, so treat
    // the body as having no block and append instead.
    if (endMarker !== -1) {
      const end = endMarker + MEETING_AI_END.length;
      return `${body.slice(0, start)}${block}${body.slice(end)}`;
    }
  }
  if (body.trim().length === 0) return block;
  const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}${block}\n`;
}
