// Tests for the pure tree-flatten that feeds the sidebar VirtualList.
// Grill 2026-05-29 Q3/Q8. (UI rendering itself has no test runner; this covers
// the row-ordering + collapse + depth logic that the component relies on.)

import { describe, it, expect } from "vitest";
import { deriveFolderTree } from "../../src/notes/folderTree";
import {
  flattenVisibleRows,
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

describe("flattenVisibleRows", () => {
  it("returns no rows for an empty vault", () => {
    const { cache, tree } = build([]);
    expect(flattenVisibleRows(tree, cache, new Set())).toEqual([]);
  });

  it("puts unfiled notes under a Vault root section at depth 0", () => {
    const { cache, tree } = build([rec("a", null, 2), rec("b", null, 1)]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    expect(rows[0]).toMatchObject({ kind: "section", label: "Vault root" });
    expect(rows.slice(1).map((r) => (r.kind === "note" ? r.id : r.kind))).toEqual([
      "a", // newer first (updatedAt desc)
      "b",
    ]);
    expect(rows.every((r) => r.kind !== "note" || r.depth === 0)).toBe(true);
  });

  it("expands ancestor folders and indents the note by depth", () => {
    const { cache, tree } = build([rec("n1", "Projects/Myne/")]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    expect(kinds(rows)).toEqual(["section", "folder", "folder", "note"]);
    const [, projects, myne, note] = rows;
    expect(projects).toMatchObject({ kind: "folder", depth: 0 });
    expect((projects as Extract<VisibleRow, { kind: "folder" }>).node.name).toBe("Projects");
    expect(myne).toMatchObject({ kind: "folder", depth: 1 });
    expect(note).toMatchObject({ kind: "note", id: "n1", depth: 2 });
  });

  it("hides descendants of a collapsed folder", () => {
    const { cache, tree } = build([rec("n1", "Projects/Myne/")]);
    // node.key is the folded path; Projects/ folds to "projects/".
    const rows = flattenVisibleRows(tree, cache, new Set(["projects/"]));
    expect(kinds(rows)).toEqual(["section", "folder"]);
    expect(rows[1]).toMatchObject({ collapsed: true });
    expect(visibleNoteIds(rows)).toEqual([]); // the note is hidden
  });

  it("renders an empty deliberate folder with empty:true and no notes", () => {
    const { cache, tree } = build([], ["Drafts/"]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    expect(kinds(rows)).toEqual(["section", "folder"]);
    expect(rows[1]).toMatchObject({ kind: "folder", empty: true });
  });

  it("orders child folders before this folder's own notes", () => {
    const { cache, tree } = build([
      rec("sub", "Work/Reports/"),
      rec("direct", "Work/"),
    ]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    // Folders section → Work → Reports (subfolder) → sub → direct note last.
    expect(kinds(rows)).toEqual([
      "section",
      "folder", // Work
      "folder", // Work/Reports
      "note", // sub (in Reports)
      "note", // direct (in Work)
    ]);
    expect(visibleNoteIds(rows)).toEqual(["sub", "direct"]);
  });

  it("shows both a Vault root and a Folders section when both exist", () => {
    const { cache, tree } = build([rec("u", null), rec("f", "Box/")]);
    const rows = flattenVisibleRows(tree, cache, new Set());
    const sections = rows.filter((r) => r.kind === "section");
    expect(sections.map((s) => (s.kind === "section" ? s.label : ""))).toEqual([
      "Vault root",
      "Folders",
    ]);
  });
});
