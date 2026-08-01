// Query-engine filter evaluator tests (MYND-272, Saved Views #2, task 1).
// Pure evaluator with injected leaf resolvers — no IPC. Covers the boolean set
// algebra (reused `combineTagSets`), the single live-set gate (T3), `not`
// complementing the live set only, de Morgan equivalence, n=0/n=1 collapse, and
// the anti-eval invariant (no arithmetic/map node is representable).

import { describe, expect, it, vi } from "vitest";
import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  comparePropertyValue,
  evaluateFilter,
  folderSubtreeNoteIds,
  groupByProperty,
  runView,
  sameViewResult,
  sortGroupIds,
  stabilizeViewResult,
  type FilterNode,
  type LeafResolvers,
  type RunViewContext,
  type StoredProperty,
  type ViewDefinition,
} from "../../src/notes/queryEngine";

// Universe: a..e live; "trash1" is NOT in the live set (trashed/template).
const LIVE = new Set(["a", "b", "c", "d", "e"]);

/** Fake resolvers backed by fixed tag / query / folder / property maps. */
function resolvers(
  tags: Record<string, string[]>,
  searches: Record<string, string[]> = {},
  folders: Record<string, string[]> = {},
  props: Record<string, Array<readonly [string, StoredProperty]>> = {},
): LeafResolvers {
  return {
    hasTag: vi.fn(async (tag: string) => tags[tag] ?? []),
    inFolder: vi.fn(async (path: string) => folders[path] ?? []),
    search: vi.fn(async (query: string) => searches[query] ?? []),
    titleMatch: vi.fn(async (query: string) => searches[query] ?? []),
    hasTask: vi.fn(async () => []),
    propertyValues: vi.fn(async (key: string) => props[key] ?? []),
  };
}

const num = (key: string, value: string): StoredProperty => ({ key, type: "number", value });
const str = (key: string, value: string): StoredProperty => ({ key, type: "string", value });
const date = (key: string, value: string): StoredProperty => ({ key, type: "date", value });
const check = (key: string, value: string): StoredProperty => ({ key, type: "checkbox", value });
const list = (key: string, vals: Array<[StoredProperty["type"], string]>): StoredProperty => ({
  key,
  type: "list",
  elements: vals.map(([type, value]) => ({ type: type as "string", value })),
});

const sorted = (ids: string[]) => [...ids].sort();

