// Unit tests for the multi-tab + split-pane workspace model (MYND-166, Task 1;
// heterogeneous note|view items added by MYND-274 Saved Views #4 / SYNC-10).
// Pure model — no React, no IPC. Drives the duplicate-forbid invariant,
// the ≥1-leaf invariant, the tree split/collapse behavior, and the tagged
// item type (a note and a view may share an id-string without collision).

import { describe, expect, it } from "vitest";
import {
  activeItem,
  activeSlot,
  activeSlotState,
  closePane,
  closeTab,
  collectLeaves,
  createSlot,
  deleteSlot,
  dropItemOnPane,
  emptyNamedWorkspaces,
  emptyWorkspace,
  findItemPane,
  findLeaf,
  focusedLeaf,
  GRAPH_TAB_ID,
  graphItem,
  isPinned,
  itemKey,
  itemViewMode,
  type LeafPane,
  listSlots,
  moveTab,
  type NamedWorkspaces,
  noteItem,
  openInFocusedTab,
  openInNewTab,
  openToSide,
  parseItemKey,
  renameSlot,
  resetActiveToSnapshot,
  resolveActiveSlot,
  reveal,
  saveAsSlot,
  setActiveSlotState,
  setActiveTab,
  setFocusedPane,
  setItemViewMode,
  setPinned,
  setStacked,
  shouldFlushWorkspace,
  splitPane,
  splitPaneWithItem,
  switchToSlot,
  toggleStacked,
  viewItem,
  WORKSPACE_FLUSH_INTERVAL_MS,
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

describe("graph tab (MYND-198 — whole-vault graph as a tab)", () => {
  it("graphItem / itemKey / parseItemKey round-trip", () => {
    const g = graphItem();
    expect(g).toEqual({ kind: "graph", id: GRAPH_TAB_ID });
    expect(itemKey(g)).toBe(`graph:${GRAPH_TAB_ID}`);
    expect(parseItemKey(itemKey(g))).toEqual(g);
  });

  it("opens as a first-class tab alongside notes and views", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, graphItem()); // [note:a, graph]
    expect(focusedLeaf(ws).tabs).toEqual([n("a"), graphItem()]);
    expect(activeItem(ws)).toEqual(graphItem());
    expect(findItemPane(ws, graphItem())).toBe("root");
    assertNoDuplicates(ws);
  });

  it("is a singleton — re-opening the graph reveals the existing tab", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, graphItem()); // root: [graph]
    ws = openToSide(ws, n("a"), id); // p1: [note:a], focused
    expect(ws.focusedPaneId).not.toBe("root");
    ws = openInFocusedTab(ws, graphItem()); // already open in root → reveal
    expect(ws.focusedPaneId).toBe("root");
    expect(activeItem(ws)).toEqual(graphItem());
    expect(collectLeaves(ws.root)).toHaveLength(2); // no 2nd graph, no new pane
    assertNoDuplicates(ws);
  });

  it("closes like any other tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, graphItem());
    ws = closeTab(ws, "root", graphItem());
    expect(focusedLeaf(ws).tabs).toEqual([n("a")]);
    assertNoDuplicates(ws);
  });
});

// ── tab-modes: pinned tabs (MYND-320) ────────────────────────────────────

