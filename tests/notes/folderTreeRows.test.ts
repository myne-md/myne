// Tests for the pure tree-flatten that feeds the sidebar VirtualList.
// MYND-183 reshape: a single interleaved file-tree — folderless notes render at
// the root level (no "Vault root" section), folders and notes interleave by the
// unified `item_order` prefs sequence at every level. No section-header row is
// emitted (the "Notes" header is a static render-layer element). (UI rendering
// itself has no test runner; this covers the row-ordering + collapse + depth
// logic.)

import { describe, it, expect } from "vitest";
import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  buildFavoriteRows,
  buildItemRankMap,
  flattenVisibleRows,
  pruneFavorites,
  toggleFavoriteList,
  visibleNoteIds,
  type VisibleRow,
} from "../../src/notes/components/folderTreeRows";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";

const rec = (id: string, folder: string | null, ms = 0): TitleRecord => ({
  noteUuid: id,
  title: id,
  folder,
  updatedAt: new Date(ms),
});

function build(records: TitleRecord[], deliberate: string[] = []) {
  const cache = new Map(records.map((r) => [r.noteUuid, r] as const));
  const tree = deriveFolderTree(
    records.map((r) => ({ noteUuid: r.noteUuid, folder: r.folder })),
    deliberate,
  );
  return { cache, tree };
}

const kinds = (rows: VisibleRow[]) => rows.map((r) => r.kind);
const ids = (rows: VisibleRow[]) =>
  rows.map((r) => (r.kind === "note" ? r.id : r.node.name));

describe("buildItemRankMap", () => {
  it("keeps note UUIDs verbatim and case-folds folder paths", () => {
    const m = buildItemRankMap(["n1", "Projects/", "n2"]);
    expect(m.get("n1")).toBe(0);
    expect(m.get("projects/")).toBe(1); // folded to match FolderNode.key
    expect(m.get("n2")).toBe(2);
    expect(m.get("Projects/")).toBeUndefined(); // raw display form is not the key
  });

  it("first occurrence wins on duplicates", () => {
    const m = buildItemRankMap(["a", "b", "a"]);
    expect(m.get("a")).toBe(0);
  });
});

