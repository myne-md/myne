// Unit tests for the multi-tab + split-pane workspace model (MYND-166, Task 1;
// heterogeneous note|view items added by MYND-274 Saved Views #4 / SYNC-10).
// Pure model — no React, no IPC. Drives the duplicate-forbid invariant,
// the ≥1-leaf invariant, the tree split/collapse behavior, and the tagged
// item type (a note and a view may share an id-string without collision).

import { describe, expect, it } from "vitest";
import {
  activeItem,
  closePane,
  closeTab,
  collectLeaves,
  dropItemOnPane,
  emptyWorkspace,
  findItemPane,
  findLeaf,
  focusedLeaf,
  itemKey,
  type LeafPane,
  moveTab,
  noteItem,
  openInFocusedTab,
  openInNewTab,
  openToSide,
  reveal,
  setActiveTab,
  setFocusedPane,
  splitPane,
  splitPaneWithItem,
  viewItem,
  type WorkspaceState,
} from "../../src/notes/workspaceState";

/** Note-item shorthand for terse test inputs. */
const n = noteItem;
/** View-item shorthand. */
const v = viewItem;

/** Project a leaf's tabs to their id strings (note-only assertions stay terse). */
function tabIds(leaf: LeafPane): string[] {
  return leaf.tabs.map((t) => t.id);
}

/** The focused pane's active-tab id (or null). */
function activeId(ws: WorkspaceState): string | null {
  return activeItem(ws)?.id ?? null;
}

/** Deterministic pane-id factory for tests (`p1`, `p2`, …). */
function counter(): () => string {
  let n = 0;
  return () => `p${++n}`;
}

/** Every item (by kind+id) appears in at most one tab across the whole tree. */
function assertNoDuplicates(state: WorkspaceState): void {
  const seen = new Set<string>();
  for (const leaf of collectLeaves(state.root)) {
    for (const t of leaf.tabs) {
      const k = itemKey(t);
      expect(seen.has(k), `duplicate tab ${k}`).toBe(false);
      seen.add(k);
    }
  }
}

describe("emptyWorkspace", () => {
  it("is a single focused, tabless leaf", () => {
    const ws = emptyWorkspace("root");
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(ws.focusedPaneId).toBe("root");
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeItem(ws)).toBeNull();
  });
});

describe("open behaviors", () => {
  it("openInNewTab appends and activates", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "b"]);
    expect(activeId(ws)).toBe("b");
  });

  it("openInFocusedTab reuses the active slot in place", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b")); // tabs: [a, b], active b
    ws = openInFocusedTab(ws, n("c")); // reuse active slot (b → c)
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "c"]);
    expect(activeId(ws)).toBe("c");
  });

  it("openInFocusedTab seeds the first tab when the pane is empty", () => {
    let ws = emptyWorkspace("root");
    ws = openInFocusedTab(ws, n("a"));
    expect(tabIds(focusedLeaf(ws))).toEqual(["a"]);
    expect(activeId(ws)).toBe("a");
  });
});

describe("global duplicate-forbid → reveal", () => {
  it("openInNewTab on an already-open note reveals instead of duplicating", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setActiveTab(ws, ws.focusedPaneId, n("a")); // active a, but b still open
    ws = openInNewTab(ws, n("b")); // already open → reveal
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "b"]); // no third tab
    expect(activeId(ws)).toBe("b");
    assertNoDuplicates(ws);
  });

  it("reveal works across panes (open-to-side then re-open focuses the other pane)", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a")); // pane root: [a]
    ws = openToSide(ws, n("b"), id); // new pane p1: [b], focused
    expect(collectLeaves(ws.root)).toHaveLength(2);
    const sidePane = ws.focusedPaneId;
    ws = setFocusedPane(ws, "root"); // focus back to the original pane
    ws = openInNewTab(ws, n("b")); // b already open in the side pane → reveal it
    expect(ws.focusedPaneId).toBe(sidePane);
    expect(activeId(ws)).toBe("b");
    expect(collectLeaves(ws.root)).toHaveLength(2); // no new pane
    assertNoDuplicates(ws);
  });

  it("openToSide on an already-open note reveals, never creating a pane", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openToSide(ws, n("a"), id); // a already open here → reveal, no split
    expect(collectLeaves(ws.root)).toHaveLength(1);
    assertNoDuplicates(ws);
  });
});

