import { describe, it, expect } from "vitest";
import { folderChildren, itemOrderRank, notesDirectlyIn, notesInSubtree } from "../src/lib/folders";
import { patchFolderField } from "../src/dialect/surgery";
import { readNoteFolder } from "../src/lib/note-organize";

describe("readNoteFolder", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  it("reads the folder path written by surgery; null at root", () => {
    const t = dec.decode(patchFolderField(enc.encode("body"), "Projects/Myne/"));
    expect(readNoteFolder(t)).toBe("Projects/Myne/");
    expect(readNoteFolder("# no frontmatter")).toBeNull();
  });
});

describe("folder tree", () => {
  const folderOf = new Map<string, string | null>([
    ["1", null], // root / unfiled
    ["2", "A/"],
    ["3", "A/B/"],
    ["4", "A/B/"],
    ["5", "C/"],
  ]);

  it("root: immediate child folders with subtree counts", () => {
    const kids = folderChildren(folderOf, null);
    expect(kids.map((k) => k.name)).toEqual(["A", "C"]);
    expect(kids.find((k) => k.name === "A")?.count).toBe(3); // notes 2,3,4
    expect(kids.find((k) => k.name === "C")?.count).toBe(1);
  });

  it("inside A: child folder B; note 2 sits directly in A", () => {
    expect(folderChildren(folderOf, "A/").map((k) => k.name)).toEqual(["B"]);
    expect(folderChildren(folderOf, "A/")[0].count).toBe(2); // notes 3,4
    expect(notesDirectlyIn(folderOf, "A/")).toEqual(["2"]);
  });

  it("root notes are the unfiled ones", () => {
    expect(notesDirectlyIn(folderOf, null)).toEqual(["1"]);
  });

  it("subtree includes the folder and all descendants", () => {
    expect(notesInSubtree(folderOf, "A/").sort()).toEqual(["2", "3", "4"]); // A/ + A/B/
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
    // "personal" and "PERSONAL" are ONE folder identity — mobile must now agree
    // with desktop (shared deriveFolderTree): a single row, lexicographic-min
    // display, folded decoration key, both notes counted once.
    const fo = new Map<string, string | null>([
      ["1", "personal/"],
      ["2", "PERSONAL/"],
    ]);
    const kids = folderChildren(fo, null);
    expect(kids).toHaveLength(1);
    expect(kids[0].path).toBe("PERSONAL/"); // lexicographic-min display
    expect(kids[0].key).toBe("personal/"); // folded identity — the decoration key
    expect(kids[0].count).toBe(2);
  });

  it("surfaces deliberate (empty) folders no note lives in", () => {
    const fo = new Map<string, string | null>([["1", null]]); // only a root note
    expect(folderChildren(fo, null)).toEqual([]); // invisible without the set…
    const kids = folderChildren(fo, null, ["Ideas/"]); // …persists with it
    expect(kids.map((k) => k.name)).toEqual(["Ideas"]);
    expect(kids[0].key).toBe("ideas/");
    expect(kids[0].count).toBe(0);
  });
});

describe("item_order ranking — MYND-562 light parity", () => {
  it("itemOrderRank folds folder entries and ranks notes by UUID", () => {
    const rank = itemOrderRank(["PROJECTS/", "note-a"]); // display-cased folder entry
    expect(rank("projects/")).toBe(0); // folded to identity
    expect(rank("note-a")).toBe(1);
    expect(rank("missing")).toBe(Number.MAX_SAFE_INTEGER); // unlisted → last
  });

  it("orders sibling folders by item_order; unlisted fall back to folded name", () => {
    const fo = new Map<string, string | null>([
      ["1", "Zebra/"],
      ["2", "Apple/"],
      ["3", "Mango/"],
    ]);
    // item_order (display-cased) lists Zebra then Apple; Mango is unlisted.
    expect(
      folderChildren(fo, null, [], ["Zebra/", "Apple/"]).map((k) => k.name),
    ).toEqual(["Zebra", "Apple", "Mango"]);
    // Without item_order: pure folded-name order.
    expect(folderChildren(fo, null).map((k) => k.name)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });
});
