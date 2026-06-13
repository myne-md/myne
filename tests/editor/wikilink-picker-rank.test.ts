// `[[` picker ranking (MYND-38) — fuzzy over title + path, capped.

import { describe, it, expect } from "vitest";
import { rankNotes } from "../../src/editor/wikilink/picker-rank";
import { notePath, type ResolverNote } from "../../src/notes/resolveWikilink";

const note = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder });

describe("notePath", () => {
  it("derives <folder>/<title>.md; root → <title>.md", () => {
    expect(notePath(note("a", "Wednesday", null))).toBe("Wednesday.md");
    expect(notePath(note("b", "Foo", "Projects/"))).toBe("Projects/Foo.md");
  });
});

describe("rankNotes (§6.1)", () => {
  const notes = [
    note("a", "Wednesday", "notes/2025/"),
    note("b", "Weekly Review", "Projects/"),
    note("c", "Welcome", null),
    note("d", null, null), // titleless — excluded
  ];

  it("empty query returns every titled note", () => {
    const rows = rankNotes("", notes);
    expect(rows.map((r) => r.note.noteUuid).sort()).toEqual(["a", "b", "c"]);
  });

  it("matches by title", () => {
    const rows = rankNotes("week", notes);
    expect(rows.map((r) => r.note.title)).toContain("Weekly Review");
  });

  it("matches by path (folder segment)", () => {
    const rows = rankNotes("projects", notes);
    expect(rows.map((r) => r.note.title)).toContain("Weekly Review");
  });

  it("carries the derived path on each row", () => {
    const rows = rankNotes("wednesday", notes);
    expect(rows[0]?.path).toBe("notes/2025/Wednesday.md");
  });

  it("excludes titleless notes", () => {
    expect(rankNotes("", notes).some((r) => r.note.noteUuid === "d")).toBe(false);
  });

  it("caps the result", () => {
    const many = Array.from({ length: 120 }, (_, i) => note(`n${i}`, `Note ${i}`, null));
    expect(rankNotes("note", many, 50)).toHaveLength(50);
  });
});