describe("evaluateFilter — leaves + live-set gate", () => {
  it("all → the full live set", async () => {
    expect(sorted(await evaluateFilter({ kind: "all" }, LIVE, resolvers({})))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("hasTag returns the tag's ids, gated to the live set", async () => {
    const r = resolvers({ proj: ["a", "c", "trash1"] });
    const out = await evaluateFilter({ kind: "hasTag", tag: "proj" }, LIVE, r);
    expect(sorted(out)).toEqual(["a", "c"]); // trash1 dropped by the live gate
  });

  it("search results are gated to the live set (no trashed leak)", async () => {
    const r = resolvers({}, { rust: ["b", "trash1", "d"] });
    const out = await evaluateFilter({ kind: "search", query: "rust" }, LIVE, r);
    expect(sorted(out)).toEqual(["b", "d"]);
  });
});

describe("evaluateFilter — boolean composition (reused set algebra)", () => {
  const r = resolvers({ x: ["a", "b", "c"], y: ["b", "c", "d"], z: ["e"] });

  it("and = intersection", async () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "hasTag", tag: "x" },
        { kind: "hasTag", tag: "y" },
      ],
    };
    expect(sorted(await evaluateFilter(node, LIVE, r))).toEqual(["b", "c"]);
  });

  it("or = union", async () => {
    const node: FilterNode = {
      kind: "or",
      children: [
        { kind: "hasTag", tag: "x" },
        { kind: "hasTag", tag: "z" },
      ],
    };
    expect(sorted(await evaluateFilter(node, LIVE, r))).toEqual(["a", "b", "c", "e"]);
  });

  it("not complements against the live set only", async () => {
    const node: FilterNode = { kind: "not", child: { kind: "hasTag", tag: "x" } };
    // live \ {a,b,c} = {d,e}; never reintroduces trash1.
    expect(sorted(await evaluateFilter(node, LIVE, r))).toEqual(["d", "e"]);
  });

  it("de Morgan: not(and(x,y)) == or(not x, not y)", async () => {
    const lhs: FilterNode = {
      kind: "not",
      child: {
        kind: "and",
        children: [
          { kind: "hasTag", tag: "x" },
          { kind: "hasTag", tag: "y" },
        ],
      },
    };
    const rhs: FilterNode = {
      kind: "or",
      children: [
        { kind: "not", child: { kind: "hasTag", tag: "x" } },
        { kind: "not", child: { kind: "hasTag", tag: "y" } },
      ],
    };
    expect(sorted(await evaluateFilter(lhs, LIVE, r))).toEqual(
      sorted(await evaluateFilter(rhs, LIVE, r)),
    );
  });

  it("collapses like combineTagSets: empty and → [], single child → that set", async () => {
    expect(await evaluateFilter({ kind: "and", children: [] }, LIVE, r)).toEqual([]);
    expect(await evaluateFilter({ kind: "or", children: [] }, LIVE, r)).toEqual([]);
    const single: FilterNode = {
      kind: "and",
      children: [{ kind: "hasTag", tag: "z" }],
    };
    expect(await evaluateFilter(single, LIVE, r)).toEqual(["e"]);
  });

  it("composes a nested tree (and over a search + a not)", async () => {
    const r2 = resolvers({ x: ["a", "b", "c"] }, { q: ["a", "c", "d"] });
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "search", query: "q" }, // {a,c,d}
        { kind: "not", child: { kind: "hasTag", tag: "x" } }, // {d,e}
      ],
    };
    expect(sorted(await evaluateFilter(node, LIVE, r2))).toEqual(["d"]);
  });
});

describe("folderSubtreeNoteIds — subtree-inclusive folder aggregation (task 2)", () => {
  const tree = deriveFolderTree(
    [
      { noteUuid: "a", folder: "Projects/" },
      { noteUuid: "b", folder: "Projects/Myne/" },
      { noteUuid: "c", folder: "Projects/Myne/Sub/" },
      { noteUuid: "d", folder: "Other/" },
      { noteUuid: "e", folder: null }, // unfiled
      { noteUuid: "t", folder: "Çalışma/" }, // Turkish-fold case
    ],
    [],
    [],
  );

  it("aggregates the folder PLUS all descendants (not exact-only)", () => {
    expect(sorted(folderSubtreeNoteIds(tree, "Projects/"))).toEqual(["a", "b", "c"]);
  });

  it("a deeper folder aggregates its own subtree", () => {
    expect(sorted(folderSubtreeNoteIds(tree, "Projects/Myne/"))).toEqual(["b", "c"]);
  });

  it("exact-match-only would be a regression — descendant 'c' is included under Projects/", () => {
    expect(folderSubtreeNoteIds(tree, "Projects/")).toContain("c");
  });

  it("folds the query path (case-insensitive; trailing slash tolerant)", () => {
    expect(sorted(folderSubtreeNoteIds(tree, "projects"))).toEqual(["a", "b", "c"]);
    expect(sorted(folderSubtreeNoteIds(tree, "çalışma/"))).toEqual(["t"]);
  });

  it("root / unknown folder → []", () => {
    expect(folderSubtreeNoteIds(tree, "")).toEqual([]);
    expect(folderSubtreeNoteIds(tree, "Nonexistent/")).toEqual([]);
  });

  it("composes as a leaf in the evaluator, gated to the live set", async () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "inFolder", path: "Projects/" },
        { kind: "not", child: { kind: "hasTag", tag: "x" } },
      ],
    };
    const r = resolvers(
      { x: ["a"] },
      {},
      { "Projects/": ["a", "b", "c", "trash1"] },
    );
    // inFolder {a,b,c} (trash1 gated) ∩ not-x {b,c,d,e} = {b,c}
    expect(sorted(await evaluateFilter(node, LIVE, r))).toEqual(["b", "c"]);
  });
});

