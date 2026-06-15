// Unit tests for the `.base` view-model mapping adapter — supported path only
// (Saved Views #6, MYND-276, task 2). `inFolder` is task 3; drop/warn tally is
// task 4 — here an unsupported leaf becomes `{kind:"all"}` plus a recorded
// warning, and the parse stays total (never throws).

import { describe, expect, it } from "vitest";
import {
  mapBaseFilter,
  mapBaseView,
  mapParsedBase,
  normalizeRef,
} from "../../../src/notes/import/base/mapBase";
import type { BaseView } from "../../../src/notes/import/base/parseBase";
import type { SavedView } from "../../../src/lib/prefs";

// Deterministic id so the expected SavedView is exact.
const makeId = () => "v1";

describe("normalizeRef", () => {
  it("strips a leading `note.` (frontmatter property → bare key)", () => {
    expect(normalizeRef("note.image")).toBe("image");
  });

  it("leaves a bare property as-is", () => {
    expect(normalizeRef("author")).toBe("author");
  });

  it("keeps `file.*` refs as-is", () => {
    expect(normalizeRef("file.name")).toBe("file.name");
  });

  it("trims whitespace", () => {
    expect(normalizeRef("  status  ")).toBe("status");
  });
});

describe("mapBaseView — supported cards view", () => {
  it("maps a full supported cards view to the exact expected SavedView", () => {
    const view: BaseView = {
      type: "cards",
      name: "Books",
      filters: {
        and: ['status == "reading"', 'rating >= "4"'],
      },
      order: ["file.name", "author"],
      groupBy: { property: "status", direction: "ASC" },
      cardSize: 300,
      image: "note.image",
      imageAspectRatio: 1.65,
    };

    const { view: mapped, warnings } = mapBaseView(view, makeId);

    expect(warnings).toEqual([]);
    const expected: SavedView = {
      id: "v1",
      name: "Books",
      view_type: "cards",
      filters: {
        kind: "and",
        children: [
          { kind: "property", key: "status", op: "==", value: "reading" },
          { kind: "property", key: "rating", op: ">=", value: "4" },
        ],
      },
      sort: { key: "status", direction: "asc" },
      group_by: "status",
      columns: ["file.name", "author"],
      card_size: 300,
      image: "image",
      image_aspect_ratio: "1.65",
    };
    expect(mapped).toEqual(expected);
  });
});

describe("mapBaseView — view_type mapping", () => {
  it("maps table / list types", () => {
    expect(mapBaseView({ type: "table" }, makeId).view?.view_type).toBe("table");
    expect(mapBaseView({ type: "list" }, makeId).view?.view_type).toBe("list");
  });

  it("rejects type:map with a null view + unsupported-view-type warning", () => {
    const { view, warnings } = mapBaseView({ type: "map" }, makeId);
    expect(view).toBeNull();
    expect(warnings).toEqual([{ kind: "unsupported-view-type", detail: "map" }]);
  });

  it("rejects an unknown view type the same way", () => {
    const { view, warnings } = mapBaseView({ type: "gallery" }, makeId);
    expect(view).toBeNull();
    expect(warnings).toEqual([
      { kind: "unsupported-view-type", detail: "gallery" },
    ]);
  });

  it("defaults the name to a sane fallback when absent", () => {
    expect(mapBaseView({ type: "table" }, makeId).view?.name).toBe(
      "Untitled view",
    );
  });

  it("uses the injected makeId", () => {
    let n = 0;
    const seq = () => `id-${++n}`;
    expect(mapBaseView({ type: "table" }, seq).view?.id).toBe("id-1");
  });
});

describe("mapBaseFilter — boolean trees", () => {
  it("maps a nested and/or tree to the recursive canonical AST", () => {
    const { node, warnings } = mapBaseFilter({
      and: [
        'status == "done"',
        { or: ['author == "a"', 'author == "b"'] },
      ],
    });
    expect(warnings).toEqual([]);
    expect(node).toEqual({
      kind: "and",
      children: [
        { kind: "property", key: "status", op: "==", value: "done" },
        {
          kind: "or",
          children: [
            { kind: "property", key: "author", op: "==", value: "a" },
            { kind: "property", key: "author", op: "==", value: "b" },
          ],
        },
      ],
    });
  });

  it("maps a `not` of a single clause to not(child)", () => {
    const { node } = mapBaseFilter({ not: 'status == "done"' });
    expect(node).toEqual({
      kind: "not",
      child: { kind: "property", key: "status", op: "==", value: "done" },
    });
  });

  it("maps a `not` of an array to not(and([...]))", () => {
    const { node } = mapBaseFilter({
      not: ['status == "done"', 'author == "x"'],
    });
    expect(node).toEqual({
      kind: "not",
      child: {
        kind: "and",
        children: [
          { kind: "property", key: "status", op: "==", value: "done" },
          { kind: "property", key: "author", op: "==", value: "x" },
        ],
      },
    });
  });

  it("maps an absent filter to {kind:'all'}", () => {
    expect(mapBaseFilter(undefined).node).toEqual({ kind: "all" });
  });

  it("collapses an empty `and`/`or` group to {kind:'all'}", () => {
    expect(mapBaseFilter({ and: [] }).node).toEqual({ kind: "all" });
    expect(mapBaseFilter({ or: [] }).node).toEqual({ kind: "all" });
  });
});

