// Obsidian importer — two-rule ignore-set predicate (MYND-54, tasks 1 + 3).
// Tests the classifier in isolation; the walk that applies it is sub-feature 3,
// and the end-to-end bucket placement is asserted by MYND-90's fixture.

import { describe, it, expect } from "vitest";
import {
  classifyEntry,
  tallyIgnore,
} from "../../src/notes/import/skipPredicate";

describe("classifyEntry — rule (i): dot-prefix wins, any depth", () => {
  for (const name of [
    ".obsidian",
    ".git",
    ".trash",
    ".DS_Store",
    ".obsidian.vimrc",
    ".gitignore",
  ]) {
    it(`${name} → hidden-ignored`, () => {
      expect(classifyEntry(name)).toBe("hidden-ignored");
    });
  }

  it(".foo.md edge → hidden-ignored (dot-rule beats .md; silent drop, locked)", () => {
    expect(classifyEntry(".foo.md")).toBe("hidden-ignored");
  });

  it(".canvas (dot-prefixed full name) → hidden-ignored, not canvas-skipped", () => {
    expect(classifyEntry(".canvas")).toBe("hidden-ignored");
  });
});

describe("classifyEntry — rule (ii): extension dispatch for non-dot entries", () => {
  it("only .md is import-as-note (case-insensitive)", () => {
    expect(classifyEntry("note.md")).toBe("import-as-note");
    expect(classifyEntry("Weekly Review.MD")).toBe("import-as-note");
  });

  it(".markdown and .mdx are NOT importable → non-markdown-skipped", () => {
    expect(classifyEntry("legacy.markdown")).toBe("non-markdown-skipped");
    expect(classifyEntry("component.mdx")).toBe("non-markdown-skipped");
  });

  it(".canvas (non-dot) → its own bucket, distinct from non-markdown-skipped", () => {
    expect(classifyEntry("Board.canvas")).toBe("canvas-skipped");
    expect(classifyEntry("Board.canvas")).not.toBe("non-markdown-skipped");
  });

  it("other non-dot assets → non-markdown-skipped", () => {
    for (const name of ["img.png", "notes.txt", "README", "data.json"]) {
      expect(classifyEntry(name)).toBe("non-markdown-skipped");
    }
  });
});

describe("tallyIgnore — rolls into the three SYNC-2 count fields", () => {
  it("counts a mixed set correctly; import-as-note contributes nothing", () => {
    const names = [
      "a.md", // import-as-note
      "b.md", // import-as-note
      "Board.canvas", // canvas-skipped
      "x.png", // non-markdown-skipped
      "y.txt", // non-markdown-skipped
      ".obsidian", // hidden-ignored
      ".DS_Store", // hidden-ignored
      ".foo.md", // hidden-ignored
    ];
    const classes = names.map(classifyEntry);
    expect(tallyIgnore(classes)).toEqual({
      canvasSkipped: 1,
      nonMarkdownSkipped: 2,
      hiddenIgnored: 3,
    });
  });
});