describe("flattenVisibleRows", () => {
  it("flattens an empty vault to no rows (no section header)", () => {
    const { cache, tree } = build([]);
    expect(flattenVisibleRows(tree, cache, new Set())).toEqual([]);
  });

  it("renders folderless notes at root level (no Vault root section)", () => {
    const { cache, tree } = build([rec("a", null, 2), rec("b", null, 1)]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    // No section rows at all; loose notes lead at depth 0 by recency.
    expect(kinds(rows)).toEqual(["note", "note"]);
    expect(ids(rows)).toEqual(["a", "b"]); // newer first (updatedAt desc)
    expect(rows.every((r) => r.kind !== "note" || r.depth === 0)).toBe(true);
  });

  it("expands ancestor folders and indents the note by depth", () => {
    const { cache, tree } = build([rec("n1", "Projects/Myne/")]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    expect(kinds(rows)).toEqual(["folder", "folder", "note"]);
    const [projects, myne, note] = rows;
    expect(projects).toMatchObject({ kind: "folder", depth: 0 });
    expect((projects as Extract<VisibleRow, { kind: "folder" }>).node.name).toBe("Projects");
    expect(myne).toMatchObject({ kind: "folder", depth: 1 });
    expect(note).toMatchObject({ kind: "note", id: "n1", depth: 2 });
  });

  it("hides descendants of a collapsed folder", () => {
    const { cache, tree } = build([rec("n1", "Projects/Myne/")]);
    // node.key is the folded path; Projects/ folds to "projects/".
    const rows = flattenVisibleRows(tree, cache, new Set(["projects/"]));
    expect(kinds(rows)).toEqual(["folder"]);
    expect(rows[0]).toMatchObject({ collapsed: true });
    expect(visibleNoteIds(rows)).toEqual([]); // the note is hidden
  });

  it("renders an empty deliberate folder with empty:true and no notes", () => {
    const { cache, tree } = build([], ["Drafts/"]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    expect(kinds(rows)).toEqual(["folder"]);
    expect(rows[0]).toMatchObject({ kind: "folder", empty: true });
  });

  it("default (no item_order): folders sort before loose notes at root", () => {
    const { cache, tree } = build([rec("a", null, 2), rec("b", null, 1)], ["Box/"]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    // Unlisted: folder first, then notes by recency.
    expect(ids(rows)).toEqual(["Box", "a", "b"]);
  });

  it("interleaves loose notes between folders at root by item_order", () => {
    const { cache, tree } = build(
      [rec("n1", null), rec("n2", null)],
      ["Apple/", "Zebra/"],
    );
    const itemOrder = ["n1", "Apple/", "n2", "Zebra/"];
    const rows = flattenVisibleRows(tree, cache, new Set(), itemOrder);
    expect(ids(rows)).toEqual(["n1", "Apple", "n2", "Zebra"]);
  });

  it("interleaves a note before a subfolder inside a folder (recursive)", () => {
    const { cache, tree } = build([
      rec("d", "Work/"), // direct note in Work
      rec("s", "Work/Sub/"), // note inside the subfolder
    ]);
    // Default would be folders-first (Sub before d); item_order puts d first.
    const rows = flattenVisibleRows(tree, cache, new Set(), ["d", "Work/Sub/"]);
    expect(kinds(rows)).toEqual(["folder", "note", "folder", "note"]);
    expect(ids(rows)).toEqual(["Work", "d", "Sub", "s"]);
    expect(visibleNoteIds(rows)).toEqual(["d", "s"]);
  });

  it("listed item_order entries sort before unlisted siblings", () => {
    const { cache, tree } = build([
      rec("x", null, 100), // newest, but unlisted
      rec("y", null, 1), // oldest, but listed
    ]);
    const rows = flattenVisibleRows(tree, cache, new Set(), ["y"]);
    // y is listed (index 0) so it leads despite being older than x.
    expect(visibleNoteIds(rows)).toEqual(["y", "x"]);
  });
});

describe("buildFavoriteRows + pruneFavorites (Favorites — MYND-183)", () => {
  const cache = new Map(
    [rec("a", "Work/"), rec("b", null), rec("c", "Box/")].map(
      (r) => [r.noteUuid, r] as const,
    ),
  );

  it("renders favorites in order with section-qualified keys at depth 0", () => {
    const rows = buildFavoriteRows(["b", "a"], cache);
    expect(rows).toEqual([
      { kind: "note", key: "fav-b", id: "b", depth: 0 },
      { kind: "note", key: "fav-a", id: "a", depth: 0 },
    ]);
  });

  it("favorite + tree rows for the same note keep distinct keys", () => {
    const favRows = buildFavoriteRows(["a"], cache);
    const { cache: c2, tree } = build([rec("a", "Work/")]);
    const treeRows = flattenVisibleRows(tree, c2, new Set());
    const favKey = favRows[0]!.key;
    const noteRow = treeRows.find((r) => r.kind === "note");
    expect(favKey).toBe("fav-a");
    expect(noteRow?.key).toBe("n-a");
    expect(favKey).not.toBe(noteRow?.key); // no VirtualList key collision
  });

  it("skips a favorite with no live note (stale-UUID GC, render half)", () => {
    const rows = buildFavoriteRows(["a", "ghost", "b"], cache);
    expect(rows.map((r) => (r.kind === "note" ? r.id : ""))).toEqual(["a", "b"]);
  });

  it("returns no rows when favorites is empty", () => {
    expect(buildFavoriteRows([], cache)).toEqual([]);
  });

  it("pruneFavorites drops stale ids preserving order (persist half)", () => {
    expect(pruneFavorites(["a", "ghost", "b", "gone"], cache)).toEqual(["a", "b"]);
  });

  it("toggleFavoriteList appends when absent, removes when present, no dup", () => {
    expect(toggleFavoriteList(["a", "b"], "c")).toEqual(["a", "b", "c"]); // add
    expect(toggleFavoriteList(["a", "b", "c"], "b")).toEqual(["a", "c"]); // remove
    expect(toggleFavoriteList(["a"], "a")).toEqual([]); // remove last
    // Idempotent shape: toggling twice returns to the original set membership.
    const once = toggleFavoriteList(["a", "b"], "a"); // ["b"]
    expect(toggleFavoriteList(once, "a")).toEqual(["b", "a"]); // re-added (at end)
  });
});

describe("visibleNoteIds — dedupe across Favorites + tree", () => {
  it("visits a note shown in both sections once, Favorites copy first", () => {
    const { cache, tree } = build([rec("a", null, 2), rec("b", null, 1)]);
    const favRows = buildFavoriteRows(["b"], cache); // b is favorited
    const treeRows = flattenVisibleRows(tree, cache, new Set());
    // Favorites first, then the tree — b appears in both; nav visits it once.
    const nav = visibleNoteIds([...favRows, ...treeRows]);
    expect(nav).toEqual(["b", "a"]); // b (from Favorites) first, then a; no dup b
  });
});