describe("mapBaseFilter — leaf clauses", () => {
  it("maps file.hasTag(\"tag\") and hasTag(\"#tag\") to a hasTag leaf (unquote, strip #)", () => {
    expect(mapBaseFilter('file.hasTag("books")').node).toEqual({
      kind: "hasTag",
      tag: "books",
    });
    expect(mapBaseFilter('hasTag("#books")').node).toEqual({
      kind: "hasTag",
      tag: "books",
    });
  });

  it("maps prop.contains(value) to a property contains leaf", () => {
    expect(mapBaseFilter('title.contains("draft")').node).toEqual({
      kind: "property",
      key: "title",
      op: "contains",
      value: "draft",
    });
  });

  it("parses >= without splitting it into >", () => {
    expect(mapBaseFilter('rating >= "4"').node).toEqual({
      kind: "property",
      key: "rating",
      op: ">=",
      value: "4",
    });
  });

  it("parses each comparison operator", () => {
    const cases: Array<[string, string]> = [
      ['a == "1"', "=="],
      ['a != "1"', "!="],
      ['a > "1"', ">"],
      ['a < "1"', "<"],
      ['a >= "1"', ">="],
      ['a <= "1"', "<="],
    ];
    for (const [clause, op] of cases) {
      expect(mapBaseFilter(clause).node).toEqual({
        kind: "property",
        key: "a",
        op,
        value: "1",
      });
    }
  });

  it("normalizes a note.* property ref in a comparison", () => {
    expect(mapBaseFilter('note.status == "done"').node).toEqual({
      kind: "property",
      key: "status",
      op: "==",
      value: "done",
    });
  });
});

describe("mapBaseFilter — unsupported clauses (dropped, no throw)", () => {
  it("DROPS an unsupported function (file.hasLink) → node null + a warning", () => {
    const { node, warnings } = mapBaseFilter('file.hasLink("Note")');
    expect(node).toBeNull();
    expect(warnings).toEqual([
      { kind: "unsupported-clause", detail: 'file.hasLink("Note")' },
    ]);
  });

  it("DROPS list.map(...) → node null + a warning without throwing", () => {
    const { node, warnings } = mapBaseFilter("list.map(x => x)");
    expect(node).toBeNull();
    expect(warnings).toEqual([
      { kind: "unsupported-clause", detail: "list.map(x => x)" },
    ]);
  });

  it("propagates leaf warnings up through a boolean group", () => {
    const { node, warnings } = mapBaseView(
      {
        type: "table",
        filters: { and: ['status == "done"', 'file.hasLink("x")'] },
      },
      makeId,
    );
    expect(warnings).toEqual([
      { kind: "unsupported-clause", detail: 'file.hasLink("x")' },
    ]);
    expect(node).toBeUndefined(); // sanity: mapBaseView returns {view, warnings}
    expect(warnings.length).toBe(1);
  });
});

describe("mapBaseView — optional field omission", () => {
  it("omits empty order, absent groupBy, non-positive cardSize, absent image/aspect", () => {
    const { view } = mapBaseView(
      { type: "table", name: "Bare", order: [], cardSize: 0 },
      makeId,
    );
    expect(view).toEqual({
      id: "v1",
      name: "Bare",
      view_type: "table",
      filters: { kind: "all" },
    });
  });

  it("a bare-string groupBy sets group_by only (no sort)", () => {
    const { view } = mapBaseView(
      { type: "table", groupBy: "status" },
      makeId,
    );
    expect(view?.group_by).toBe("status");
    expect(view?.sort).toBeUndefined();
  });

  it("stringifies a string imageAspectRatio, omits a non-finite one", () => {
    expect(
      mapBaseView(
        { type: "cards", image: "note.cover", imageAspectRatio: "1.5" },
        makeId,
      ).view?.image_aspect_ratio,
    ).toBe("1.5");
    expect(
      mapBaseView(
        { type: "cards", imageAspectRatio: Number.NaN as unknown as number },
        makeId,
      ).view?.image_aspect_ratio,
    ).toBeUndefined();
  });
});

