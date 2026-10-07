// Meeting AI task 1: the section parser (pure).
//
// A small model will not always emit exactly the four headings it was asked
// for. The parser is deliberately tolerant: it recognizes the headings it
// knows, ignores their level and casing, keeps an unknown heading inside the
// section it interrupted, and falls back to treating heading-less output as the
// summary rather than returning nothing.

import { describe, expect, it } from "vitest";

import { parseSections } from "../../src/notes/ai/meetingSections";

describe("parseSections", () => {
  it("parses all four sections from well-formed output", () => {
    const out = [
      "## Summary",
      "We agreed on the plan.",
      "",
      "## Action items",
      "- Alice writes the doc",
      "",
      "## Decisions",
      "- Ship on Friday",
      "",
      "## Open questions",
      "- Budget?",
    ].join("\n");
    expect(parseSections(out)).toEqual({
      summary: "We agreed on the plan.",
      actionItems: "- Alice writes the doc",
      decisions: "- Ship on Friday",
      openQuestions: "- Budget?",
    });
  });

  it("returns only the sections that are present", () => {
    expect(parseSections("## Summary\nJust this.")).toEqual({
      summary: "Just this.",
    });
  });

  it("falls back to the whole output as the summary when there is no heading", () => {
    expect(parseSections("Just some prose with no headings.")).toEqual({
      summary: "Just some prose with no headings.",
    });
  });

  it("tolerates heading level and casing", () => {
    const out = ["### summary", "A.", "# ACTION ITEMS", "- B"].join("\n");
    expect(parseSections(out)).toEqual({ summary: "A.", actionItems: "- B" });
  });

  it("keeps an unknown heading inside the section it interrupted", () => {
    const out = ["## Summary", "Intro.", "### Notes", "More detail."].join("\n");
    expect(parseSections(out).summary).toBe("Intro.\n### Notes\nMore detail.");
  });

  it("returns an empty object for blank output", () => {
    expect(parseSections("   \n  ")).toEqual({});
  });
});
