import { describe, it, expect } from "vitest";
import {
  deriveTree,
  containerNodes,
  subtreeCount,
  orderedChildren,
  orderedChildKeys,
  childKey,
  childOrderIndex,
  reorderChildOrder,
  reorderChildBeside,
  notesInSubtree,
} from "../src/lib/folders";
import type { OrderedNoteRecord } from "@myne/editor/host/notes/itemOrder";
import { patchFolderField } from "../src/dialect/surgery";
import { readNoteFolder } from "../src/lib/note-organize";

/** A cache with every note present + a null `updatedAt` (recency falls back to
 *  the UUIDv7 timestamp, which is 0 for these short synthetic ids → stable). */
function cacheOf(ids: string[]): Map<string, OrderedNoteRecord> {
  return new Map(ids.map((id) => [id, { updatedAt: null }]));
}

describe("readNoteFolder", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  it("reads the folder path written by surgery; null at root", () => {
    const t = dec.decode(patchFolderField(enc.encode("body"), "Projects/Myne/"));
    expect(readNoteFolder(t)).toBe("Projects/Myne/");
    expect(readNoteFolder("# no frontmatter")).toBeNull();
  });
});

describe("folder tree — structure", () => {
  const folderOf = new Map<string, string | null>([
    ["1", null], // root / unfiled
    ["2", "A/"],
    ["3", "A/B/"],
    ["4", "A/B/"],
    ["5", "C/"],
  ]);
  const tree = deriveTree(folderOf, [], []);

  it("root: immediate child folders with subtree counts", () => {
    const { folders, noteIds } = containerNodes(tree, null);
    expect(folders.map((f) => f.name)).toEqual(["A", "C"]);
    expect(subtreeCount(folders.find((f) => f.name === "A")!)).toBe(3); // notes 2,3,4
    expect(subtreeCount(folders.find((f) => f.name === "C")!)).toBe(1);
    expect(noteIds).toEqual(["1"]); // the unfiled note
  });

  it("inside A: child folder B; note 2 sits directly in A", () => {
    const { folders, noteIds } = containerNodes(tree, "A/");
    expect(folders.map((f) => f.name)).toEqual(["B"]);
    expect(subtreeCount(folders[0]!)).toBe(2); // notes 3,4
    expect(noteIds).toEqual(["2"]);
  });
});