describe("split panes", () => {
  it("openToSide creates a second pane and focuses it", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openToSide(ws, n("b"), id);
    const leaves = collectLeaves(ws.root);
    expect(leaves).toHaveLength(2);
    expect(ws.root.kind).toBe("split");
    expect(tabIds(focusedLeaf(ws))).toEqual(["b"]);
    expect(findItemPane(ws, n("a"))).not.toBe(ws.focusedPaneId);
  });

  it("splitPane makes a fresh empty focused leaf", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = splitPane(ws, "root", "row", id);
    expect(collectLeaves(ws.root)).toHaveLength(2);
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeItem(ws)).toBeNull();
  });

  it("same-direction split inserts a sibling rather than nesting", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = splitPane(ws, "root", "row", id); // root split [root, p1]
    const firstSideId = ws.focusedPaneId;
    ws = splitPane(ws, firstSideId, "row", id); // same direction → 3 siblings
    expect(ws.root.kind).toBe("split");
    if (ws.root.kind === "split") {
      expect(ws.root.direction).toBe("row");
      expect(ws.root.children.every((c) => c.kind === "leaf")).toBe(true);
      expect(ws.root.children).toHaveLength(3);
    }
  });

  it("cross-direction split nests a new split node", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = splitPane(ws, "root", "row", id); // root: row [root, p1]
    ws = splitPane(ws, "root", "column", id); // wrap root leaf in a column split
    expect(ws.root.kind).toBe("split");
    if (ws.root.kind === "split") {
      expect(ws.root.direction).toBe("row");
      expect(ws.root.children[0]!.kind).toBe("split"); // nested column split
    }
  });
});

describe("closeTab", () => {
  it("activates the right neighbor when closing the active tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = openInNewTab(ws, n("c"));
    ws = setActiveTab(ws, "root", n("b"));
    ws = closeTab(ws, "root", n("b"));
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "c"]);
    expect(activeId(ws)).toBe("c"); // right neighbor
  });

  it("falls back to the left neighbor when closing the last tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setActiveTab(ws, "root", n("b")); // active is last
    ws = closeTab(ws, "root", n("b"));
    expect(activeId(ws)).toBe("a"); // left neighbor
  });

  it("emptying the ONLY pane keeps it tabless (empty-editor-shell)", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = closeTab(ws, "root", n("a"));
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeItem(ws)).toBeNull();
  });

  it("emptying a NON-last pane removes it and collapses the split", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a")); // pane root: [a]
    ws = openToSide(ws, n("b"), id); // pane p1: [b], focused
    ws = closeTab(ws, ws.focusedPaneId, n("b")); // empties p1 → removed
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(ws.root.kind).toBe("leaf"); // collapsed back to a single leaf
    expect(findItemPane(ws, n("a"))).toBe(ws.focusedPaneId); // focus relocated
  });
});

describe("closePane + ≥1-leaf invariant", () => {
  it("closePane on the only leaf is a no-op", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    const before = ws;
    ws = closePane(ws, "root");
    expect(ws).toBe(before); // unchanged reference — true no-op
  });

  it("closePane removes a pane and relocates focus", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openToSide(ws, n("b"), id); // focus on the new side pane
    const sideId = ws.focusedPaneId;
    ws = closePane(ws, sideId);
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(findLeaf(ws.root, ws.focusedPaneId)).not.toBeNull(); // focus valid
  });
});

