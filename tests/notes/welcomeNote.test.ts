// MYND-118 — Welcome note plaintext shape.
//
// The "Untitled" regression: a note's title is derived from the frontmatter
// `title:` field ONLY (loadNoteBatch.ts — no body-`# H1` fallback), so the
// seeded Welcome note must carry `title:` in frontmatter or the sidebar/tab
// renders the "Untitled" placeholder. These run locally (the seeding flow
// itself is container-only E2E) and pin the exact thing that regressed.

import { describe, it, expect } from "vitest";
import { readTitleFromFmBody } from "../../src/dialect";
import {
  WELCOME_NOTE_MARKDOWN,
  WELCOME_NOTE_TITLE,
} from "../../src/notes/welcomeNote";

/** The frontmatter body (between the leading `---` delimiters) — the slice
 *  shape loadNoteBatch reads `title:` from. */
function frontmatterBody(note: string): string {
  const lines = note.split("\n");
  expect(lines[0]).toBe("---");
  const end = lines.indexOf("---", 1);
  expect(end).toBeGreaterThan(0);
  return lines.slice(1, end).join("\n");
}

describe("WELCOME_NOTE_MARKDOWN (MYND-118)", () => {
  it("leads with a frontmatter block", () => {
    expect(WELCOME_NOTE_MARKDOWN.startsWith("---\n")).toBe(true);
  });

  it("carries a frontmatter title that reads back as the chip title (not Untitled)", () => {
    expect(readTitleFromFmBody(frontmatterBody(WELCOME_NOTE_MARKDOWN))).toBe(
      WELCOME_NOTE_TITLE,
    );
    expect(WELCOME_NOTE_TITLE).toBe("Welcome to Myne");
  });

  it("does not duplicate the title as a body H1", () => {
    expect(WELCOME_NOTE_MARKDOWN).not.toContain("# Welcome to Myne");
  });

  it("keeps the safety reminder and the intentionally-broken wikilink", () => {
    expect(WELCOME_NOTE_MARKDOWN).toContain("recovery phrase");
    expect(WELCOME_NOTE_MARKDOWN).toContain("[[My First Idea]]");
  });
});