describe("pinned tabs (MYND-320)", () => {
  /** The focused leaf's first tab's pinned flag (terse assertion helper). */
  function firstPinned(ws: WorkspaceState): boolean {
    return isPinned(focusedLeaf(ws).tabs[0]!);
  }

  it("setPinned sets the flag on the matching tab + the active tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    expect(firstPinned(ws)).toBe(false);
    ws = setPinned(ws, "root", n("a"), true);
    expect(firstPinned(ws)).toBe(true);
    expect(isPinned(activeItem(ws)!)).toBe(true);
  });

  it("unpinning DROPS the key (omit-when-default — no `pinned: false`)", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = setPinned(ws, "root", n("a"), true);
    ws = setPinned(ws, "root", n("a"), false);
    const tab = focusedLeaf(ws).tabs[0]!;
    expect(isPinned(tab)).toBe(false);
    expect("pinned" in tab).toBe(false); // the key is gone, not set to false
  });

  it("setPinned leaves the tree unchanged when the pane doesn't hold the item", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    const out = setPinned(ws, "root", n("nope"), true);
    expect(out).toEqual(ws);
    expect(firstPinned(out)).toBe(false);
  });

  it("pin is NOT part of identity — duplicate-forbid + sameItem hold", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = setPinned(ws, "root", n("a"), true);
    // Re-opening the (now-pinned) item reveals it, never a 2nd instance.
    ws = openInFocusedTab(ws, n("a"));
    expect(focusedLeaf(ws).tabs).toHaveLength(1);
    assertNoDuplicates(ws);
  });

  it("navigating from a PINNED active tab opens a NEW tab in the same pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a")); // [a] active a
    ws = setPinned(ws, "root", n("a"), true);
    ws = openInFocusedTab(ws, n("b")); // would normally REUSE a's slot
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "b"]); // a survives, b appended
    expect(activeId(ws)).toBe("b");
    expect(firstPinned(ws)).toBe(true); // a is still pinned
    assertNoDuplicates(ws);
  });

  it("navigating from a NON-pinned active tab still reuses the slot (unchanged)", () => {
    let ws = emptyWorkspace("root");
    ws = openInFocusedTab(ws, n("a")); // seed
    ws = openInFocusedTab(ws, n("b")); // reuse a's slot
    expect(tabIds(focusedLeaf(ws))).toEqual(["b"]);
    expect(activeId(ws)).toBe("b");
  });

  it("a pinned tab is NOT closed by closeTab; unpin restores the close", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setPinned(ws, "root", n("a"), true);
    const guarded = closeTab(ws, "root", n("a"));
    expect(guarded).toBe(ws); // no-op: pinned tab survives
    expect(tabIds(focusedLeaf(ws))).toEqual(["a", "b"]);
    // Unpin → close now works.
    ws = setPinned(ws, "root", n("a"), false);
    ws = closeTab(ws, "root", n("a"));
    expect(tabIds(focusedLeaf(ws))).toEqual(["b"]);
  });

  it("activating a pinned tab via a bare handle preserves its pinned flag", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setPinned(ws, "root", n("a"), true);
    ws = setActiveTab(ws, "root", n("a")); // bare handle (no pinned key)
    expect(isPinned(activeItem(ws)!)).toBe(true);
  });

  it("a pinned tab keeps its flag across a same-pane reorder", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setPinned(ws, "root", n("a"), true);
    ws = moveTab(ws, "root", "root", n("a"), 2); // move a to the end
    const leaf = focusedLeaf(ws);
    expect(tabIds(leaf)).toEqual(["b", "a"]);
    expect(isPinned(leaf.tabs[1]!)).toBe(true);
  });

  it("a pinned tab can still drag-to-split (relocates, doesn't close)", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    ws = setPinned(ws, "root", n("a"), true);
    ws = splitPaneWithItem(ws, "root", "row", "after", n("a"), id);
    expect(collectLeaves(ws.root)).toHaveLength(2);
    // a relocated to the new pane and is STILL pinned.
    const moved = collectLeaves(ws.root).flatMap((l) => l.tabs).find((t) => t.id === "a")!;
    expect(isPinned(moved)).toBe(true);
    assertNoDuplicates(ws);
  });
});

// ── tab-modes: stacked layout (MYND-319) ─────────────────────────────────

describe("stacked layout (MYND-319)", () => {
  it("setStacked sets the per-leaf flag; turning it off DROPS the key", () => {
    let ws = emptyWorkspace("root");
    ws = setStacked(ws, "root", true);
    expect((focusedLeaf(ws) as LeafPane).stacked).toBe(true);
    ws = setStacked(ws, "root", false);
    const leaf = focusedLeaf(ws);
    expect(leaf.stacked).toBeUndefined();
    expect("stacked" in leaf).toBe(false); // omit-when-default
  });

  it("toggleStacked flips the focused leaf's flag", () => {
    let ws = emptyWorkspace("root");
    ws = toggleStacked(ws, "root");
    expect(focusedLeaf(ws).stacked).toBe(true);
    ws = toggleStacked(ws, "root");
    expect(focusedLeaf(ws).stacked).toBeUndefined();
  });

  it("is per-leaf — one pane stacked while another stays normal (composes with splits)", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, n("a"));
    ws = openToSide(ws, n("b"), id); // split → 2 leaves
    const [left, right] = collectLeaves(ws.root);
    ws = setStacked(ws, right!.id, true);
    const [l2, r2] = collectLeaves(ws.root);
    expect(l2!.stacked).toBeUndefined();
    expect(r2!.stacked).toBe(true);
    expect(left!.id).toBe(l2!.id);
  });

  it("toggleStacked is a no-op off a leaf id", () => {
    let ws = emptyWorkspace("root");
    const out = toggleStacked(ws, "ghost");
    expect(out).toBe(ws);
  });
});