describe("inFolder mapping + multi-value hasTag (task 3)", () => {
  // Primary source (help.obsidian.md/bases/functions, verified 2026-06-15):
  // file.inFolder(folder) → "true if the file is in the specified folder or one
  // of its sub-folders" (RECURSIVE). Myne's inFolder engine leaf is likewise
  // subtree-inclusive, so the mapping is DIRECT with NO mismatch warning.
  it("maps file.inFolder(\"path\") to the subtree-inclusive inFolder leaf, no warning", () => {
    const r = mapBaseFilter('file.inFolder("2-AREAS/Content/Books")');
    expect(r.node).toEqual({ kind: "inFolder", path: "2-AREAS/Content/Books" });
    expect(r.warnings).toEqual([]);
  });

  it("maps a real .base and-of-inFolder filter directly", () => {
    const r = mapBaseFilter({
      and: ['file.inFolder("A")', 'file.inFolder("B")'],
    });
    expect(r.node).toEqual({
      kind: "and",
      children: [
        { kind: "inFolder", path: "A" },
        { kind: "inFolder", path: "B" },
      ],
    });
    expect(r.warnings).toEqual([]);
  });

  it("single-value hasTag → a hasTag leaf", () => {
    expect(mapBaseFilter('file.hasTag("reading")').node).toEqual({
      kind: "hasTag",
      tag: "reading",
    });
  });

  it("multi-value hasTag → an OR of hasTag leaves (Obsidian ANY semantics)", () => {
    const r = mapBaseFilter('file.hasTag("a", "b")');
    expect(r.node).toEqual({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "a" },
        { kind: "hasTag", tag: "b" },
      ],
    });
    expect(r.warnings).toEqual([]);
  });

  it("strips a leading # from a hasTag value", () => {
    expect(mapBaseFilter('hasTag("#draft")').node).toEqual({
      kind: "hasTag",
      tag: "draft",
    });
  });
});

describe("partial-import drops + clause warnings (task 4)", () => {
  it("drops an unsupported clause but KEEPS the rest of the view's filter", () => {
    const { view, warnings } = mapBaseView(
      {
        type: "table",
        name: "Mixed",
        filters: { and: ['file.inFolder("Books")', "list.map(x => x)"] },
      },
      makeId,
    );
    // The inFolder survives (single survivor collapses the `and`); list.map drops.
    expect(view?.filters).toEqual({ kind: "inFolder", path: "Books" });
    expect(warnings).toEqual([
      { kind: "unsupported-clause", detail: "list.map(x => x)" },
    ]);
  });

  it("drops a file.mtime clause with a warning (SYNC-9, no approx-mtime mode)", () => {
    const { view, warnings } = mapBaseView(
      {
        type: "table",
        filters: { and: ['file.inFolder("X")', 'file.mtime > "2026-01-01"'] },
      },
      makeId,
    );
    expect(view?.filters).toEqual({ kind: "inFolder", path: "X" });
    expect(warnings).toEqual([
      { kind: "unsupported-clause", detail: 'file.mtime > "2026-01-01"' },
    ]);
  });

  it("drops file.name comparisons too (file metadata not a query source)", () => {
    const { view } = mapBaseView(
      {
        type: "cards",
        filters: { and: ['file.inFolder("X")', 'file.name != "Watch List"'] },
      },
      makeId,
    );
    expect(view?.filters).toEqual({ kind: "inFolder", path: "X" });
  });

  it("SKIPS a view whose entire filter drops, with a per-view warning (SYNC-12)", () => {
    const { view, warnings } = mapBaseView(
      {
        type: "table",
        name: "AllDropped",
        filters: { and: ["list.map(x => x)", 'file.mtime > "2026"'] },
      },
      makeId,
    );
    expect(view).toBeNull();
    expect(warnings).toContainEqual({
      kind: "view-skipped-empty-filter",
      detail: "AllDropped",
    });
    // both clause drops are still recorded alongside the skip
    expect(warnings.filter((w) => w.kind === "unsupported-clause")).toHaveLength(
      2,
    );
  });

  it("does NOT skip a genuinely-unfiltered view (no filters key)", () => {
    const { view } = mapBaseView({ type: "cards", name: "All" }, makeId);
    expect(view?.filters).toEqual({ kind: "all" });
  });
});

describe("mapParsedBase — formulas/summaries/properties drops (task 4)", () => {
  it("maps surviving views and counts dropped top-level sections", () => {
    const { views, warnings } = mapParsedBase(
      {
        formulas: { pricePerDay: "x / y" },
        summaries: { total: "sum(x)" },
        properties: { "file.tags": { displayName: "Tags" } },
        views: [
          { type: "cards", name: "Good", filters: { and: ['file.inFolder("X")'] } },
          { type: "map", name: "Skipped" },
        ],
      },
      makeId,
    );
    expect(views).toHaveLength(1);
    expect(views[0]!.name).toBe("Good");
    expect(warnings).toContainEqual({ kind: "unsupported-view-type", detail: "map" });
    expect(warnings).toContainEqual({ kind: "dropped-formulas", detail: "1" });
    expect(warnings).toContainEqual({ kind: "dropped-summaries", detail: "1" });
    expect(warnings).toContainEqual({
      kind: "dropped-properties-display",
      detail: "1",
    });
  });

  it("no spurious section warnings when formulas/summaries absent", () => {
    const { warnings } = mapParsedBase(
      { views: [{ type: "cards", name: "V" }] },
      makeId,
    );
    expect(warnings.filter((w) => w.kind.startsWith("dropped-"))).toEqual([]);
  });
});
