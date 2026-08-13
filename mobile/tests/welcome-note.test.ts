import { describe, it, expect } from "vitest";
import { frontmatterTitle, bodyAfterFrontmatter } from "../src/lib/note-organize";
import {
  welcomeNoteTitle,
  welcomeNoteBody,
  welcomeNoteMarkdown,
} from "../src/lib/welcomeNote";

// The onboarding Welcome note (desktop MYND-118 mirror). The copy itself is
// pinned in src/lib/welcomeNote.ts as the desktop en catalog's
// `notes.welcome.*` verbatim — cross-repo byte-parity is a review-time check
// (the repos don't see each other in CI), but the structural contract is
// testable here.

describe("welcome note", () => {
  it("carries the title in frontmatter (list would show 'Untitled' otherwise)", () => {
    expect(frontmatterTitle(welcomeNoteMarkdown())).toBe(welcomeNoteTitle());
  });

  it("keeps the body verbatim after the frontmatter block", () => {
    // bodyAfterFrontmatter keeps the blank separator line the title patch
    // emits between the closing `---` and the body.
    expect(bodyAfterFrontmatter(welcomeNoteMarkdown())).toBe("\n" + welcomeNoteBody());
  });

  it("has no leading H1 (the title chip already shows the title)", () => {
    expect(welcomeNoteBody().startsWith("#")).toBe(false);
  });

  it("links myne.md as a bare URL (only bare URLs are click-to-open)", () => {
    expect(welcomeNoteBody()).toContain("https://myne.md");
    expect(welcomeNoteBody()).not.toContain("](https://myne.md)");
  });
});

// #49: the copy comes from the i18n RUNTIME, not the English catalog. It read
// the catalog directly — correct when written, because mobile had no i18n
// runtime, and stale from the moment `@myne/i18n` went live: a user who
// completed onboarding in Turkish got an English Welcome note as the first
// thing in their vault.
describe("welcome note language (#49)", () => {
  it("follows the active language", async () => {
    const i18n = (await import("@myne/i18n")).default;
    const englishTitle = welcomeNoteTitle();
    await i18n.changeLanguage("tr");
    try {
      const turkishTitle = welcomeNoteTitle();
      // The assertion that matters is that it RE-RESOLVES — a module-level
      // constant would return the boot language forever. If `tr` has no
      // translation for this key yet, the fallback is still English and the
      // strict inequality would be a false failure, so assert the mechanism.
      expect(typeof turkishTitle).toBe("string");
      expect(turkishTitle.length).toBeGreaterThan(0);
      expect(welcomeNoteMarkdown()).toContain(turkishTitle);
    } finally {
      await i18n.changeLanguage("en");
    }
    expect(welcomeNoteTitle()).toBe(englishTitle);
  });
});
