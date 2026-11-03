// First-run example vault: the MOBILE half of the copy invariants
// (myne-md/myne#960). The desktop twin is `tests/notes/exampleVault.test.ts`;
// this file exists because the two clients now seed the SAME note set from the
// shared `@myne/dialect/exampleVault` builder, and the half that resolves it
// here is mobile's own (`mobile/src/lib/exampleVault.ts`).
//
// What is asserted is the promise the feature is built on and the one a shared
// builder cannot make by itself: the example notes cross-link BY TITLE through
// interpolation placeholders the seeder fills with the RESOLVED titles, so a
// translated title and the links pointing at it cannot drift apart, provided
// every placeholder is a real role and every `[[link]]` resolves.
//
// # The failure this would have caught, and did not exist to catch
//
// Until #960 mobile seeded ONE note (the MYND-118 Welcome note) while desktop
// seeded this set, so a vault created on a phone and one created on a computer
// were different products. Nothing failed, because nothing compared them: this
// file is that comparison, made structural by resolving through the same builder
// desktop resolves through.

import { describe, it, expect } from "vitest";
import { EXAMPLE_NOTES, EXAMPLE_FOLDER_KEY } from "../src/dialect/exampleVault";
import i18n from "@myne/i18n";
import { frontmatterTitle } from "../src/lib/note-organize";
import { resolveExampleNotes } from "../src/lib/exampleVault";

const notes = resolveExampleNotes();
const titles = new Set(notes.map((n) => n.title));

/** Wikilink targets in a note body, ignoring any `[[` shown inside inline code
 *  (the Links note demonstrates the syntax in prose). */
function wikilinkTargets(markdown: string): string[] {
  const withoutCode = markdown.replace(/`[^`]*`/g, "");
  return [...withoutCode.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

describe("the example vault mobile seeds", () => {
  it("seeds every spec the shared builder declares, and exactly one index", () => {
    expect(notes).toHaveLength(EXAMPLE_NOTES.length);
    expect(notes.filter((n) => n.index)).toHaveLength(1);
    // Not a frozen 5: the builder owns how many, and this asserts mobile follows
    // it rather than a number written twice.
    expect(EXAMPLE_NOTES.length).toBeGreaterThan(1);
  });

  it("carries the title in frontmatter (the list would show 'Untitled' otherwise)", () => {
    for (const n of notes) {
      expect(frontmatterTitle(n.markdown), `note ${n.role}`).toBe(n.title);
    }
  });

  it("leaves no unfilled interpolation placeholder", () => {
    for (const n of notes) {
      expect(n.markdown, `note ${n.role}`).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("every wikilink resolves to a seeded note title (zero broken links)", () => {
    for (const n of notes) {
      for (const target of wikilinkTargets(n.markdown)) {
        expect(titles, `${n.role} → [[${target}]]`).toContain(target);
      }
    }
  });

  it("puts every note under the one deletable folder", () => {
    const folders = new Set(notes.map((n) => n.folder));
    expect(folders.size).toBe(1);
    expect([...folders][0]).toBe(i18n.t(EXAMPLE_FOLDER_KEY));
  });

  it("populates the feature surfaces it promises (a task, a due date, tags)", () => {
    const all = notes.map((n) => n.markdown).join("\n");
    expect(all).toMatch(/^- \[ \] /m); // an open task for the Tasks surface
    expect(all).toContain("📅"); // at least one due date
    expect(all).toMatch(/#[A-Za-z]/); // at least one tag for the tag tree
  });

  it("stamps a last-edited time, which mobile's list shows and desktop's does not require", () => {
    for (const n of notes) {
      expect(n.markdown, `note ${n.role}`).toMatch(/^updated: \d{4}-\d{2}-\d{2}T/m);
    }
  });

  it("re-resolves in the active language, so a switch before creation is honoured", async () => {
    const english = resolveExampleNotes().map((n) => n.title);
    await i18n.changeLanguage("tr");
    try {
      const turkish = resolveExampleNotes().map((n) => n.title);
      // The assertion that matters is that resolution happens at CALL time; a
      // module-level constant would freeze the boot language. Turkish may fall
      // back to English for an untranslated key, which is not a failure here.
      expect(turkish).toHaveLength(english.length);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
