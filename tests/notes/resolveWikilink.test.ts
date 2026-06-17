// Title-keyed wikilink resolution (MYND-144 Task 12). Resolution matches a
// wikilink to a note by TITLE; a path-form link's folder segment is a
// disambiguator on title collision, not the primary key; the note's actual
// `folder:` FM wins over a stale link segment. Spec: wikilink.md §5.3.
//
// MYND-43 (WL-3): the resolver also surfaces `candidates` (all title-matches)
// and a `resolutionHint()` display helper — the single contract the chip hover
// (#2), picker (#3), and R2 conversion (#4) consume.

import { describe, it, expect } from "vitest";
import {
  resolveWikilink,
  resolutionHint,
  type ResolverNote,
} from "../../src/notes/resolveWikilink";
import type { WikilinkRef } from "../../src/dialect/types";

const note = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder });

const ref = (
  target: string,
  targetKind: "title" | "vault-path",
): WikilinkRef => ({
  raw: "",
  byteRange: { start: 0, end: 0 },
  embed: false,
  target,
  targetKind,
  alias: null,
  heading: null,
  blockId: null,
});

describe("resolveWikilink — title key", () => {
  it("resolves a single title hit", () => {
    const r = resolveWikilink(ref("Wednesday", "title"), [
      note("a", "Wednesday", null),
    ]);
    expect(r).toEqual({
      status: "resolved",
      noteUuid: "a",
      ambiguous: false,
      matchCount: 1,
      candidates: [note("a", "Wednesday", null)],
    });
  });

  it("is broken when no title matches", () => {
    const r = resolveWikilink(ref("Wednesday", "title"), [note("a", "Other", null)]);
    expect(r).toEqual({ status: "broken", matchCount: 0, candidates: [] });
  });

  it("matches case-insensitively (fold + NFC)", () => {
    const r = resolveWikilink(ref("wednesday", "title"), [
      note("a", "Wednesday", null),
    ]);
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.noteUuid).toBe("a");
  });

  it("survives a folder move — title unchanged, resolves to the moved note", () => {
    // Single note titled "Foo", now in Archive/. A stale path-form link still
    // says Projects/Foo.md — FM (Archive/) wins; single title hit resolves.
    const r = resolveWikilink(ref("Projects/Foo.md", "vault-path"), [
      note("a", "Foo", "Archive/"),
    ]);
    expect(r).toEqual({
      status: "resolved",
      noteUuid: "a",
      ambiguous: false,
      matchCount: 1,
      candidates: [note("a", "Foo", "Archive/")],
    });
  });
});

describe("resolveWikilink — path key (title from last segment)", () => {
  it("strips .md and resolves by the title component", () => {
    const r = resolveWikilink(ref("Projects/Wednesday.md", "vault-path"), [
      note("a", "Wednesday", "Projects/"),
    ]);
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.noteUuid).toBe("a");
  });
});

describe("resolveWikilink — title collision disambiguation", () => {
  it("uses the link's folder segment to disambiguate", () => {
    const notes = [note("a", "Foo", "Projects/"), note("b", "Foo", "Archive/")];
    const r = resolveWikilink(ref("Projects/Foo.md", "vault-path"), notes);
    expect(r).toEqual({
      status: "resolved",
      noteUuid: "a",
      ambiguous: false,
      matchCount: 2,
      candidates: notes,
    });
  });

  it("falls to shortest-path + flags ambiguity when no folder disambiguates", () => {
    // Two "Foo": Archive/ (depth 1) and Archive/Sub/ (depth 2). A non-matching
    // link folder → shortest-path wins (Archive/), flagged ambiguous.
    const notes = [note("a", "Foo", "Archive/Sub/"), note("b", "Foo", "Archive/")];
    const r = resolveWikilink(ref("Nowhere/Foo.md", "vault-path"), notes);
    expect(r).toEqual({
      status: "resolved",
      noteUuid: "b",
      ambiguous: true,
      matchCount: 2,
      candidates: notes,
    });
  });

  it("title-only collision falls to shortest-path (lexicographic tiebreak at equal depth)", () => {
    const notes = [note("a", "Foo", "Projects/"), note("b", "Foo", "Archive/")];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    // Both depth 1 → lexicographic folded: "archive/" < "projects/" → b.
    expect(r).toEqual({
      status: "resolved",
      noteUuid: "b",
      ambiguous: true,
      matchCount: 2,
      candidates: notes,
    });
  });

  it("a root note (no folder) is the shortest path", () => {
    const notes = [note("a", "Foo", "Projects/"), note("b", "Foo", null)];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    expect(r.status === "resolved" && r.noteUuid).toBe("b"); // depth 0 wins
  });
});

