// MYND-118 — Welcome note plaintext shape.
//
// The "Untitled" regression: a note's title is derived from the frontmatter
// `title:` field ONLY (loadNoteBatch.ts — no body-`# H1` fallback), so the
// seeded Welcome note must carry `title:` in frontmatter or the sidebar/tab
// renders the "Untitled" placeholder. Desktop first run now seeds the example
// vault (#393) instead of this note, but MOBILE still seeds it and consumes the
// SAME shared `@myne/dialect/welcomeNote` builder — so this pins the shared
// builder's shape directly, the way the desktop resolver (now removed) used to.
// The full seeding flow is container-only E2E.

import { describe, it, expect } from "vitest";
import { readTitleFromFmBody } from "../../src/dialect";
import {
  buildWelcomeNoteMarkdown,
  WELCOME_NOTE_BODY_KEY,
  WELCOME_NOTE_TITLE_KEY,
} from "../../src/dialect/welcomeNote";
import i18n from "../../src/i18n";

// Resolve the copy through the i18n runtime exactly as the seeder does. Under
// Vitest's default boot language (English) these yield the English source, so
// the structural assertions below hold exactly as they did for the old consts.
const WELCOME_NOTE_TITLE = i18n.t(WELCOME_NOTE_TITLE_KEY);
const WELCOME_NOTE_MARKDOWN = buildWelcomeNoteMarkdown(
  WELCOME_NOTE_TITLE,
  i18n.t(WELCOME_NOTE_BODY_KEY),
);

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

  it("keeps the safety reminder and a clickable bare-URL link to the site", () => {
    expect(WELCOME_NOTE_MARKDOWN).toContain("recovery phrase");
    // Bare URL (not `[text](url)`) so the editor's autolink makes it
    // click-to-open; clickable links are bare-URL / `<angle>` only.
    expect(WELCOME_NOTE_MARKDOWN).toContain("https://myne.md");
    expect(WELCOME_NOTE_MARKDOWN).not.toContain("](http");
  });

  it("has no dead wikilink and no 'broken link' framing", () => {
    expect(WELCOME_NOTE_MARKDOWN).not.toContain("[[");
    expect(WELCOME_NOTE_MARKDOWN.toLowerCase()).not.toContain("broken");
  });
});
