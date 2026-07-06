import { describe, it, expect } from "vitest";
import { searchNotes, matchSnippet } from "../src/lib/search-notes";

const notes = [
  { id: "1", title: "Threat model", snippet: "adversary" },
  { id: "2", title: "Weekly review", snippet: "shipped" },
  { id: "3", title: "Reading list", snippet: "books" },
];
const bodies = new Map([
  ["1", "We assume a powerful network adversary that can observe all traffic."],
  ["2", "Shipped the sync resolver. Next: mobile share sheet."],
  ["3", "Seeing Like a State — legibility notes."],
]);

describe("searchNotes()", () => {
  it("returns every note (score 0) for an empty query", () => {
    const r = searchNotes("  ", notes, bodies);
    expect(r.map((h) => h.id)).toEqual(["1", "2", "3"]);
    expect(r.every((h) => h.score === 0)).toBe(true);
  });

  it("matches note BODY content, not just title/snippet", () => {
    // "adversary" is in body #1 (and its snippet); "traffic" is body-only.
    expect(searchNotes("traffic", notes, bodies).map((h) => h.id)).toEqual(["1"]);
  });

  it("ranks a title match above a body-only match", () => {
    const rankNotes = [
      { id: "a", title: "cats", snippet: "" },
      { id: "b", title: "dogs", snippet: "" },
    ];
    const rankBodies = new Map([
      ["a", ""],
      ["b", "i really love cats"],
    ]);
    expect(searchNotes("cats", rankNotes, rankBodies).map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("requires ALL terms (AND semantics)", () => {
    expect(searchNotes("sync mobile", notes, bodies).map((h) => h.id)).toEqual(["2"]);
    expect(searchNotes("sync zzznope", notes, bodies)).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchNotes("SHIPPED", notes, bodies).map((h) => h.id)).toEqual(["2"]);
  });
});

describe("matchSnippet()", () => {
  it("returns a context window around the term", () => {
    const s = matchSnippet("alpha beta gamma delta epsilon zeta eta theta", "gamma");
    expect(s).toContain("gamma");
  });

  it("returns null when the term is absent", () => {
    expect(matchSnippet("nothing to see here", "xyz")).toBeNull();
  });
});