describe("comparePropertyValue — type-aware comparison (task 3)", () => {
  it("number: numeric comparison (rating > 4), not string compare", () => {
    expect(comparePropertyValue(num("rating", "5"), ">", "4")).toBe(true);
    expect(comparePropertyValue(num("rating", "10"), ">", "9")).toBe(true); // "10">"9" string-false; numeric-true
    expect(comparePropertyValue(num("rating", "4"), ">", "4")).toBe(false);
    expect(comparePropertyValue(num("rating", "4"), ">=", "4")).toBe(true);
    expect(comparePropertyValue(num("rating", "4"), "==", "4")).toBe(true);
    expect(comparePropertyValue(num("rating", "x"), ">", "4")).toBe(false); // unparseable → no match
  });

  it("date: instant comparison on frontmatter dates (full-date = midnight UTC)", () => {
    expect(comparePropertyValue(date("due", "2026-06-14"), ">=", "2026-01-01")).toBe(true);
    expect(comparePropertyValue(date("due", "2026-06-14"), "<", "2026-06-14")).toBe(false);
    expect(comparePropertyValue(date("due", "2026-06-14T10:00:00Z"), ">", "2026-06-14")).toBe(true);
    expect(comparePropertyValue(date("due", "not-a-date"), ">", "2026-01-01")).toBe(false);
  });

  it("string: folded equality, substring contains, lexical order", () => {
    expect(comparePropertyValue(str("status", "Done"), "==", "done")).toBe(true); // case-folded
    expect(comparePropertyValue(str("status", "in-progress"), "contains", "progress")).toBe(true);
    expect(comparePropertyValue(str("status", "abc"), "<", "abd")).toBe(true);
  });

  it("checkbox: boolean equality only (ordering undefined)", () => {
    expect(comparePropertyValue(check("done", "true"), "==", "true")).toBe(true);
    expect(comparePropertyValue(check("done", "false"), "!=", "true")).toBe(true);
    expect(comparePropertyValue(check("done", "true"), ">", "false")).toBe(false);
  });

  it("list: contains = membership (per element type); scalar ops → false", () => {
    const tags = list("tags", [["string", "rust"], ["string", "async"]]);
    expect(comparePropertyValue(tags, "contains", "RUST")).toBe(true); // folded membership
    expect(comparePropertyValue(tags, "contains", "python")).toBe(false);
    expect(comparePropertyValue(tags, "==", "rust")).toBe(false); // scalar op on a list
    const nums = list("scores", [["number", "3"], ["number", "7"]]);
    expect(comparePropertyValue(nums, "contains", "7")).toBe(true); // numeric membership
  });
});

describe("property leaf in the evaluator (task 3)", () => {
  it("filters to notes whose typed property matches, gated to live", async () => {
    const r = resolvers({}, {}, {}, {
      rating: [
        ["a", num("rating", "5")],
        ["b", num("rating", "3")],
        ["c", num("rating", "9")],
        ["trash1", num("rating", "9")], // not live → gated out
      ],
    });
    const node: FilterNode = { kind: "property", key: "rating", op: ">", value: "4" };
    expect(sorted(await evaluateFilter(node, LIVE, r))).toEqual(["a", "c"]);
  });

  it("composes with other leaves in a boolean tree", async () => {
    const r = resolvers(
      { proj: ["a", "b", "c"] },
      {},
      {},
      { status: [["a", str("status", "done")], ["b", str("status", "todo")]] },
    );
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "hasTag", tag: "proj" },
        { kind: "property", key: "status", op: "==", value: "done" },
      ],
    };
    expect(await evaluateFilter(node, LIVE, r)).toEqual(["a"]);
  });

  it("file.mtime is not a query source — #1 indexes no such property (SYNC-9)", async () => {
    // Querying a non-frontmatter key returns nothing because property_values
    // has no entries for it; file.mtime is never indexed as a property.
    const r = resolvers({}, {}, {}, { status: [["a", str("status", "done")]] });
    const node: FilterNode = { kind: "property", key: "file.mtime", op: ">", value: "0" };
    expect(await evaluateFilter(node, LIVE, r)).toEqual([]);
  });
});

