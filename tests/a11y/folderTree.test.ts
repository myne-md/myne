// @vitest-environment jsdom
//
// The sidebar folder tree's ARIA shape and its keyboard (myne-md/myne#728,
// task 7).
//
// Two halves, and they fail in different ways.
//
// The SHAPE half: this tree is flattened before it is rendered, because the
// sidebar windows it through `VirtualList`. There is one flat list of rows and
// no nested DOM containers at all, so `role="group"` (the WAI-ARIA tree
// pattern's way of expressing nesting) has nothing to wrap, and a screen reader
// walking the rendered rows would hear a flat list of treeitems while the
// indentation drew a hierarchy nobody was told about.
// `aria-level` / `aria-posinset` / `aria-setsize` are ARIA's prescribed answer
// for exactly that case, and they are computed in the flattener because only it
// knows a container's child count.
//
// The KEYBOARD half: folder rows were unreachable. The document-level handler
// walks note IDS, so it could never land on a folder, and there was no key that
// expanded or collapsed one. The tree's own handler walks ROWS.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flattenVisibleRows, buildFavoriteRows } from "../../src/notes/components/folderTreeRows";
import { makeTreeKeydownHandler } from "../../src/notes/components/NoteList";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import type { FolderNode, FolderTree } from "../../src/notes/folderTree";

afterEach(() => {
  document.body.innerHTML = "";
});

function rec(id: string): TitleRecord {
  return {
    noteUuid: id,
    title: id,
    folder: null,
    updatedAt: null,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: false,
    conflictOf: null,
    hasSource: false,
    kind: null,
    done: null,
  };
}

function folder(key: string, over: Partial<FolderNode> = {}): FolderNode {
  return {
    key,
    name: key,
    path: key,
    children: [],
    noteIds: [],
    indexNoteId: null,
    ...over,
  } as FolderNode;
}

describe("the flattened tree carries its hierarchy", () => {
  //   a/        level 1, 1 of 3
  //     a1      level 2, 1 of 2
  //     n-deep  level 2, 2 of 2
  //   b/        level 1, 2 of 3   (collapsed)
  //     hidden  not a row at all
  //   n-root    level 1, 3 of 3
  const tree: FolderTree = {
    roots: [
      folder("a", { children: [folder("a1")], noteIds: ["n-deep"] }),
      folder("b", { noteIds: ["hidden"] }),
    ],
    unfiledNoteIds: ["n-root"],
  } as FolderTree;
  const cache = new Map([
    ["n-deep", rec("n-deep")],
    ["n-root", rec("n-root")],
    ["hidden", rec("hidden")],
  ]);

  it("levels are 1-based and nest", () => {
    const rows = flattenVisibleRows(tree, cache, new Set(["b"]), {}, null);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("f-a")?.level).toBe(1);
    expect(byKey.get("f-a1")?.level).toBe(2);
    expect(byKey.get("n-n-deep")?.level).toBe(2);
    expect(byKey.get("n-n-root")?.level).toBe(1);
  });

  it("positions count within the OWN container, not across the whole list", () => {
    // The trap a naive running counter falls into: a child's subtree is walked
    // between two siblings, so a single incrementing index would make the
    // second root "3 of 3" and the announcement would be a lie about depth.
    const rows = flattenVisibleRows(tree, cache, new Set(["b"]), {}, null);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect([byKey.get("f-a")?.posInSet, byKey.get("f-a")?.setSize]).toEqual([1, 3]);
    expect([byKey.get("f-b")?.posInSet, byKey.get("f-b")?.setSize]).toEqual([2, 3]);
    expect([byKey.get("n-n-root")?.posInSet, byKey.get("n-n-root")?.setSize]).toEqual([3, 3]);
    expect([byKey.get("f-a1")?.posInSet, byKey.get("f-a1")?.setSize]).toEqual([1, 2]);
    expect([byKey.get("n-n-deep")?.posInSet, byKey.get("n-n-deep")?.setSize]).toEqual([2, 2]);
  });

  it("a collapsed folder's children are in nobody's set", () => {
    // They are not rows, so counting them would announce a set the user cannot
    // walk to the end of.
    const rows = flattenVisibleRows(tree, cache, new Set(["b"]), {}, null);
    expect(rows.some((r) => r.key === "n-hidden")).toBe(false);
  });

  it("favourites are a flat set, counted after the stale-id filter", () => {
    // A favourite whose note is gone is not a row; "3 of 7" over four rendered
    // rows is worse than announcing nothing.
    const rows = buildFavoriteRows(["n-root", "gone", "n-deep"], cache);
    expect(rows.map((r) => [r.posInSet, r.setSize, r.level])).toEqual([
      [1, 2, 1],
      [2, 2, 1],
    ]);
  });
});

// ── the keyboard ─────────────────────────────────────────────────────────

/** Build a rendered tree: `[level, kind, id]` per row, in DOM order. */
function renderRows(spec: Array<[number, "folder" | "note", string, ("open" | "shut")?]>): void {
  document.body.innerHTML = `<div role="tree">${spec
    .map(([level, kind, id, state]) =>
      kind === "folder"
        ? `<div role="treeitem" tabindex="-1" aria-level="${level}" data-folder-key="${id}"` +
          (state === undefined ? "" : ` aria-expanded="${state === "open"}"`) +
          `>${id}</div>`
        : `<div role="treeitem" tabindex="-1" aria-level="${level}" data-note-id="${id}">${id}</div>`,
    )
    .join("")}</div>`;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'));
}

