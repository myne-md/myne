// Tag-browser view-model (MYND-200 task 2, build-phase v1.1). Pure projection of
// the Rust-built tag tree into render rows + the SYNC-3 trash-excluding live-id
// derivation. No tree-building/fold/count math here — those are pre-computed
// Rust-side; this only shapes rows + derives indent and resolves titles.

import { describe, expect, it } from "vitest";

import type { TagTreeNode } from "../../src/notes/vaultIndices";
import { liveIdSet, type ResolverNote } from "../../src/notes/resolveWikilink";
import {
  TAG_INDENT_PX,
  tagNoteRows,
  tagRows,
} from "../../src/notes/tagBrowser";

const node = (over: Partial<TagTreeNode>): TagTreeNode => ({
  key: "kitap",
  display: "Kitap",
  depth: 0,
  directCount: 1,
  subtreeCount: 1,
  ...over,
});

const rnote = (over: Partial<ResolverNote>): ResolverNote => ({
  noteUuid: "n1",
  title: "Note 1",
  folder: null,
  ...over,
});

describe("tagRows", () => {
  it("renders the display casing, never the folded key", () => {
    const rows = tagRows([node({ key: "kitap", display: "Kitap" })]);
    expect(rows[0].display).toBe("Kitap");
    expect(rows[0].display).not.toBe("kitap");
    // key rides along only as click identity, never as the rendered label.
    expect(rows[0].key).toBe("kitap");
  });

  it("derives indent from depth (no UI-side tree math)", () => {
    const rows = tagRows([
      node({ depth: 0 }),
      node({ key: "kitap/sci-fi", display: "Kitap/sci-fi", depth: 1 }),
      node({ key: "kitap/sci-fi/dune", display: "Kitap/sci-fi/Dune", depth: 2 }),
    ]);
    expect(rows.map((r) => r.indentPx)).toEqual([
      0,
      TAG_INDENT_PX,
      2 * TAG_INDENT_PX,
    ]);
  });

  it("passes direct + subtree counts through unchanged", () => {
    const rows = tagRows([node({ directCount: 3, subtreeCount: 9 })]);
    expect(rows[0].directCount).toBe(3);
    expect(rows[0].subtreeCount).toBe(9);
  });

  it("preserves the Rust-built node order", () => {
    const rows = tagRows([
      node({ key: "a", display: "A" }),
      node({ key: "b", display: "B" }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["a", "b"]);
  });
});

describe("liveIdSet (SYNC-3)", () => {
  it("is exactly the live note-set's ids (trashed/template already excluded upstream)", () => {
    const set = liveIdSet([rnote({ noteUuid: "n1" }), rnote({ noteUuid: "n2" })]);
    expect([...set].sort()).toEqual(["n1", "n2"]);
  });
});

describe("tagNoteRows", () => {
  it("maps ids to display titles from the note-set", () => {
    const rows = tagNoteRows(
      ["n1", "n2"],
      [
        rnote({ noteUuid: "n1", title: "Dune" }),
        rnote({ noteUuid: "n2", title: "Foundation" }),
      ],
    );
    expect(rows).toEqual([
      { noteId: "n1", title: "Dune" },
      { noteId: "n2", title: "Foundation" },
    ]);
  });

  it("drops an id absent from the live note-set (trash exclusion)", () => {
    // 'n2' is trashed → not in the resolver note-set → excluded from the result.
    const rows = tagNoteRows(
      ["n1", "n2"],
      [rnote({ noteUuid: "n1", title: "Dune" })],
    );
    expect(rows).toEqual([{ noteId: "n1", title: "Dune" }]);
  });

  it("carries a null title through (untitled note)", () => {
    const rows = tagNoteRows(["n1"], [rnote({ noteUuid: "n1", title: null })]);
    expect(rows).toEqual([{ noteId: "n1", title: null }]);
  });
});