describe("groupByProperty — scalar bucket + list fan-out (task 4)", () => {
  it("scalar groupBy buckets each note exactly once", () => {
    const map: Record<string, StoredProperty> = {
      a: str("status", "done"),
      b: str("status", "todo"),
      c: str("status", "done"),
    };
    const groups = groupByProperty(["a", "b", "c"], (id) => map[id]);
    expect(groups.map((g) => [g.key, g.ids])).toEqual([
      ["done", ["a", "c"]],
      ["todo", ["b"]],
    ]);
    // each note appears once total
    expect(groups.flatMap((g) => g.ids).length).toBe(3);
  });

  it("list-valued groupBy fans a note into every matching group (rows > notes)", () => {
    const map: Record<string, StoredProperty> = {
      a: list("tags", [["string", "rust"], ["string", "async"]]),
      b: list("tags", [["string", "rust"]]),
    };
    const groups = groupByProperty(["a", "b"], (id) => map[id]);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.ids]));
    expect(byKey["rust"]).toEqual(["a", "b"]);
    expect(byKey["async"]).toEqual(["a"]);
    // 2 notes → 3 grouped rows (fan-out)
    expect(groups.flatMap((g) => g.ids).length).toBe(3);
  });

  it("de-dupes a note within a single group (list with a repeated element)", () => {
    const map: Record<string, StoredProperty> = {
      a: list("tags", [["string", "x"], ["string", "x"]]),
    };
    const groups = groupByProperty(["a"], (id) => map[id]);
    expect(groups).toEqual([{ key: "x", type: "string", ids: ["a"] }]);
  });

  it("missing property or empty list → the no-value group (key '')", () => {
    const map: Record<string, StoredProperty> = {
      b: list("tags", []),
    };
    const groups = groupByProperty(["a", "b"], (id) => map[id]); // a has no entry
    expect(groups).toEqual([{ key: "", type: "none", ids: ["a", "b"] }]);
  });

  it("carries the typed value for #5 headings", () => {
    const map: Record<string, StoredProperty> = { a: num("priority", "3") };
    const groups = groupByProperty(["a"], (id) => map[id]);
    expect(groups[0]).toMatchObject({ key: "3", type: "number" });
  });
});

