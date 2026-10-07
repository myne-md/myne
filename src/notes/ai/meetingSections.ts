// Meeting AI: the section model and the tolerant parser (meeting-ai task 1).
//
// The pass asks the model for four sections, and a small model will not always
// return exactly them. The parser is the tolerant reader: it recognizes the
// headings it knows, ignores their level and casing, keeps an unknown heading
// inside the section it interrupted, and treats heading-less output as the
// summary rather than returning nothing. The heading strings here are the same
// ones `meetingPrompts.ts` asks for, so the writer and the reader cannot drift.

export type MeetingSectionId =
  | "summary"
  | "actionItems"
  | "decisions"
  | "openQuestions";

/** The sections the pass can produce, in the order they are written. */
export const MEETING_SECTION_IDS: readonly MeetingSectionId[] = [
  "summary",
  "actionItems",
  "decisions",
  "openQuestions",
];

/** The heading text for each section, without the markdown `##`. */
export const MEETING_SECTION_HEADINGS: Record<MeetingSectionId, string> = {
  summary: "Summary",
  actionItems: "Action items",
  decisions: "Decisions",
  openQuestions: "Open questions",
};

export interface MeetingSections {
  summary?: string;
  actionItems?: string;
  decisions?: string;
  openQuestions?: string;
}

/** Recognized heading text (lowercased) to its section. Aliases are deliberate:
 *  a model reaches for "Actions" or "Questions" as often as the canonical form. */
const HEADING_TO_ID: Record<string, MeetingSectionId> = {
  summary: "summary",
  "action items": "actionItems",
  actions: "actionItems",
  decisions: "decisions",
  "open questions": "openQuestions",
  questions: "openQuestions",
};

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;

/**
 * Parse the model's markdown into sections. Only recognized headings start a
 * section; every other line belongs to the current section (or is dropped as
 * preamble before the first one). When no recognized heading appears at all,
 * the whole output is returned as the summary, because "the model answered
 * without headings" is a plausible summary rather than a parse failure.
 */
export function parseSections(modelOutput: string): MeetingSections {
  const out: MeetingSections = {};
  let current: MeetingSectionId | null = null;
  let buf: string[] = [];
  let sawHeading = false;

  const flush = (): void => {
    if (current !== null) {
      const text = buf.join("\n").trim();
      if (text.length > 0) out[current] = text;
    }
    buf = [];
  };

  for (const line of modelOutput.split(/\r?\n/)) {
    const match = HEADING_RE.exec(line);
    const id =
      match !== null
        ? HEADING_TO_ID[match[1]!.trim().toLowerCase()]
        : undefined;
    if (id !== undefined) {
      flush();
      current = id;
      sawHeading = true;
    } else {
      buf.push(line);
    }
  }
  flush();

  if (!sawHeading) {
    const whole = modelOutput.trim();
    return whole.length > 0 ? { summary: whole } : {};
  }
  return out;
}