describe("notesInSubtree", () => {
  const folderOf = new Map<string, string | null>([
    ["1", null],
    ["2", "A/"],
    ["3", "A/B/"],
    ["4", "A/B/"],
    ["5", "C/"],
  ]);
  it("subtree includes the folder and all descendants", () => {
    expect(notesInSubtree(folderOf, "A/").sort()).toEqual(["2", "3", "4"]);
    expect(notesInSubtree(folderOf, "A/B/").sort()).toEqual(["3", "4"]);
    expect(notesInSubtree(folderOf, "C/")).toEqual(["5"]);
  });
  it("subtree of root matches every note", () => {
    expect(notesInSubtree(folderOf, null).sort()).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("subtree prefix match respects folder boundaries", () => {
    const fo = new Map<string, string | null>([["x", "A/"], ["y", "AB/"]]);
    expect(notesInSubtree(fo, "A/")).toEqual(["x"]); // "AB/" is not under "A/"
  });
});

describe("folder tree — MYND-562 shared derivation", () => {
  it("dedups case-variant folders to one canonical row with a folded key", () => {
    const fo = new Map<string, string | null>([
      ["1", "personal/"],
      ["2", "PERSONAL/"],
    ]);
    const folders = containerNodes(deriveTree(fo, [], []), null).folders;
    expect(folders).toHaveLength(1);
    expect(folders[0]!.path).toBe("PERSONAL/"); // lexicographic-min display
    expect(folders[0]!.key).toBe("personal/"); // folded identity — the decoration key
    expect(subtreeCount(folders[0]!)).toBe(2);
  });

  it("surfaces deliberate (empty) folders no note lives in", () => {
    const fo = new Map<string, string | null>([["1", null]]); // only a root note
    expect(containerNodes(deriveTree(fo, [], []), null).folders).toEqual([]); // invisible…
    const folders = containerNodes(deriveTree(fo, ["Ideas/"], []), null).folders; // …persists
    expect(folders.map((f) => f.name)).toEqual(["Ideas"]);
    expect(folders[0]!.key).toBe("ideas/");
    expect(subtreeCount(folders[0]!)).toBe(0);
  });
});

describe("interleave — MYND-596 full desktop parity", () => {
  it("interleaves folders + notes in ONE list; a note can sit above a folder", () => {
    const fo = new Map<string, string | null>([
      ["na", null],
      ["nb", null],
      ["p1", "Projects/"],
    ]);
    const tree = deriveTree(fo, [], []);
    // item_order for the ROOT container ("") lists a note, then a folder, then a note.
    const order = { "": ["na", "Projects/", "nb"] };
    const children = orderedChildren(tree, null, order, cacheOf(["na", "nb"]));
    expect(children.map(childKey)).toEqual(["na", "Projects/", "nb"]);
    // The middle entry really is the folder node (not a note masquerading).
    expect(children[1]!.kind).toBe("folder");
  });

  it("unlisted children fall back to folders-before-notes, name / recency", () => {
    const fo = new Map<string, string | null>([
      ["z", null],
      ["a", null],
      ["p1", "Beta/"],
      ["p2", "Alpha/"],
    ]);
    const tree = deriveTree(fo, [], []);
    const cache = new Map<string, OrderedNoteRecord>([
      ["z", { updatedAt: new Date(2000) }], // more recent
      ["a", { updatedAt: new Date(1000) }],
    ]);
    // No item_order for root → folders first (folded name), then notes by recency desc.
    expect(orderedChildKeys(tree, null, {}, cache)).toEqual(["Alpha/", "Beta/", "z", "a"]);
  });

  it("each container reads only its own sequence (per-container order)", () => {
    const fo = new Map<string, string | null>([
      ["x", "Sub/"],
      ["y", "Sub/"],
    ]);
    const tree = deriveTree(fo, [], []);
    // The container key is the FOLDED folder key ("sub/"), value in display terms.
    const order = { "sub/": ["y", "x"] };
    expect(orderedChildKeys(tree, "Sub/", order, cacheOf(["x", "y"]))).toEqual(["y", "x"]);
  });
});

describe("reorder — MYND-596 container-keyed map", () => {
  it("nudges a note within a subfolder, leaving the parent container untouched", () => {
    const fo = new Map<string, string | null>([
      ["na", null],
      ["nb", null],
      ["x", "Sub/"],
      ["y", "Sub/"],
    ]);
    const tree = deriveTree(fo, [], []);
    const cache = cacheOf(["na", "nb", "x", "y"]);
    // Container key is the FOLDED folder key ("sub/"); the entries are note UUIDs.
    const order = { "": ["na", "nb"], "sub/": ["x", "y"] };
    // Move y UP within Sub/ (above x). Only the "sub/" sequence is rewritten; the
    // root "" container is copied through verbatim (per-container LWW isolation).
    const next = reorderChildOrder({
      tree, itemOrder: order, cache, containerPath: "Sub/", rowKey: "y", delta: -1,
    });
    expect(next).toEqual({ "": ["na", "nb"], "sub/": ["y", "x"] });
  });

  it("materializes the full container (folders included) on a root note nudge", () => {
    // A root note nudge re-materializes the ROOT container in display order —
    // which interleaves the unlisted Sub/ folder after the listed notes.
    const fo = new Map<string, string | null>([
      ["na", null],
      ["nb", null],
      ["nc", null],
      ["x", "Sub/"],
    ]);
    const tree = deriveTree(fo, [], []);
    const cache = cacheOf(["na", "nb", "nc", "x"]);
    const next = reorderChildOrder({
      tree, itemOrder: { "": ["na", "nb", "nc"] }, cache, containerPath: null, rowKey: "nc", delta: -1,
    });
    // nc moves above nb; the unlisted "Sub/" folder trails the listed notes.
    expect(next).toEqual({ "": ["na", "nc", "nb", "Sub/"] });
  });

  it("materializes an unlisted folder container on first reorder", () => {
    const fo = new Map<string, string | null>([
      ["1", "Apple/"],
      ["2", "Mango/"],
      ["3", "Zebra/"],
    ]);
    const tree = deriveTree(fo, [], []);
    const cache = new Map<string, OrderedNoteRecord>();
    // No item_order → name order Apple, Mango, Zebra.
    expect(orderedChildKeys(tree, null, {}, cache)).toEqual(["Apple/", "Mango/", "Zebra/"]);
    // Move Zebra UP (above Mango) — the whole container is now explicit.
    const next = reorderChildOrder({
      tree, itemOrder: {}, cache, containerPath: null, rowKey: "Zebra/", delta: -1,
    });
    expect(next).toEqual({ "": ["Apple/", "Zebra/", "Mango/"] });
  });

  it("disables the boundary button and no-ops a boundary move", () => {
    const fo = new Map<string, string | null>([
      ["1", "Apple/"],
      ["2", "Mango/"],
    ]);
    const tree = deriveTree(fo, [], []);
    const cache = new Map<string, OrderedNoteRecord>();
    const first = childOrderIndex({ tree, itemOrder: {}, cache, containerPath: null, rowKey: "Apple/" });
    expect(first).toEqual({ index: 0, count: 2 });
    // First row can't move up; last row can't move down.
    expect(reorderChildOrder({ tree, itemOrder: {}, cache, containerPath: null, rowKey: "Apple/", delta: -1 })).toBeNull();
    expect(reorderChildOrder({ tree, itemOrder: {}, cache, containerPath: null, rowKey: "Mango/", delta: 1 })).toBeNull();
  });
});

describe("reorderChildBeside, a DROP, not a nudge (owner, 2026-11-08)", () => {
  const fo = new Map<string, string | null>([
    ["na", null],
    ["nb", null],
    ["nc", null],
    ["nd", null],
  ]);

  it("places a dragged row below the row it was dropped on, in one write", () => {
    const tree = deriveTree(fo, [], []);
    const cache = cacheOf(["na", "nb", "nc", "nd"]);
    const order = { "": ["na", "nb", "nc", "nd"] };
    const next = reorderChildBeside({
      tree, itemOrder: order, cache, containerPath: null,
      rowKey: "na", targetKey: "nc", place: "below",
    });
    expect(next?.[""]).toEqual(["nb", "nc", "na", "nd"]);
  });

  it("places it above, so the two sides of a row are two different results", () => {
    const tree = deriveTree(fo, [], []);
    const cache = cacheOf(["na", "nb", "nc", "nd"]);
    const order = { "": ["na", "nb", "nc", "nd"] };
    const next = reorderChildBeside({
      tree, itemOrder: order, cache, containerPath: null,
      rowKey: "nd", targetKey: "nb", place: "above",
    });
    expect(next?.[""]).toEqual(["na", "nd", "nb", "nc"]);
  });

  it("refuses a drop onto itself and a target outside the container", () => {
    const tree = deriveTree(fo, [], []);
    const cache = cacheOf(["na", "nb", "nc", "nd"]);
    const order = { "": ["na", "nb", "nc", "nd"] };
    // Onto itself: no write, rather than a rewrite that equals the old order.
    expect(
      reorderChildBeside({
        tree, itemOrder: order, cache, containerPath: null,
        rowKey: "nb", targetKey: "nb", place: "below",
      }),
    ).toBeNull();
    // A row that is not in this container: a drop into another folder is a
    // `folder:` move, not an ordering write, so it must not be silently applied.
    expect(
      reorderChildBeside({
        tree, itemOrder: order, cache, containerPath: "Other/",
        rowKey: "nb", targetKey: "na", place: "below",
      }),
    ).toBeNull();
  });
});