function press(
  key: string,
  target: EventTarget | null,
  over: Partial<Parameters<typeof makeTreeKeydownHandler>[0]> = {},
) {
  const select = vi.fn();
  const open = vi.fn();
  const toggleFolder = vi.fn();
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  makeTreeKeydownHandler({
    rowsOf: rows,
    select,
    open,
    toggleFolder,
    renaming: false,
    ...over,
  })({ key, target, preventDefault, stopPropagation });
  return { select, open, toggleFolder, preventDefault, stopPropagation };
}

describe("the tree's keyboard walks folders as well as notes", () => {
  it("Down steps onto a folder row, which the note-id handler could never do", () => {
    renderRows([
      [1, "note", "n1"],
      [1, "folder", "f1", "shut"],
    ]);
    const { select } = press("ArrowDown", rows()[0]!);
    expect(document.activeElement).toBe(rows()[1]);
    // A folder is a focus stop, not a selection.
    expect(select).not.toHaveBeenCalled();
  });

  it("Down onto a note row selects it, keeping the behaviour that already worked", () => {
    renderRows([
      [1, "folder", "f1", "open"],
      [2, "note", "n1"],
    ]);
    const { select } = press("ArrowDown", rows()[0]!);
    expect(document.activeElement).toBe(rows()[1]);
    expect(select).toHaveBeenCalledWith("n1");
  });

  it("clamps at both ends rather than wrapping", () => {
    // A tree is not a tab strip: wrapping from the last row to the first loses
    // the user's place in a list that can be hundreds long.
    renderRows([
      [1, "note", "n1"],
      [1, "note", "n2"],
    ]);
    press("ArrowUp", rows()[0]!);
    expect(document.activeElement).toBe(rows()[0]);
    press("ArrowDown", rows()[1]!);
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("Right opens a collapsed folder and Left closes an open one", () => {
    renderRows([[1, "folder", "f1", "shut"]]);
    expect(press("ArrowRight", rows()[0]!).toggleFolder).toHaveBeenCalledWith("f1");
    renderRows([[1, "folder", "f1", "open"]]);
    expect(press("ArrowLeft", rows()[0]!).toggleFolder).toHaveBeenCalledWith("f1");
  });

  it("Right on an ALREADY-open folder steps into it instead of closing it", () => {
    renderRows([
      [1, "folder", "f1", "open"],
      [2, "note", "n1"],
    ]);
    const { toggleFolder } = press("ArrowRight", rows()[0]!);
    expect(toggleFolder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("Left from a child steps out to its parent", () => {
    renderRows([
      [1, "folder", "f1", "open"],
      [2, "folder", "f2", "open"],
      [3, "note", "deep"],
    ]);
    press("ArrowLeft", rows()[2]!);
    expect(document.activeElement).toBe(rows()[1]);
  });

  it("Left on a leaf at the root does nothing rather than jumping", () => {
    renderRows([
      [1, "note", "n1"],
      [1, "note", "n2"],
    ]);
    const before = document.activeElement;
    press("ArrowLeft", rows()[1]!);
    expect(document.activeElement).toBe(before);
  });

  it("Right on a leaf does nothing, which is what a leaf does", () => {
    renderRows([[1, "note", "n1"]]);
    const { toggleFolder, preventDefault } = press("ArrowRight", rows()[0]!);
    expect(toggleFolder).not.toHaveBeenCalled();
    // Not even claimed, so nothing else is prevented from seeing it.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Enter opens a note and toggles a folder", () => {
    renderRows([[1, "note", "n1"]]);
    expect(press("Enter", rows()[0]!).open).toHaveBeenCalledWith("n1");
    renderRows([[1, "folder", "f1", "shut"]]);
    expect(press(" ", rows()[0]!).toggleFolder).toHaveBeenCalledWith("f1");
  });

  it("stops a handled key from reaching the document handler", () => {
    // Both are live at once; without this they would both act on one press and
    // the selection would move two rows.
    renderRows([
      [1, "note", "n1"],
      [1, "note", "n2"],
    ]);
    const { preventDefault, stopPropagation } = press("ArrowDown", rows()[0]!);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("leaves Home and End to the document handler", () => {
    // It ranges over the whole note list; this one can only see the rows the
    // virtualizer has mounted, so its "end" would be the end of the window.
    renderRows([
      [1, "note", "n1"],
      [1, "note", "n2"],
    ]);
    for (const key of ["Home", "End", "PageDown", "PageUp"]) {
      const { preventDefault, stopPropagation } = press(key, rows()[0]!);
      expect(preventDefault, key).not.toHaveBeenCalled();
      expect(stopPropagation, key).not.toHaveBeenCalled();
    }
  });

  it("stands down for the inline rename input inside a row", () => {
    document.body.innerHTML =
      '<div role="tree"><div role="treeitem" data-note-id="n1"><input /></div></div>';
    const input = document.querySelector("input") as HTMLElement;
    const { preventDefault } = press("ArrowDown", input);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("stands down entirely while a rename is in progress", () => {
    renderRows([
      [1, "note", "n1"],
      [1, "note", "n2"],
    ]);
    const { preventDefault } = press("ArrowDown", rows()[0]!, { renaming: true });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("ignores a press that did not come from a row", () => {
    renderRows([[1, "note", "n1"]]);
    const tree = document.querySelector('[role="tree"]') as HTMLElement;
    const { preventDefault } = press("ArrowDown", tree);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
