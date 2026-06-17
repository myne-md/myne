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

/** The note rows of a ranked result (folder rows filtered out), for assertions
 *  that predate folder candidates. */
const noteRows = (rows: ReturnType<typeof rankNotes>) =>
  rows.filter((r): r is Extract<typeof r, { kind: "note" }> => r.kind === "note");
const folderRows = (rows: ReturnType<typeof rankNotes>) =>
  rows.filter((r): r is Extract<typeof r, { kind: "folder" }> => r.kind === "folder");

describe("rankNotes (§6.1)", () => {
  const notes = [
    note("a", "Wednesday", "notes/2025/"),
    note("b", "Weekly Review", "Projects/"),
    note("c", "Welcome", null),
    note("d", null, null), // titleless — excluded
  ];

  it("empty query returns every titled note", () => {
    const rows = noteRows(rankNotes("", notes));
    expect(rows.map((r) => r.note.noteUuid).sort()).toEqual(["a", "b", "c"]);
  });

  it("matches by title", () => {
    const rows = noteRows(rankNotes("week", notes));
    expect(rows.map((r) => r.note.title)).toContain("Weekly Review");
  });

  it("matches by path (folder segment)", () => {
    const rows = noteRows(rankNotes("projects", notes));
    expect(rows.map((r) => r.note.title)).toContain("Weekly Review");
  });

  it("carries the derived path on each row", () => {
    const rows = noteRows(rankNotes("wednesday", notes));
    expect(rows[0]?.path).toBe("notes/2025/Wednesday.md");
  });

  it("excludes titleless notes", () => {
    expect(
      noteRows(rankNotes("", notes)).some((r) => r.note.noteUuid === "d"),
    ).toBe(false);
  });

  it("caps the result", () => {
    const many = Array.from({ length: 120 }, (_, i) => note(`n${i}`, `Note ${i}`, null));
    expect(rankNotes("note", many, 50)).toHaveLength(50);
  });
});

describe("rankNotes folder-target candidates (MYND-370)", () => {
  const notes = [
    note("a", "Wednesday", "notes/2025/"),
    note("b", "Weekly Review", "Projects/"),
    note("c", "Welcome", null), // root note → contributes no folder
  ];

  it("offers each implied folder (ancestor-expanded, trailing-slash form)", () => {
    const paths = folderRows(rankNotes("", notes))
      .map((r) => r.path)
      .sort();
    expect(paths).toEqual(["Projects/", "notes/", "notes/2025/"]);
  });

  it("dedupes folders by folded identity (no duplicate per shared path)", () => {
    const dup = [
      note("a", "One", "Projects/"),
      note("b", "Two", "projects/"), // same folded folder, different case
    ];
    const paths = folderRows(rankNotes("", dup)).map((r) => r.path);
    expect(paths).toHaveLength(1);
  });

  it("filters folders by the query like notes", () => {
    const rows = rankNotes("projects", notes);
    expect(folderRows(rows).map((r) => r.path)).toContain("Projects/");
  });

  it("a matching filter still surfaces notes alongside folders", () => {
    const rows = rankNotes("week", notes);
    // Note "Weekly Review" matches; no folder is named "week", so notes-only here.
    expect(noteRows(rows).map((r) => r.note.title)).toContain("Weekly Review");
  });

  it("contributes no folder for root-only note-sets", () => {
    expect(folderRows(rankNotes("", [note("c", "Welcome", null)]))).toHaveLength(0);
  });
});
