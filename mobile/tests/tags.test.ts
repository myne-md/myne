import { describe, it, expect } from "vitest";
import { parseTags, buildTagIndex } from "../src/lib/tags";

describe("parseTags()", () => {
  it("extracts inline and nested tags", () => {
    expect(parseTags("a #alpha and #beta/child here")).toEqual(["alpha", "beta/child"]);
  });

  it("ignores Markdown headings (# followed by a space)", () => {
    expect(parseTags("# Heading\n## Sub")).toEqual([]);
  });

  it("requires whitespace or line-start before #", () => {
    expect(parseTags("foo#bar and http://x#frag")).toEqual([]);
  });

  it("matches a tag at the very start of the text", () => {
    expect(parseTags("#top of the line")).toEqual(["top"]);
  });
});

describe("buildTagIndex()", () => {
  const notes = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const bodies = new Map([
    ["1", "#work #urgent notes"],
    ["2", "#work again #work duplicate"],
    ["3", "no tags here"],
  ]);

  it("counts per note (dedupes within a note) and sorts by count", () => {
    const idx = buildTagIndex(notes, bodies);
    expect(idx.tags).toEqual([
      { tag: "work", count: 2 },
      { tag: "urgent", count: 1 },
    ]);
    expect(idx.byTag.get("work")).toEqual(["1", "2"]);
    expect(idx.noteTags.get("1")).toEqual(["work", "urgent"]);
    expect(idx.noteTags.has("3")).toBe(false);
  });

  it("folds case but keeps the first-seen display casing", () => {
    const idx = buildTagIndex(
      [{ id: "1" }, { id: "2" }],
      new Map([
        ["1", "#Work"],
        ["2", "#work"],
      ]),
    );
    expect(idx.tags).toEqual([{ tag: "Work", count: 2 }]);
    expect(idx.byTag.get("work")).toEqual(["1", "2"]);
  });
});
