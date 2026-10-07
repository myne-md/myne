// Meeting AI task 1: the map and reduce prompt builders (pure).
//
// The reduce prompt has two modes. With no custom instruction it carries the
// default machinery (the requested section headings and a language line
// anchored on the transcript). With one it is the user's instruction verbatim,
// and the default machinery must NOT leak into it, which is the assertion that
// keeps the two modes from silently merging.

import { describe, expect, it } from "vitest";

import {
  buildMapPrompt,
  buildReducePrompt,
} from "../../src/notes/ai/meetingPrompts";
import { MEETING_SECTION_IDS } from "../../src/notes/ai/meetingSections";

describe("buildMapPrompt", () => {
  it("carries the chunk", () => {
    expect(buildMapPrompt("hello world")).toContain("hello world");
  });
});

describe("buildReducePrompt", () => {
  const summaries = ["chunk one summary", "chunk two summary"];

  it("carries every chunk summary and the requested sections", () => {
    const prompt = buildReducePrompt(summaries, ["summary", "actionItems"]);
    expect(prompt).toContain("chunk one summary");
    expect(prompt).toContain("chunk two summary");
    expect(prompt).toMatch(/summary/i);
    expect(prompt).toMatch(/action/i);
  });

  it("anchors the output language on the transcript, not on the user", () => {
    expect(buildReducePrompt(summaries, MEETING_SECTION_IDS)).toContain(
      "same language as the transcript",
    );
  });

  it("uses a custom instruction verbatim and injects no default machinery", () => {
    const custom = "ONLY produce a haiku. Custom marker XYZ.";
    const prompt = buildReducePrompt(summaries, ["summary"], custom);
    expect(prompt).toContain(custom);
    expect(prompt).toContain("chunk one summary");
    expect(prompt).not.toContain("same language as the transcript");
  });

  it("falls back to the default when the custom instruction is blank", () => {
    expect(buildReducePrompt(summaries, ["summary"], "   ")).toContain(
      "same language as the transcript",
    );
  });
});