describe("setFocusedPane / setActiveTab guards", () => {
  it("setFocusedPane ignores a non-existent pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    const before = ws;
    ws = setFocusedPane(ws, "ghost");
    expect(ws).toBe(before);
  });

  it("setActiveTab ignores an item not in the pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = setActiveTab(ws, "root", n("not-open"));
    expect(activeId(ws)).toBe("a");
  });

  it("reveal on an item that isn't open is a no-op", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    const before = ws;
    ws = reveal(ws, n("nope"));
    expect(ws).toBe(before);
  });
});

describe("moveTab", () => {
  it("reorders within a strip", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = openInNewTab(ws, n("c")); // [a,b,c]
    ws = moveTab(ws, "root", "root", n("a"), 2); // move a to index 2
    expect(tabIds(focusedLeaf(ws))).toEqual(["b", "c", "a"]);
    expect(activeId(ws)).toBe("a");
  });

  it("moves a tab to another pane and removes it from the source", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b")); // root: [a,b]
    ws = openToSide(ws, n("c"), id); // p1: [c]
    const sideId = ws.focusedPaneId;
    ws = moveTab(ws, "root", sideId, n("b"), 1); // move b → side at end
    expect(findItemPane(ws, n("b"))).toBe(sideId);
    expect(tabIds(findLeaf(ws.root, "root")!)).toEqual(["a"]);
    expect(tabIds(findLeaf(ws.root, sideId)!)).toEqual(["c", "b"]);
    expect(ws.focusedPaneId).toBe(sideId);
  });

  it("dragging the last tab out of a non-last pane closes that pane", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a")); // root: [a]
    ws = openToSide(ws, n("b"), id); // p1: [b], focused
    const sideId = ws.focusedPaneId;
    ws = moveTab(ws, sideId, "root", n("b"), 1); // move b back → side empties
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(tabIds(findLeaf(ws.root, "root")!)).toEqual(["a", "b"]);
  });

  it("is a no-op when the item isn't in the source pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    const before = ws;
    ws = moveTab(ws, "root", "root", n("ghost"), 0);
    expect(ws).toBe(before);
  });
});

// ── MYND-166 behavioral pass: drag-to-split + drop-as-tab ──────────────

/** A 2-leaf row workspace: leaf "L" holds [a]; a second focused leaf holds
 *  [b]. Returns the second leaf's id. */
function twoPanes(): { ws: WorkspaceState; right: string } {
  const next = counter();
  let ws = emptyWorkspace("L");
  ws = openInNewTab(ws, n("a")); // L: [a]
  ws = splitPane(ws, "L", "row", next); // fresh empty leaf, focused
  const right = ws.focusedPaneId;
  ws = openInNewTab(ws, n("b")); // right: [b]
  return { ws, right };
}

describe("dropItemOnPane", () => {
  it("inserts a not-yet-open item into the target pane and focuses it", () => {
    const { ws } = twoPanes();
    const next = dropItemOnPane(ws, "L", n("c"), 0);
    const leaf = findLeaf(next.root, "L")!;
    expect(tabIds(leaf)).toEqual(["c", "a"]);
    expect(leaf.activeTab).toEqual(n("c"));
    expect(next.focusedPaneId).toBe("L");
    assertNoDuplicates(next);
  });

  it("moves an already-open item into the target pane (no duplicate)", () => {
    const { ws } = twoPanes();
    const next = dropItemOnPane(ws, "L", n("b"), 1); // b lives in the right pane
    expect(findItemPane(next, n("b"))).toBe("L");
    // The emptied source pane is removed; the tree collapses to L.
    expect(collectLeaves(next.root)).toHaveLength(1);
    expect(tabIds(findLeaf(next.root, "L")!)).toContain("b");
    assertNoDuplicates(next);
  });

  it("reorders within the same pane", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = openInNewTab(ws, n("c")); // L: [a, b, c]
    const next = dropItemOnPane(ws, "L", n("c"), 0);
    expect(tabIds(findLeaf(next.root, "L")!)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when the target pane doesn't exist", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a"));
    expect(dropItemOnPane(ws, "nope", n("x"), 0)).toBe(ws);
  });
});