describe("resolveWikilink — candidates (WL-3 single canonical list)", () => {
  it("single hit → candidates is the one resolved note", () => {
    const r = resolveWikilink(ref("Wednesday", "title"), [
      note("a", "Wednesday", null),
      note("b", "Other", null),
    ]);
    expect(r.candidates).toEqual([note("a", "Wednesday", null)]);
    expect(r.candidates.length).toBe(r.matchCount);
  });

  it("multi-hit → candidates holds every title-match in note-set order", () => {
    const notes = [
      note("a", "Foo", "Projects/"),
      note("z", "Bar", null),
      note("b", "Foo", "Archive/"),
    ];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    // Deterministic filter order over the note-set: a before b; "Bar" excluded.
    expect(r.candidates).toEqual([
      note("a", "Foo", "Projects/"),
      note("b", "Foo", "Archive/"),
    ]);
    expect(r.candidates.length).toBe(r.matchCount);
  });

  it("broken → candidates is empty", () => {
    const r = resolveWikilink(ref("Nope", "title"), [note("a", "Other", null)]);
    expect(r.candidates).toEqual([]);
    expect(r.matchCount).toBe(0);
  });
});

describe("resolutionHint — shared display-hint (§6.2 copy)", () => {
  it("broken → (no match)", () => {
    const r = resolveWikilink(ref("Nope", "title"), [note("a", "Other", null)]);
    expect(resolutionHint(r)).toEqual({
      broken: true,
      ambiguous: false,
      text: "(no match)",
    });
  });

  it("clean single resolved → empty parenthetical", () => {
    const r = resolveWikilink(ref("Wednesday", "title"), [
      note("a", "Wednesday", null),
    ]);
    expect(resolutionHint(r)).toEqual({
      broken: false,
      ambiguous: false,
      text: "",
    });
  });

  it("ambiguous → (N matches) with the exact count", () => {
    const notes = [
      note("a", "Foo", "Projects/"),
      note("b", "Foo", "Archive/"),
      note("c", "Foo", "Notes/"),
    ];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    expect(r.status === "resolved" && r.ambiguous).toBe(true);
    expect(resolutionHint(r)).toEqual({
      broken: false,
      ambiguous: true,
      text: "(3 matches)",
    });
  });
});

// === MYND-370: folder-target wikilinks (`[[Projects/]]`) ===
describe("resolveWikilink — folder target", () => {
  const idxNote = (
    noteUuid: string,
    title: string | null,
    folder: string | null,
    folderIndex: boolean,
  ): ResolverNote => ({ noteUuid, title, folder, folderIndex });

  it("resolves `[[Projects/]]` to the folder's index note", () => {
    const r = resolveWikilink(ref("Projects/", "vault-path"), [
      idxNote("idx", "Projects", "Projects/", true),
      note("other", "Notes", "Projects/"),
    ]);
    expect(r.status).toBe("resolved");
    expect(r.status === "resolved" && r.noteUuid).toBe("idx");
  });

  it("is broken with no-folder-note hint when the folder exists but has no index", () => {
    const r = resolveWikilink(ref("Projects/", "vault-path"), [
      note("a", "Notes", "Projects/"),
    ]);
    expect(r.status).toBe("broken");
    expect(r.status === "broken" && r.brokenReason).toBe("no-folder-note");
    expect(resolutionHint(r)).toEqual({
      broken: true,
      ambiguous: false,
      text: "(no folder note)",
    });
  });

  it("is broken with no-match hint when the folder does not exist at all", () => {
    const r = resolveWikilink(ref("Ghost/", "vault-path"), [
      idxNote("idx", "Projects", "Projects/", true),
    ]);
    expect(r.status).toBe("broken");
    expect(r.status === "broken" && r.brokenReason).toBe("no-match");
    expect(resolutionHint(r)).toEqual({
      broken: true,
      ambiguous: false,
      text: "(no match)",
    });
  });

  it("does not treat `[[Projects]]` (no slash) as a folder target", () => {
    // No trailing slash → ordinary title resolution; a note titled "Projects"
    // resolves, the index note does not interfere.
    const r = resolveWikilink(ref("Projects", "title"), [
      note("titled", "Projects", null),
      idxNote("idx", "Index", "Projects/", true),
    ]);
    expect(r.status === "resolved" && r.noteUuid).toBe("titled");
  });

  it("resolves a nested folder target `[[Projects/Myne/]]`", () => {
    const r = resolveWikilink(ref("Projects/Myne/", "vault-path"), [
      idxNote("idx", "Myne", "Projects/Myne/", true),
      note("other", "Sibling", "Projects/"),
    ]);
    expect(r.status === "resolved" && r.noteUuid).toBe("idx");
  });

  it("picks the smallest-uuid winner on multiple index claimants", () => {
    const r = resolveWikilink(ref("Projects/", "vault-path"), [
      idxNote("n-b", "B", "Projects/", true),
      idxNote("n-a", "A", "Projects/", true),
    ]);
    expect(r.status === "resolved" && r.noteUuid).toBe("n-a");
  });
});