// ── reading-source-modes (MYND-299): per-tab viewMode ────────────────────────

describe("setItemViewMode", () => {
  function twoTabs(): WorkspaceState {
    let ws = emptyWorkspace("p");
    ws = openInNewTab(ws, n("a"));
    ws = openInNewTab(ws, n("b"));
    return ws;
  }

  it("defaults to live (omit-when-default: absent ⇒ live)", () => {
    expect(itemViewMode(n("a"))).toBe("live");
    const ws = twoTabs();
    expect(itemViewMode(focusedLeaf(ws).tabs[0]!)).toBe("live");
  });

  it("sets a non-default mode and keeps the activeTab in sync", () => {
    let ws = twoTabs(); // active is "b"
    ws = setItemViewMode(ws, "p", n("b"), "reading");
    const leaf = focusedLeaf(ws);
    expect(itemViewMode(leaf.tabs[1]!)).toBe("reading");
    expect(leaf.activeTab).toEqual({ kind: "note", id: "b", viewMode: "reading" });
  });

  it("setting back to live DROPS the key (no `viewMode: 'live'` round-trips in)", () => {
    let ws = twoTabs();
    ws = setItemViewMode(ws, "p", n("a"), "source");
    expect(focusedLeaf(ws).tabs[0]).toEqual({ kind: "note", id: "a", viewMode: "source" });
    ws = setItemViewMode(ws, "p", n("a"), "live");
    expect(focusedLeaf(ws).tabs[0]).toEqual(n("a"));
    expect("viewMode" in focusedLeaf(ws).tabs[0]!).toBe(false);
  });

  it("is a no-op when the pane doesn't hold the item", () => {
    const ws = twoTabs();
    const out = setItemViewMode(ws, "p", n("zzz"), "reading");
    expect(out).toEqual(ws);
  });

  it("composes with pinned (both flags coexist on a tab)", () => {
    let ws = twoTabs();
    ws = setPinned(ws, "p", n("a"), true);
    ws = setItemViewMode(ws, "p", n("a"), "reading");
    expect(focusedLeaf(ws).tabs[0]).toEqual({
      kind: "note",
      id: "a",
      pinned: true,
      viewMode: "reading",
    });
  });
});

// ── named-workspaces (MYND-308): N slots over the descriptor ─────────────────

describe("named workspaces — container construction + selectors", () => {
  it("emptyNamedWorkspaces holds one active Default slot", () => {
    const c = emptyNamedWorkspaces("root", "s1");
    expect(c.slots).toHaveLength(1);
    expect(c.slots[0]!.name).toBe("Default");
    expect(c.activeId).toBe("s1");
    expect(activeSlot(c)!.id).toBe("s1");
    expect(activeSlotState(c)).toEqual(emptyWorkspace("root"));
  });

  it("setActiveSlotState commits a descriptor onto the active slot only", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = setActiveSlotState(c, openInNewTab(activeSlotState(c), n("a")));
    expect(activeSlotState(c).root).toEqual(
      openInNewTab(emptyWorkspace("root"), n("a")).root,
    );
  });
});

