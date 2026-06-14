// Tag-filter model tests (tag-system #1 / MYND-46). Covers the pure AND/OR set
// algebra (combineTagSets) — the bulk of the behavior — and the thin async
// orchestration (tagFilterIds) with `byTag` mocked, so no IPC/Tauri is needed.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notes/vaultIndices", () => ({
  byTag: vi.fn(),
}));

import { byTag } from "../../src/notes/vaultIndices";
import {
  combineTagSets,
  combineWithProvenance,
  DEFAULT_FILTER_MODE,
  sameFilterResult,
  stabilizeResult,
  tagFilter,
  tagFilterRows,
  type TagFilterResult,
} from "../../src/notes/tagFilter";

const mockByTag = vi.mocked(byTag);

// Minimal TitleRecord-shaped record (sortBatchIds reads updatedAt; rows read
// title). The test isn't tsc-checked, so a partial object is fine at runtime.
const trec = (title: string | null, ms: number | null) => ({
  noteUuid: "x",
  title,
  folder: null,
  updatedAt: ms === null ? null : new Date(ms),
  trashed: null,
});

describe("combineTagSets", () => {
  it("AND returns the intersection of all lists", () => {
    expect(combineTagSets([["a", "b", "c"], ["b", "c", "d"]], "and")).toEqual([
      "b",
      "c",
    ]);
  });

  it("OR returns the union, deduped, in first-seen order", () => {
    expect(combineTagSets([["a", "b"], ["b", "c"]], "or")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("a single list returns that list (n=1), in both modes", () => {
    expect(combineTagSets([["a", "b"]], "and")).toEqual(["a", "b"]);
    expect(combineTagSets([["a", "b"]], "or")).toEqual(["a", "b"]);
  });

  it("zero lists → empty (the 0-tag no-filter identity), in both modes", () => {
    expect(combineTagSets([], "and")).toEqual([]);
    expect(combineTagSets([], "or")).toEqual([]);
  });

  it("parent ∩ child = child (raw subtree algebra, TS-2)", () => {
    // byTag is subtree-inclusive: parent ⊇ child. AND collapses to the child set,
    // OR collapses to the parent set — no redundancy detection.
    const parent = ["n1", "n2", "n3"]; // #a (incl. descendants)
    const child = ["n2", "n3"]; //        #a/b
    expect(combineTagSets([parent, child], "and")).toEqual(["n2", "n3"]);
    expect(combineTagSets([parent, child], "or")).toEqual(["n1", "n2", "n3"]);
  });

  it("AND with no overlap → empty", () => {
    expect(combineTagSets([["a"], ["b"]], "and")).toEqual([]);
  });

  it("preserves the first list's order under AND", () => {
    expect(combineTagSets([["c", "a", "b"], ["a", "b", "c"]], "and")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});

describe("DEFAULT_FILTER_MODE", () => {
  it("is AND (TS-2 ratified default)", () => {
    expect(DEFAULT_FILTER_MODE).toBe("and");
  });
});

describe("combineWithProvenance", () => {
  it("AND → every surviving id matched all selected keys", () => {
    expect(
      combineWithProvenance(
        [
          { key: "a", ids: ["n1", "n2", "n3"] },
          { key: "a/b", ids: ["n2", "n3"] },
        ],
        "and",
      ),
    ).toEqual([
      { noteId: "n2", matchedKeys: ["a", "a/b"] },
      { noteId: "n3", matchedKeys: ["a", "a/b"] },
    ]);
  });

  it("OR → matchedKeys is exactly the subset of keys that matched", () => {
    expect(
      combineWithProvenance(
        [
          { key: "a", ids: ["n1", "n2"] },
          { key: "b", ids: ["n2", "n3"] },
        ],
        "or",
      ),
    ).toEqual([
      { noteId: "n1", matchedKeys: ["a"] },
      { noteId: "n2", matchedKeys: ["a", "b"] },
      { noteId: "n3", matchedKeys: ["b"] },
    ]);
  });
});

describe("tagFilterRows", () => {
  it("recency-sorts (updatedAt desc), carries title + matchedKeys, counts", () => {
    const cache = new Map<string, ReturnType<typeof trec>>([
      ["n1", trec("Old", 1000)],
      ["n2", trec("New", 3000)],
      ["n3", trec("Mid", 2000)],
    ]);
    const out = tagFilterRows(
      [
        { noteId: "n1", matchedKeys: ["a"] },
        { noteId: "n2", matchedKeys: ["a"] },
        { noteId: "n3", matchedKeys: ["a"] },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cache as any,
    );
    expect(out.rows.map((r) => r.noteId)).toEqual(["n2", "n3", "n1"]);
    expect(out.rows.map((r) => r.title)).toEqual(["New", "Mid", "Old"]);
    expect(out.rows[0].matchedKeys).toEqual(["a"]);
    expect(out.count).toBe(3);
  });

  it("missing/null title → null; count includes all combined ids", () => {
    const cache = new Map<string, ReturnType<typeof trec>>([
      ["n1", trec(null, 1000)],
    ]);
    const out = tagFilterRows(
      [
        { noteId: "n1", matchedKeys: [] },
        { noteId: "n2", matchedKeys: [] },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cache as any,
    );
    expect(out.rows.find((r) => r.noteId === "n1")?.title).toBeNull();
    expect(out.rows.find((r) => r.noteId === "n2")?.title).toBeNull();
    expect(out.count).toBe(2);
  });
});

describe("tagFilter (end-to-end)", () => {
  beforeEach(() => mockByTag.mockReset());

  it("0 tags → empty result, no IPC", async () => {
    const out = await tagFilter([], "and", new Set(), new Map());
    expect(out).toEqual({ rows: [], count: 0 });
    expect(mockByTag).not.toHaveBeenCalled();
  });

  it("resolves byTag, AND-combines, shapes + recency-sorts with provenance", async () => {
    const live = new Set(["n1", "n2", "n3"]);
    mockByTag.mockImplementation(async (tag) =>
      tag === "a" ? ["n1", "n2", "n3"] : ["n2", "n3"],
    );
    const cache = new Map<string, ReturnType<typeof trec>>([
      ["n2", trec("Beta", 5000)],
      ["n3", trec("Alpha", 9000)],
    ]);
    const out = await tagFilter(
      ["a", "a/b"],
      "and",
      live,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cache as any,
    );
    expect(out.rows.map((r) => r.noteId)).toEqual(["n3", "n2"]); // recency desc
    expect(out.count).toBe(2);
    expect(out.rows[0].matchedKeys).toEqual(["a", "a/b"]);
  });
});

describe("sameFilterResult / stabilizeResult", () => {
  const result = (
    rows: Array<{ noteId: string; title: string | null; matchedKeys: string[] }>,
  ): TagFilterResult => ({ rows, count: rows.length });

  it("sameFilterResult is true for value-equal results", () => {
    const a = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    const b = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    expect(sameFilterResult(a, b)).toBe(true);
  });

  it("sameFilterResult is false on any row / matchedKeys / count diff", () => {
    const a = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    expect(
      sameFilterResult(
        a,
        result([{ noteId: "n2", title: "A", matchedKeys: ["x"] }]),
      ),
    ).toBe(false);
    expect(
      sameFilterResult(
        a,
        result([{ noteId: "n1", title: "B", matchedKeys: ["x"] }]),
      ),
    ).toBe(false);
    expect(
      sameFilterResult(
        a,
        result([{ noteId: "n1", title: "A", matchedKeys: ["y"] }]),
      ),
    ).toBe(false);
    expect(sameFilterResult(a, result([]))).toBe(false);
  });

  it("stabilizeResult returns the PREVIOUS reference when value-equal (render bail)", () => {
    const prev = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    const next = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    expect(stabilizeResult(prev, next)).toBe(prev); // reference-equal
  });

  it("stabilizeResult returns NEXT when changed, or when there is no prev", () => {
    const prev = result([{ noteId: "n1", title: "A", matchedKeys: ["x"] }]);
    const next = result([{ noteId: "n2", title: "B", matchedKeys: ["y"] }]);
    expect(stabilizeResult(prev, next)).toBe(next);
    expect(stabilizeResult(null, next)).toBe(next);
  });
});
