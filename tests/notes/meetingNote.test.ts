import { describe, expect, it } from "vitest";
import {
  appendMeetingChunk,
  buildMeetingNote,
  meetingNoteHasContent,
  type MeetingNoteCopy,
} from "../../src/notes/meetingNote";

const COPY: MeetingNoteCopy = {
  transcriptHeading: "Transcript",
  machineNotice: "This is a machine transcript and may contain errors.",
};

const clip = (id: string) => ({ attachmentId: id });

describe("buildMeetingNote", () => {
  it("emits one embed per clip, in capture order", () => {
    const body = buildMeetingNote(
      [clip("aa"), clip("bb"), clip("cc")],
      "hello",
      COPY,
    );
    const embeds = body.match(/!\[\[att:[a-f0-9]+\]\]/g) ?? [];
    expect(embeds).toEqual([
      "![[att:aa]]",
      "![[att:bb]]",
      "![[att:cc]]",
    ]);
  });

  it("keeps the transcript verbatim", () => {
    // No summarising, no seam de-duplication, no reflowing. Decision 0334
    // records that the transcript is a fallible machine guess; presenting it
    // unaltered is the honest half of that.
    const transcript = "First line.\n\nSecond line with  odd   spacing.";
    const body = buildMeetingNote([clip("aa")], transcript, COPY);
    expect(body).toContain(transcript);
  });

  it("carries the machine-transcript notice above the text", () => {
    const body = buildMeetingNote([clip("aa")], "hello", COPY);
    const noticeAt = body.indexOf(COPY.machineNotice);
    const textAt = body.indexOf("hello");
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(textAt);
  });

  it("places the transcript below every embed", () => {
    const body = buildMeetingNote([clip("aa"), clip("bb")], "hello", COPY);
    const lastEmbed = body.lastIndexOf("![[att:");
    const headingAt = body.indexOf(COPY.transcriptHeading);
    expect(headingAt).toBeGreaterThan(lastEmbed);
  });

  it("produces a valid body when every clip failed to import", () => {
    // A session whose clips all failed still has a transcript worth keeping,
    // and a note with no embeds is a legitimate meeting note.
    const body = buildMeetingNote([], "only words", COPY);
    expect(body).not.toContain("![[att:");
    expect(body).toContain("only words");
    expect(body).toContain(COPY.machineNotice);
  });

  it("produces a valid body when there is no transcript", () => {
    const body = buildMeetingNote([clip("aa")], "", COPY);
    expect(body).toBe("![[att:aa]]");
  });

  it("does not add a transcript section for whitespace-only text", () => {
    const body = buildMeetingNote([clip("aa")], "   \n  ", COPY);
    expect(body).not.toContain(COPY.transcriptHeading);
  });

  it("separates the embeds with blank lines so each is its own block", () => {
    // The dialect parses a block per line; two embeds on adjacent lines without
    // a blank line between them would still parse, but the rendered result
    // differs and the note is meant to be readable as markdown.
    const body = buildMeetingNote([clip("aa"), clip("bb")], "", COPY);
    expect(body).toBe("![[att:aa]]\n\n![[att:bb]]");
  });
});

describe("appendMeetingChunk", () => {
  it("inserts the new embed after the existing ones and appends the text", () => {
    const first = buildMeetingNote([clip("aa")], "first words", COPY);
    const body = appendMeetingChunk(first, clip("bb"), "second words", COPY);
    const embeds = body.match(/!\[\[att:[a-f0-9]+\]\]/g) ?? [];
    expect(embeds).toEqual(["![[att:aa]]", "![[att:bb]]"]);
    const headingAt = body.indexOf(COPY.transcriptHeading);
    expect(body.lastIndexOf("![[att:")).toBeLessThan(headingAt);
    expect(body.indexOf("first words")).toBeLessThan(body.indexOf("second words"));
  });

  it("is idempotent on the attachment id", () => {
    const first = buildMeetingNote([clip("aa")], "words", COPY);
    expect(appendMeetingChunk(first, clip("aa"), "words", COPY)).toBe(first);
  });

  it("adds a transcript section when the note had none", () => {
    const first = buildMeetingNote([clip("aa")], "", COPY);
    const body = appendMeetingChunk(first, clip("bb"), "late words", COPY);
    expect(body).toContain("![[att:aa]]");
    expect(body).toContain("![[att:bb]]");
    expect(body).toContain(COPY.transcriptHeading);
    expect(body).toContain("late words");
  });

  it("adds the embed without a transcript section when the new chunk has no text", () => {
    const first = buildMeetingNote([clip("aa")], "words", COPY);
    const body = appendMeetingChunk(first, clip("bb"), "  ", COPY);
    expect(body).toContain("![[att:bb]]");
    expect(body).toContain("words");
    expect(body.match(/## /g)?.length).toBe(1);
  });
});

describe("meetingNoteHasContent", () => {
  it("is false for an empty session", () => {
    expect(meetingNoteHasContent("")).toBe(false);
    expect(meetingNoteHasContent("   \n ")).toBe(false);
  });

  it("is true for a body with anything in it", () => {
    expect(meetingNoteHasContent("![[att:aa]]")).toBe(true);
    expect(meetingNoteHasContent("words")).toBe(true);
  });
});