describe("named workspaces — CRUD", () => {
  function ids(...values: string[]): () => string {
    let i = 0;
    return () => values[i++]!;
  }

  it("createSlot appends a fresh slot and activates it", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = createSlot(c, "Research", undefined, ids("s2"), () => "pane2");
    expect(listSlots(c)).toHaveLength(2);
    expect(c.activeId).toBe("s2");
    expect(activeSlot(c)!.name).toBe("Research");
  });

  it("saveAsSlot clones the active descriptor under a new name, original untouched", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = setActiveSlotState(c, openInNewTab(activeSlotState(c), n("a")));
    c = saveAsSlot(c, "Copy", ids("s2"));
    expect(c.activeId).toBe("s2");
    // Both slots have the tab, but they are distinct (no aliasing).
    const original = c.slots.find((s) => s.id === "s1")!;
    const clone = c.slots.find((s) => s.id === "s2")!;
    expect(activeSlotState(c).root).toEqual(original.state.root);
    expect(clone.state).not.toBe(original.state);
    expect(clone.state.root).not.toBe(original.state.root);
    // Mutating the clone via a reducer does not touch the original.
    c = setActiveSlotState(c, openInNewTab(activeSlotState(c), n("b")));
    expect(c.slots.find((s) => s.id === "s1")!.state).toEqual(original.state);
  });

  it("switchToSlot activates an existing slot; no-op on unknown id", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = createSlot(c, "B", undefined, ids("s2"), () => "p2");
    c = switchToSlot(c, "s1");
    expect(c.activeId).toBe("s1");
    expect(switchToSlot(c, "ghost")).toBe(c);
  });

  it("renameSlot renames; no-op on unknown id", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = renameSlot(c, "s1", "Renamed");
    expect(c.slots[0]!.name).toBe("Renamed");
    expect(renameSlot(c, "ghost", "x")).toBe(c);
  });

  it("deleteSlot of a non-active slot keeps the active pointer", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = createSlot(c, "B", undefined, ids("s2"), () => "p2"); // active = s2
    c = deleteSlot(c, "s1");
    expect(c.slots.map((s) => s.id)).toEqual(["s2"]);
    expect(c.activeId).toBe("s2");
  });

  it("deleteSlot of the active slot relocates the pointer to a sibling", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = createSlot(c, "B", undefined, ids("s2"), () => "p2");
    c = createSlot(c, "C", undefined, ids("s3"), () => "p3"); // active = s3
    c = switchToSlot(c, "s2"); // active = s2 (middle)
    c = deleteSlot(c, "s2");
    expect(c.slots.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(c.activeId).toBe("s1"); // previous sibling
  });

  it("deleting the LAST slot yields a fresh empty Default slot", () => {
    let c = emptyNamedWorkspaces("root", "s1");
    c = deleteSlot(c, "s1", ids("s-new"), () => "pane-new");
    expect(c.slots).toHaveLength(1);
    expect(c.slots[0]!.id).toBe("s-new");
    expect(c.slots[0]!.name).toBe("Default");
    expect(c.activeId).toBe("s-new");
    expect(activeSlotState(c)).toEqual(emptyWorkspace("pane-new"));
  });

  it("deleteSlot is a no-op on an unknown id", () => {
    const c = emptyNamedWorkspaces("root", "s1");
    expect(deleteSlot(c, "ghost")).toBe(c);
  });
});

describe("resolveActiveSlot — MYP1 active_workspace consistency fallback", () => {
  const slots = [
    { id: "s1", name: "A", state: emptyWorkspace("p1") },
    { id: "s2", name: "B", state: emptyWorkspace("p2") },
  ];

  it("returns the pref id when it names an existing slot", () => {
    expect(resolveActiveSlot(slots, "s2")).toBe("s2");
  });

  it("falls back to the first slot when the pref is missing/null/unknown", () => {
    expect(resolveActiveSlot(slots, null)).toBe("s1");
    expect(resolveActiveSlot(slots, undefined)).toBe("s1");
    expect(resolveActiveSlot(slots, "ghost")).toBe("s1");
  });
});

describe("shouldFlushWorkspace — coalesced ≤5-min write cadence", () => {
  it("never flushes when not dirty", () => {
    expect(
      shouldFlushWorkspace({ lastFlushAtMs: null, nowMs: 999999, dirty: false }),
    ).toBe(false);
  });

  it("flushes immediately when dirty and never flushed before", () => {
    expect(
      shouldFlushWorkspace({ lastFlushAtMs: null, nowMs: 0, dirty: true }),
    ).toBe(true);
  });

  it("does NOT flush again before the interval elapses", () => {
    expect(
      shouldFlushWorkspace({
        lastFlushAtMs: 1_000_000,
        nowMs: 1_000_000 + WORKSPACE_FLUSH_INTERVAL_MS - 1,
        dirty: true,
      }),
    ).toBe(false);
  });

  it("flushes once the interval has elapsed (≥ exactly 5 min)", () => {
    expect(
      shouldFlushWorkspace({
        lastFlushAtMs: 1_000_000,
        nowMs: 1_000_000 + WORKSPACE_FLUSH_INTERVAL_MS,
        dirty: true,
      }),
    ).toBe(true);
    expect(WORKSPACE_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(300_000);
  });
});

describe("resetActiveToSnapshot", () => {
  it("reverts the active slot to a last-persisted descriptor (no aliasing)", () => {
    let c: NamedWorkspaces = emptyNamedWorkspaces("root", "s1");
    const snapshot = openInNewTab(emptyWorkspace("root"), n("saved"));
    // Dirty the active slot away from the snapshot.
    c = setActiveSlotState(c, openInNewTab(activeSlotState(c), n("scratch")));
    c = resetActiveToSnapshot(c, snapshot);
    expect(activeSlotState(c)).toEqual(snapshot);
    // The container holds a clone, not the passed-in object.
    expect(activeSlotState(c)).not.toBe(snapshot);
  });
});
