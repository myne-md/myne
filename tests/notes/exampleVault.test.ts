// #393 — first-run example vault copy invariants.
//
// The example notes cross-link BY TITLE. The bodies name their targets through
// i18n interpolation placeholders that the seeder fills with the RESOLVED
// titles, so a link can never break — but only if the copy holds up its end:
// every placeholder must be a real note role, and every `[[link]]` must resolve
// to a seeded title. These run under Vitest's English boot language and pin the
// "zero broken links" promise the feature is built on.

import { describe, it, expect } from "vitest";
import { resolveExampleNotes } from "../../src/notes/exampleVault";

const notes = resolveExampleNotes();
const titles = new Set(notes.map((n) => n.title));

/** Wikilink targets in a note body, ignoring any `[[` shown inside inline code
 *  (the Links note demonstrates the syntax in prose). */
function wikilinkTargets(markdown: string): string[] {
  // Strip inline-code spans first so a documented `[[` example is not counted.
  const withoutCode = markdown.replace(/`[^`]*`/g, "");
  return [...withoutCode.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
}

describe("example vault copy (#393)", () => {
  it("seeds five notes, exactly one of them the index", () => {
    expect(notes).toHaveLength(5);
    expect(notes.filter((n) => n.index)).toHaveLength(1);
  });

  // A title key that is absent from the catalog resolves to the KEY ITSELF, so
  // a note is seeded named `notes.example.tasks.title` and nothing anywhere
  // fails: the seeder writes it, the sidebar renders it, and the only way to
  // notice is to read the vault. That is what shipped on 0.18.0, in the two
  // catalogs nobody would have guessed were the broken ones (English and
  // Turkish). Titles and folder are what a user reads first, so the invariant
  // is that neither is ever key-shaped.
  it("resolves every seeded title and the folder to copy, never to a key", () => {
    for (const n of notes) {
      expect(n.title, `note ${n.role}`).not.toMatch(/^[\w.]+\.[\w.]+$/);
      expect(n.folder, `folder of ${n.role}`).not.toMatch(/^[\w.]+\.[\w.]+$/);
      expect(n.title.trim(), `note ${n.role}`).not.toBe("");
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
    expect([...folders][0]).toBeTruthy();
  });

  it("populates the feature surfaces it promises (a task, a due date, tags)", () => {
    const all = notes.map((n) => n.markdown).join("\n");
    expect(all).toMatch(/^- \[ \] /m); // an open task for the Tasks surface
    expect(all).toContain("📅"); // at least one due date
    expect(all).toMatch(/#[A-Za-z]/); // at least one tag for the tag tree
  });
});
