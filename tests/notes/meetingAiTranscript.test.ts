// Meeting AI follow-up: recovering a meeting note's transcript for a re-run.
//
// The extraction has to survive the shape `buildMeetingNote` writes (embeds,
// heading, notice, transcript) AND the shape after an AI insert (the same, plus
// the marker-bounded AI block), because the re-run reads a note that may
// already carry sections.

import { describe, expect, it } from "vitest";

import { extractMeetingTranscript } from "../../src/notes/ai/meetingTranscript";
import { MEETING_AI_END, MEETING_AI_START } from "../../src/notes/ai/meetingWrite";

describe("extractMeetingTranscript", () => {
  it("strips the embeds, the heading and the machine notice", () => {
    const body = [
      "![[att:aaaa]]",
      "![[att:bbbb]]",
      "",
      "## Transcript",
      "",
      "_This is a machine transcript._",
      "",
      "Alice: hello everyone.",
      "Bob: hi.",
    ].join("\n");
    expect(extractMeetingTranscript(body)).toBe(
      "Alice: hello everyone.\nBob: hi.",
    );
  });

  it("drops a trailing AI block so a re-run does not summarize the summary", () => {
    const body = [
      "## Transcript",
      "",
      "_machine_",
      "",
      "the words",
      "",
      MEETING_AI_START,
      "",
      "## Summary",
      "an earlier summary",
      MEETING_AI_END,
    ].join("\n");
    expect(extractMeetingTranscript(body)).toBe("the words");
  });

  it("returns an empty string for a body with no transcript", () => {
    expect(extractMeetingTranscript("![[att:aaaa]]\n")).toBe("");
  });
});
