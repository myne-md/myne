// #393 — first-run example vault plaintext shape.
//
// Mirrors the Welcome-note test (a note's title comes from the frontmatter
// `title:` field ONLY — no body-`# H1` fallback), and adds the two fields the
// example set relies on: every note carries `folder:` so it lands inside the
// one deletable folder, and the index note carries `folder_index: true`. The
// full seeding flow is container-only E2E; these pin the structural invariants
// locally.

import { describe, it, expect } from "vitest";
import {
  readFolderIndexFromFmBody,
  readTitleFromFmBody,
} from "../../src/dialect";
import {
  buildExampleNoteMarkdown,
  EXAMPLE_NOTES,
} from "../../src/dialect/exampleVault";

/** The frontmatter body (between the leading `---` delimiters). */
function frontmatterBody(note: string): string {
  const lines = note.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  return lines.slice(1, end).join("\n");
}

/** The Markdown body after the frontmatter block. */
function markdownBody(note: string): string {
  const lines = note.split("\n");
  const end = lines.indexOf("---", 1);
  return lines.slice(end + 1).join("\n");
}

describe("buildExampleNoteMarkdown (#393)", () => {
  it("writes title + folder, and marks the index note", () => {
    const note = buildExampleNoteMarkdown(
      "Start here",
      "Getting started",
      "Body text with a [[Tasks]] link.\n",
      { index: true },
    );
    const fm = frontmatterBody(note);
    expect(readTitleFromFmBody(fm)).toBe("Start here");
    expect(readFolderIndexFromFmBody(fm)).toBe(true);
    expect(fm).toMatch(/^folder:\s*Getting started\s*$/m);
    // Body survives verbatim after the frontmatter.
    expect(markdownBody(note)).toContain("[[Tasks]]");
  });

  it("a non-index note carries folder but not folder_index", () => {
    const note = buildExampleNoteMarkdown("Tasks", "Getting started", "- [ ] do\n");
    const fm = frontmatterBody(note);
    expect(readTitleFromFmBody(fm)).toBe("Tasks");
    expect(readFolderIndexFromFmBody(fm)).toBe(false);
    expect(fm).toMatch(/^folder:\s*Getting started\s*$/m);
  });
});

describe("EXAMPLE_NOTES roster", () => {
  it("has exactly one index note", () => {
    expect(EXAMPLE_NOTES.filter((n) => n.index === true)).toHaveLength(1);
  });

  it("has unique roles and distinct title/body keys per note", () => {
    const roles = EXAMPLE_NOTES.map((n) => n.role);
    expect(new Set(roles).size).toBe(roles.length);
    const keys = EXAMPLE_NOTES.flatMap((n) => [n.titleKey, n.bodyKey]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
