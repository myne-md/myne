// The `[[` picker offers recently touched notes first (myne-md/myne#601).
//
// A vault has many titles that fuzzy-match two letters equally well, and the one
// being linked to is almost always a note that was just open. Recency is a
// TIEBREAK, so it never outranks a better match, except on an empty query,
// where every candidate scores the same and recency is the only order there is.
// That is the case the picker opens in.

import { describe, expect, it } from "vitest";
import { rankNotes } from "../../src/editor/wikilink/picker-rank";
import type { ResolverNote } from "../../src/editor/host/notes/resolveWikilink";

const note = (noteUuid: string, title: string): ResolverNote => ({
  noteUuid,
  title,
  folder: null,
});

const NOTES = [note("a", "Alpha"), note("b", "Beta"), note("c", "Gamma")];

/** Titles of the note rows, in offered order. */
const titles = (rows: ReturnType<typeof rankNotes>): string[] =>
  rows.flatMap((r) => (r.kind === "note" ? [r.note.title ?? ""] : []));

describe("recency ordering", () => {
  it("orders an EMPTY query by recency, newest first", () => {
    expect(titles(rankNotes("", NOTES, ["c", "a"]))).toEqual([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
  });

  it("leaves the note-set order alone when nothing has been touched", () => {
    expect(titles(rankNotes("", NOTES, []))).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("puts an untouched note after every touched one", () => {
    expect(titles(rankNotes("", NOTES, ["b"]))).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });

  it("does NOT outrank a better match", () => {
    // "Gamma" is the only real match for `gam`; recency must not lift a note
    // that matches worse above it.
    const rows = titles(rankNotes("gam", NOTES, ["a", "b"]));
    expect(rows[0]).toBe("Gamma");
  });

  it("breaks ties between equally-matched notes", () => {
    const twins = [note("x", "Report May"), note("y", "Report June")];
    // Both match `report` equally; the touched one comes first, and flipping the
    // recency flips the order, which is what makes this a tiebreak and not the
    // note-set order showing through.
    expect(titles(rankNotes("report", twins, ["y"]))[0]).toBe("Report June");
    expect(titles(rankNotes("report", twins, ["x"]))[0]).toBe("Report May");
  });

  it("ignores ids that are not in the note-set", () => {
    expect(titles(rankNotes("", NOTES, ["gone", "b"]))).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });
});