describe("sortGroupIds — type-aware sort + list representative (task 5)", () => {
  const recency = (ids: ReadonlyArray<string>) => [...ids].reverse(); // fake recency

  it("ascending/descending numeric sort (not string)", () => {
    const map: Record<string, StoredProperty> = {
      a: num("p", "2"),
      b: num("p", "10"),
      c: num("p", "1"),
    };
    expect(sortGroupIds(["a", "b", "c"], (id) => map[id], "p", "asc", recency)).toEqual([
      "c",
      "a",
      "b",
    ]); // 1,2,10 — numeric, not "10"<"2" string
    expect(sortGroupIds(["a", "b", "c"], (id) => map[id], "p", "desc", recency)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("date sort by instant on frontmatter dates", () => {
    const map: Record<string, StoredProperty> = {
      a: date("due", "2026-06-14"),
      b: date("due", "2026-01-01"),
    };
    expect(sortGroupIds(["a", "b"], (id) => map[id], "due", "asc", recency)).toEqual(["b", "a"]);
  });

  it("list-valued sort uses the first element as the representative", () => {
    const map: Record<string, StoredProperty> = {
      a: list("tags", [["string", "zeta"], ["string", "alpha"]]), // rep = "zeta"
      b: list("tags", [["string", "beta"]]), // rep = "beta"
    };
    expect(sortGroupIds(["a", "b"], (id) => map[id], "tags", "asc", recency)).toEqual(["b", "a"]); // beta < zeta
  });

  it("missing sort value sorts last (both directions); stable on ties", () => {
    const map: Record<string, StoredProperty> = { a: num("p", "5"), c: num("p", "5") };
    // b has no value → last; a,c tie → stable input order
    expect(sortGroupIds(["a", "b", "c"], (id) => map[id], "p", "asc", recency)).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(sortGroupIds(["a", "b", "c"], (id) => map[id], "p", "desc", recency)).toEqual([
      "a",
      "c",
      "b",
    ]); // missing still last
  });

  it("no sort key → recency fallback; explicit sort overrides incoming order", () => {
    const map: Record<string, StoredProperty> = { a: num("p", "1"), b: num("p", "2") };
    expect(sortGroupIds(["a", "b"], (id) => map[id], null, "asc", recency)).toEqual(["b", "a"]); // recency fake = reverse
    // explicit sort reorders regardless of input order (overrides BM25-from-search)
    expect(sortGroupIds(["b", "a"], (id) => map[id], "p", "asc", recency)).toEqual(["a", "b"]);
  });
});

describe("runView — filter→groupBy→sort end-to-end (task 6)", () => {
  // a,b,c live; each has status + priority.
  const props: Record<string, Array<readonly [string, StoredProperty]>> = {
    status: [
      ["a", str("status", "done")],
      ["b", str("status", "todo")],
      ["c", str("status", "done")],
    ],
    priority: [
      ["a", num("priority", "1")],
      ["b", num("priority", "5")],
      ["c", num("priority", "9")],
    ],
  };
  // This view's universe is exactly the 3 notes that carry the properties.
  const LIVE3 = new Set(["a", "b", "c"]);
  const ctx: RunViewContext = {
    liveIds: LIVE3,
    resolvers: {
      hasTag: vi.fn(async () => []),
      inFolder: vi.fn(async () => []),
      search: vi.fn(async () => []),
      propertyValues: vi.fn(async (key: string) => props[key] ?? []),
    },
    rowFor: (id) => ({ title: `Note ${id}`, folder: null }),
    recencyFallback: (ids) => [...ids],
  };

  it("groups by a property + sorts within groups + emits the row contract", async () => {
    const def: ViewDefinition = {
      filter: { kind: "all" },
      groupBy: "status",
      sort: { key: "priority", direction: "desc" },
      columns: ["priority"],
    };
    const result = await runView(def, ctx);
    expect(result.groups.map((g) => g.key)).toEqual(["done", "todo"]);
    const done = result.groups[0];
    // done = {a(1), c(9)} sorted by priority desc → c, a
    expect(done.rows.map((r) => r.noteId)).toEqual(["c", "a"]);
    expect(done.rows[0]).toMatchObject({
      noteId: "c",
      title: "Note c",
      folder: null,
    });
    expect(done.rows[0].values["priority"]).toMatchObject({ type: "number", value: "9" });
  });

  it("no groupBy → one implicit group of all matches (recency order)", async () => {
    const def: ViewDefinition = { filter: { kind: "all" } };
    const result = await runView(def, ctx);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].key).toBe("");
    expect(sorted(result.groups[0].rows.map((r) => r.noteId))).toEqual(["a", "b", "c"]);
  });

  it("locked vault (resolver throws) → empty grouped result, no error", async () => {
    const lockedCtx: RunViewContext = {
      ...ctx,
      resolvers: {
        ...ctx.resolvers,
        propertyValues: vi.fn(async () => {
          throw new Error("SlotNotUnlocked");
        }),
      },
    };
    const def: ViewDefinition = { filter: { kind: "all" }, groupBy: "status" };
    await expect(runView(def, lockedCtx)).resolves.toEqual({ groups: [] });
  });

  it("deterministic: a re-run is value-equal + stabilizes to the prior ref", async () => {
    const def: ViewDefinition = { filter: { kind: "all" }, groupBy: "status" };
    const r1 = await runView(def, ctx);
    const r2 = await runView(def, ctx);
    expect(sameViewResult(r1, r2)).toBe(true);
    expect(stabilizeViewResult(r1, r2)).toBe(r1); // bails the render
  });
});

describe("anti-eval invariant (SYNC-7)", () => {
  it("arithmetic / map nodes are not representable in FilterNode", () => {
    // @ts-expect-error — an arithmetic leaf is not part of the closed allow-list.
    const bad: FilterNode = { kind: "multiply", left: "rating", right: 4 };
    void bad;
    // (compile-time guarantee; the evaluator has no runtime path for it either —
    // the `assertNever` exhaustiveness guard.)
    expect(true).toBe(true);
  });
});
