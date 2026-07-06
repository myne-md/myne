import { describe, it, expect } from "vitest";
import { frontmatterTitle, bodyAfterFrontmatter } from "../src/lib/note-organize";
import {
  WELCOME_NOTE_TITLE,
  WELCOME_NOTE_BODY,
  welcomeNoteMarkdown,
} from "../src/lib/welcomeNote";

// The onboarding Welcome note (desktop MYND-118 mirror). The copy itself is
// pinned in src/lib/welcomeNote.ts as the desktop en catalog's
// `notes.welcome.*` verbatim — cross-repo byte-parity is a review-time check
// (the repos don't see each other in CI), but the structural contract is
// testable here.

describe("welcome note", () => {
  it("carries the title in frontmatter (list would show 'Untitled' otherwise)", () => {
    expect(frontmatterTitle(welcomeNoteMarkdown())).toBe(WELCOME_NOTE_TITLE);
  });

  it("keeps the body verbatim after the frontmatter block", () => {
    // bodyAfterFrontmatter keeps the blank separator line the title patch
    // emits between the closing `---` and the body.
    expect(bodyAfterFrontmatter(welcomeNoteMarkdown())).toBe("\n" + WELCOME_NOTE_BODY);
  });

  it("has no leading H1 (the title chip already shows the title)", () => {
    expect(WELCOME_NOTE_BODY.startsWith("#")).toBe(false);
  });

  it("links myne.md as a bare URL (only bare URLs are click-to-open)", () => {
    expect(WELCOME_NOTE_BODY).toContain("https://myne.md");
    expect(WELCOME_NOTE_BODY).not.toContain("](https://myne.md)");
  });
});
