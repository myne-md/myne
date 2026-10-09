// @vitest-environment node
//
// The story-catalogue guard (myne-md/myne#845, injected-defect spec added in the
// myne-md/myne#847 review).
//
// The guard's rule is that it is proven by breaking it, not by running it, and
// this file is the half that was missing: every case below injects one of the
// defects the guard claims to catch and asserts it is named.

import { describe, expect, it } from "vitest";
import { findings, storyCount } from "../../scripts/check-story-catalogue.mjs";

/** One story file, as the guard reads it. */
const sources = (text: string): Map<string, string> => new Map([["x.tsx", text]]);

describe("the story-catalogue guard", () => {
  it("names a state with no description", () => {
    const problems = findings(sources('{\n  state: "default",\n  tags: ["a"],\n}'));
    expect(problems.join("\n")).toContain("has no description");
  });

  it("names a state whose tags list is empty", () => {
    // An empty list is the same as no tags: search has nothing to match on, and
    // the first version tested only for the opening bracket.
    const problems = findings(
      sources('{\n  state: "default",\n  description: "x",\n  tags: [],\n}'),
    );
    expect(problems.join("\n")).toContain("has no tags");
  });

  it("names an orphan description with no state to own it", () => {
    // The reverse direction. Four spaces, because a fixture's own description is
    // indented two and is not a story annotation.
    const problems = findings(sources('    description: "orphan",'));
    expect(problems.join("\n")).toContain('no "state:" to own it');
  });

  it("names a placeholder phrase", () => {
    const problems = findings(sources("render: () => <div>Modal body.</div>"));
    expect(problems.join("\n")).toContain("placeholder phrase");
  });

  it("passes a story that carries both annotations", () => {
    const problems = findings(
      sources('{\n  state: "default",\n  description: "x",\n  tags: ["a"],\n}'),
    );
    expect(problems).toEqual([]);
  });

  it("counts the stories it scanned, so a scan of nothing is visible", () => {
    expect(storyCount(sources('{\n  state: "default",\n}'))).toBe(1);
  });
});
