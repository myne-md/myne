// Title-keyed wikilink resolution (MYND-144 Task 12). Resolution matches a
// wikilink to a note by TITLE; a path-form link's folder segment is a
// disambiguator on title collision, not the primary key; the note's actual
// `folder:` FM wins over a stale link segment. Spec: wikilink.md §5.3.

import { describe, it, expect } from "vitest";
import {
  resolveWikilink,
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
    expect(r).toEqual({ status: "resolved", noteUuid: "a", ambiguous: false, matchCount: 1 });
  });

  it("is broken when no title matches", () => {
    const r = resolveWikilink(ref("Wednesday", "title"), [note("a", "Other", null)]);
    expect(r).toEqual({ status: "broken", matchCount: 0 });
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
    expect(r).toEqual({ status: "resolved", noteUuid: "a", ambiguous: false, matchCount: 1 });
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
    expect(r).toEqual({ status: "resolved", noteUuid: "a", ambiguous: false, matchCount: 2 });
  });

  it("falls to shortest-path + flags ambiguity when no folder disambiguates", () => {
    // Two "Foo": Archive/ (depth 1) and Archive/Sub/ (depth 2). A non-matching
    // link folder → shortest-path wins (Archive/), flagged ambiguous.
    const notes = [note("a", "Foo", "Archive/Sub/"), note("b", "Foo", "Archive/")];
    const r = resolveWikilink(ref("Nowhere/Foo.md", "vault-path"), notes);
    expect(r).toEqual({ status: "resolved", noteUuid: "b", ambiguous: true, matchCount: 2 });
  });

  it("title-only collision falls to shortest-path (lexicographic tiebreak at equal depth)", () => {
    const notes = [note("a", "Foo", "Projects/"), note("b", "Foo", "Archive/")];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    // Both depth 1 → lexicographic folded: "archive/" < "projects/" → b.
    expect(r).toEqual({ status: "resolved", noteUuid: "b", ambiguous: true, matchCount: 2 });
  });

  it("a root note (no folder) is the shortest path", () => {
    const notes = [note("a", "Foo", "Projects/"), note("b", "Foo", null)];
    const r = resolveWikilink(ref("Foo", "title"), notes);
    expect(r.status === "resolved" && r.noteUuid).toBe("b"); // depth 0 wins
  });
});
