// Meeting AI: the map and reduce prompt builders (meeting-ai task 1).
//
// Two prompts. The map prompt summarizes one transcript chunk and is fixed
// mechanical work. The reduce prompt turns the chunk summaries into the
// requested sections, and it has two modes: the default, which carries the
// section headings and a language line anchored on the transcript (the same
// rule the note-summarization and tag prompts follow), or a user's custom
// instruction used verbatim, which replaces the default machinery entirely.
//
// The language line is anchored on the transcript rather than on the user's
// language for the reason myne-md/myne#618 records: the prompt has no user turn
// to carry a language, so "the user's language" is a phrase the model cannot
// resolve, and without a line a small model answers in English whatever it was
// given.

import {
  MEETING_SECTION_HEADINGS,
  type MeetingSectionId,
} from "./meetingSections";

/** The fixed map instruction, prepended to one chunk. */
export const MEETING_MAP_INSTRUCTION =
  "Summarize the following part of a meeting transcript. Keep every decision, " +
  "action item and open question it contains. " +
  "Write the output in the same language as the transcript.\n\n";

/** The default reduce instruction, before the requested headings. */
export const MEETING_REDUCE_INSTRUCTION =
  "You are given summaries of consecutive parts of one meeting transcript. " +
  "Produce the meeting's output as markdown, using exactly these section " +
  "headings and nothing else:";

/** The language line, shared so a test can assert it in both prompts. */
export const MEETING_LANGUAGE_LINE =
  "Write the output in the same language as the transcript.\n\n";

/** Assemble the map prompt for one chunk. */
export function buildMapPrompt(chunk: string): string {
  return `${MEETING_MAP_INSTRUCTION}${chunk}`;
}

/**
 * Assemble the reduce prompt. A non-blank `customInstruction` is used verbatim
 * and replaces the default instruction and its section headings entirely; a
 * blank or absent one produces the default prompt for `sections`. Either way
 * the chunk summaries follow.
 */
export function buildReducePrompt(
  chunkSummaries: readonly string[],
  sections: readonly MeetingSectionId[],
  customInstruction?: string | null,
): string {
  const joined = chunkSummaries
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n");

  const custom = customInstruction?.trim();
  if (custom !== undefined && custom.length > 0) {
    return `${custom}\n\n${joined}`;
  }

  const headings = sections
    .map((id) => `## ${MEETING_SECTION_HEADINGS[id]}`)
    .join("\n");
  return `${MEETING_REDUCE_INSTRUCTION}\n${headings}\n\n${MEETING_LANGUAGE_LINE}${joined}`;
}
