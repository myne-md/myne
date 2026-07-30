// Operator-query ranking tests (MYND-303/307, Slice A). Pure over injected
// deps — no IPC. Pins: BM25-surfaced candidates lead in score order, structural-
// only candidates follow by recency, negated free-text is not a rank signal, the
// empty-candidate short-circuit, and the result cap.

import { describe, expect, it, vi } from "vitest";
import type { NoteSearchResult } from "../../src/types/note-search-result";
import type { LeafResolvers } from "../../src/notes/queryEngine";
import { parseQuery } from "../../src/notes/queryParser";
import {
  OPERATOR_SEARCH_RESULT_CAP,
  collectRankText,
  runOperatorSearch,
  type OperatorSearchDeps,
} from "../../src/notes/searchQuery";

const hit = (
  note_id: string,
  score: number,
  title = note_id,
): NoteSearchResult => ({
  note_id,
  title,
  score,
  matched_in: { title: false, body: true },
  attachment_id: null,
});

/** Deps whose leaves resolve from fixed maps; `search` returns fixed BM25 hits. */
function deps(overrides: Partial<OperatorSearchDeps> = {}): OperatorSearchDeps {
  const resolvers: LeafResolvers = {
    hasTag: vi.fn(async () => []),
    inFolder: vi.fn(async () => []),
    search: vi.fn(async () => []),
    titleMatch: vi.fn(async () => []),
    hasTask: vi.fn(async () => []),
    propertyValues: vi.fn(async () => []),
  };
  return {
    liveIds: new Set(),
    resolvers,
    search: vi.fn(async () => []),
    titleFor: (id) => id,
    recencyFallback: (ids) => ids,
    ...overrides,
  };
}

describe("collectRankText", () => {
  it("collects bare + content + file text, ignores structural leaves", () => {
    expect(collectRankText(parseQuery("tag:work invoice file:report"))).toBe(
      "invoice report",
    );
  });

  it("excludes negated free text from the rank signal", () => {
    expect(collectRankText(parseQuery("rust -draft"))).toBe("rust");
  });

  it("a purely-structural query has no rank text", () => {
    expect(collectRankText(parseQuery("tag:work -tag:archive"))).toBe("");
  });
});

describe("runOperatorSearch", () => {
  it("BM25-surfaced candidates lead in score order; structural-only tail follows by recency", async () => {
    // `invoice OR tag:work`: a,c match "invoice" (BM25 ranks c > a); a,b,c are
    // tagged work. Union = {a,b,c}; b is a work-only candidate (not a text hit),
    // so it falls to the recency tail with a neutral score. `resolvers.search`
    // and `deps.search` agree on the text hits, exactly as production (both are
    // the same `searchNotes` call, one mapped to ids, one full).
    const d = deps({
      liveIds: new Set(["a", "b", "c"]),
      resolvers: {
        hasTag: vi.fn(async () => ["a", "b", "c"]),
        inFolder: vi.fn(async () => []),
        search: vi.fn(async () => ["a", "c"]),
        titleMatch: vi.fn(async () => []),
        hasTask: vi.fn(async () => []),
        propertyValues: vi.fn(async () => []),
      },
      search: vi.fn(async () => [hit("c", 9), hit("a", 3)]),
      recencyFallback: (ids) => [...ids].sort(), // deterministic: b
    });
    const out = await runOperatorSearch(parseQuery("invoice OR tag:work"), d);
    expect(out.map((h) => h.note_id)).toEqual(["c", "a", "b"]);
    expect(out[0]!.score).toBe(9); // BM25 score preserved
    expect(out[2]!.score).toBe(0); // structural-only tail is neutral
  });

  it("a purely-structural query ranks by recency with neutral rows", async () => {
    const d = deps({
      liveIds: new Set(["x", "y"]),
      resolvers: {
        hasTag: vi.fn(async (tag: string) => (tag === "work" ? ["x", "y"] : [])),
        inFolder: vi.fn(async () => []),
        search: vi.fn(async () => []),
        titleMatch: vi.fn(async () => []),
        hasTask: vi.fn(async () => []),
        propertyValues: vi.fn(async () => []),
      },
      search: vi.fn(async () => []),
      titleFor: (id) => `T-${id}`,
      recencyFallback: () => ["y", "x"],
    });
    const out = await runOperatorSearch(parseQuery("tag:work"), d);
    expect(out.map((h) => h.note_id)).toEqual(["y", "x"]);
    expect(out[0]).toMatchObject({ title: "T-y", score: 0, attachment_id: null });
    // The BM25 pass must not run when there is no free-text portion.
    expect(d.search).not.toHaveBeenCalled();
  });

  it("returns [] when no candidate matches (no BM25 call)", async () => {
    const d = deps({ liveIds: new Set(["a"]) });
    const out = await runOperatorSearch(parseQuery("tag:none"), d);
    expect(out).toEqual([]);
    expect(d.search).not.toHaveBeenCalled();
  });

  it("caps the result count", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `n${i}`);
    const d = deps({
      liveIds: new Set(many),
      resolvers: {
        hasTag: vi.fn(async () => many),
        inFolder: vi.fn(async () => []),
        search: vi.fn(async () => []),
        titleMatch: vi.fn(async () => []),
        hasTask: vi.fn(async () => []),
        propertyValues: vi.fn(async () => []),
      },
      recencyFallback: (ids) => ids,
    });
    const out = await runOperatorSearch(parseQuery("tag:work"), d);
    expect(out.length).toBe(OPERATOR_SEARCH_RESULT_CAP);
  });
});