describe("splitPaneWithItem", () => {
  it("splits row/after — original first, new focused leaf (with the item) second", () => {
    const next = counter();
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a")); // L: [a]
    const out = splitPaneWithItem(ws, "L", "row", "after", n("b"), next);
    expect(out.root.kind).toBe("split");
    expect(collectLeaves(out.root)).toHaveLength(2);
    expect(tabIds(findLeaf(out.root, "L")!)).toEqual(["a"]);
    expect(tabIds(findLeaf(out.root, out.focusedPaneId)!)).toEqual(["b"]);
    if (out.root.kind === "split") {
      expect(out.root.direction).toBe("row");
      expect(out.root.children[0]).toMatchObject({ id: "L" });
      expect(out.root.children[1]!.id).toBe(out.focusedPaneId);
    }
    assertNoDuplicates(out);
  });

  it("'before' places the new leaf ahead of the target", () => {
    const next = counter();
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a"));
    const out = splitPaneWithItem(ws, "L", "row", "before", n("b"), next);
    if (out.root.kind === "split") {
      expect(out.root.children[0]!.id).toBe(out.focusedPaneId);
      expect(out.root.children[1]).toMatchObject({ id: "L" });
    }
  });

  it("moves an already-open item out of its pane when splitting another", () => {
    const { ws, right } = twoPanes(); // L:[a], right:[b]
    const next = counter();
    next(); // burn p1/p2 already used by twoPanes to avoid id reuse
    next();
    const out = splitPaneWithItem(ws, "L", "column", "after", n("b"), next);
    // b moved into the new focused leaf; its old pane is gone (it emptied).
    expect(findItemPane(out, n("b"))).toBe(out.focusedPaneId);
    expect(tabIds(findLeaf(out.root, right) ?? { tabs: [] } as LeafPane)).not.toContain("b");
    assertNoDuplicates(out);
  });

  it("is a no-op when the item is the target pane's only tab", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a")); // a is L's sole tab
    expect(splitPaneWithItem(ws, "L", "row", "after", n("a"), counter())).toBe(ws);
  });

  it("is a no-op when the target pane doesn't exist", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, n("a"));
    expect(
      splitPaneWithItem(ws, "nope", "row", "after", n("x"), counter()),
    ).toBe(ws);
  });
});

// ── MYND-274: heterogeneous note|view tab items (SYNC-10) ──────────────

describe("heterogeneous note|view items", () => {
  it("a note and a view may share an id-string without colliding", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("x")); // note "x"
    ws = openInNewTab(ws, v("x")); // view "x" — distinct item
    expect(focusedLeaf(ws).tabs).toEqual([n("x"), v("x")]);
    expect(findItemPane(ws, n("x"))).toBe("root");
    expect(findItemPane(ws, v("x"))).toBe("root");
    expect(activeItem(ws)).toEqual(v("x"));
    assertNoDuplicates(ws);
  });

  it("opening an already-open view reveals it (duplicate-forbid across kinds)", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, v("books")); // root: [view:books]
    ws = openToSide(ws, n("a"), id); // p1: [note:a], focused
    const sidePane = ws.focusedPaneId;
    expect(sidePane).not.toBe("root");
    ws = openInNewTab(ws, v("books")); // already open in root → reveal
    expect(ws.focusedPaneId).toBe("root");
    expect(activeItem(ws)).toEqual(v("books"));
    expect(collectLeaves(ws.root)).toHaveLength(2); // no new pane, no duplicate
    assertNoDuplicates(ws);
  });

  it("a view tab opens, activates, moves, and closes like a note tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, v("v1")); // [note:a, view:v1]
    ws = setActiveTab(ws, "root", n("a"));
    expect(activeItem(ws)).toEqual(n("a"));
    ws = moveTab(ws, "root", "root", v("v1"), 0); // reorder the view to the front
    expect(focusedLeaf(ws).tabs).toEqual([v("v1"), n("a")]);
    ws = closeTab(ws, "root", v("v1"));
    expect(focusedLeaf(ws).tabs).toEqual([n("a")]);
    assertNoDuplicates(ws);
  });
});
