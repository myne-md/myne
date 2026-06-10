// Unit tests for the multi-tab + split-pane workspace model (MYND-166, Task 1).
// Pure model — no React, no IPC. Drives the duplicate-forbid invariant,
// the ≥1-leaf invariant, and the tree split/collapse behavior.

import { describe, expect, it } from "vitest";
import {
  activeNote,
  closePane,
  closeTab,
  collectLeaves,
  dropNoteOnPane,
  emptyWorkspace,
  findLeaf,
  findNotePane,
  focusedLeaf,
  moveTab,
  openInFocusedTab,
  openInNewTab,
  openToSide,
  reveal,
  setActiveTab,
  setFocusedPane,
  splitPane,
  splitPaneWithNote,
  type WorkspaceState,
} from "../../src/notes/workspaceState";

/** Deterministic pane-id factory for tests (`p1`, `p2`, …). */
function counter(): () => string {
  let n = 0;
  return () => `p${++n}`;
}

/** Every note id appears in at most one tab across the whole tree. */
function assertNoDuplicates(state: WorkspaceState): void {
  const seen = new Set<string>();
  for (const leaf of collectLeaves(state.root)) {
    for (const t of leaf.tabs) {
      expect(seen.has(t), `duplicate tab ${t}`).toBe(false);
      seen.add(t);
    }
  }
}

describe("emptyWorkspace", () => {
  it("is a single focused, tabless leaf", () => {
    const ws = emptyWorkspace("root");
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(ws.focusedPaneId).toBe("root");
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeNote(ws)).toBeNull();
  });
});

describe("open behaviors", () => {
  it("openInNewTab appends and activates", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    expect(focusedLeaf(ws).tabs).toEqual(["a", "b"]);
    expect(activeNote(ws)).toBe("b");
  });

  it("openInFocusedTab reuses the active slot in place", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b"); // tabs: [a, b], active b
    ws = openInFocusedTab(ws, "c"); // reuse active slot (b → c)
    expect(focusedLeaf(ws).tabs).toEqual(["a", "c"]);
    expect(activeNote(ws)).toBe("c");
  });

  it("openInFocusedTab seeds the first tab when the pane is empty", () => {
    let ws = emptyWorkspace("root");
    ws = openInFocusedTab(ws, "a");
    expect(focusedLeaf(ws).tabs).toEqual(["a"]);
    expect(activeNote(ws)).toBe("a");
  });
});

describe("global duplicate-forbid → reveal", () => {
  it("openInNewTab on an already-open note reveals instead of duplicating", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    ws = setActiveTab(ws, ws.focusedPaneId, "a"); // active a, but b still open
    ws = openInNewTab(ws, "b"); // already open → reveal
    expect(focusedLeaf(ws).tabs).toEqual(["a", "b"]); // no third tab
    expect(activeNote(ws)).toBe("b");
    assertNoDuplicates(ws);
  });

  it("reveal works across panes (open-to-side then re-open focuses the other pane)", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a"); // pane root: [a]
    ws = openToSide(ws, "b", id); // new pane p1: [b], focused
    expect(collectLeaves(ws.root)).toHaveLength(2);
    const sidePane = ws.focusedPaneId;
    ws = setFocusedPane(ws, "root"); // focus back to the original pane
    ws = openInNewTab(ws, "b"); // b already open in the side pane → reveal it
    expect(ws.focusedPaneId).toBe(sidePane);
    expect(activeNote(ws)).toBe("b");
    expect(collectLeaves(ws.root)).toHaveLength(2); // no new pane
    assertNoDuplicates(ws);
  });

  it("openToSide on an already-open note reveals, never creating a pane", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openToSide(ws, "a", id); // a already open here → reveal, no split
    expect(collectLeaves(ws.root)).toHaveLength(1);
    assertNoDuplicates(ws);
  });
});

describe("split panes", () => {
  it("openToSide creates a second pane and focuses it", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openToSide(ws, "b", id);
    const leaves = collectLeaves(ws.root);
    expect(leaves).toHaveLength(2);
    expect(ws.root.kind).toBe("split");
    expect(focusedLeaf(ws).tabs).toEqual(["b"]);
    expect(findNotePane(ws, "a")).not.toBe(ws.focusedPaneId);
  });

  it("splitPane makes a fresh empty focused leaf", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = splitPane(ws, "root", "row", id);
    expect(collectLeaves(ws.root)).toHaveLength(2);
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeNote(ws)).toBeNull();
  });

  it("same-direction split inserts a sibling rather than nesting", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
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
    ws = openInNewTab(ws, "a");
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
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    ws = openInNewTab(ws, "c");
    ws = setActiveTab(ws, "root", "b");
    ws = closeTab(ws, "root", "b");
    expect(focusedLeaf(ws).tabs).toEqual(["a", "c"]);
    expect(activeNote(ws)).toBe("c"); // right neighbor
  });

  it("falls back to the left neighbor when closing the last tab", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    ws = setActiveTab(ws, "root", "b"); // active is last
    ws = closeTab(ws, "root", "b");
    expect(activeNote(ws)).toBe("a"); // left neighbor
  });

  it("emptying the ONLY pane keeps it tabless (empty-editor-shell)", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = closeTab(ws, "root", "a");
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(focusedLeaf(ws).tabs).toEqual([]);
    expect(activeNote(ws)).toBeNull();
  });

  it("emptying a NON-last pane removes it and collapses the split", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a"); // pane root: [a]
    ws = openToSide(ws, "b", id); // pane p1: [b], focused
    ws = closeTab(ws, ws.focusedPaneId, "b"); // empties p1 → removed
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(ws.root.kind).toBe("leaf"); // collapsed back to a single leaf
    expect(findNotePane(ws, "a")).toBe(ws.focusedPaneId); // focus relocated
  });
});

describe("closePane + ≥1-leaf invariant", () => {
  it("closePane on the only leaf is a no-op", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    const before = ws;
    ws = closePane(ws, "root");
    expect(ws).toBe(before); // unchanged reference — true no-op
  });

  it("closePane removes a pane and relocates focus", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openToSide(ws, "b", id); // focus on the new side pane
    const sideId = ws.focusedPaneId;
    ws = closePane(ws, sideId);
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(findLeaf(ws.root, ws.focusedPaneId)).not.toBeNull(); // focus valid
  });
});

describe("setFocusedPane / setActiveTab guards", () => {
  it("setFocusedPane ignores a non-existent pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    const before = ws;
    ws = setFocusedPane(ws, "ghost");
    expect(ws).toBe(before);
  });

  it("setActiveTab ignores a note not in the pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = setActiveTab(ws, "root", "not-open");
    expect(activeNote(ws)).toBe("a");
  });

  it("reveal on a note that isn't open is a no-op", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    const before = ws;
    ws = reveal(ws, "nope");
    expect(ws).toBe(before);
  });
});

describe("moveTab", () => {
  it("reorders within a strip", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    ws = openInNewTab(ws, "c"); // [a,b,c]
    ws = moveTab(ws, "root", "root", "a", 2); // move a to index 2
    expect(focusedLeaf(ws).tabs).toEqual(["b", "c", "a"]);
    expect(activeNote(ws)).toBe("a");
  });

  it("moves a tab to another pane and removes it from the source", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b"); // root: [a,b]
    ws = openToSide(ws, "c", id); // p1: [c]
    const sideId = ws.focusedPaneId;
    ws = moveTab(ws, "root", sideId, "b", 1); // move b → side at end
    expect(findNotePane(ws, "b")).toBe(sideId);
    expect(findLeaf(ws.root, "root")!.tabs).toEqual(["a"]);
    expect(findLeaf(ws.root, sideId)!.tabs).toEqual(["c", "b"]);
    expect(ws.focusedPaneId).toBe(sideId);
  });

  it("dragging the last tab out of a non-last pane closes that pane", () => {
    const id = counter();
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a"); // root: [a]
    ws = openToSide(ws, "b", id); // p1: [b], focused
    const sideId = ws.focusedPaneId;
    ws = moveTab(ws, sideId, "root", "b", 1); // move b back → side empties
    expect(collectLeaves(ws.root)).toHaveLength(1);
    expect(findLeaf(ws.root, "root")!.tabs).toEqual(["a", "b"]);
  });

  it("is a no-op when the note isn't in the source pane", () => {
    let ws = emptyWorkspace("root");
    ws = openInNewTab(ws, "a");
    const before = ws;
    ws = moveTab(ws, "root", "root", "ghost", 0);
    expect(ws).toBe(before);
  });
});

// ── MYND-166 behavioral pass: drag-to-split + drop-as-tab ──────────────

/** A 2-leaf row workspace: leaf "L" holds [a]; a second focused leaf holds
 *  [b]. Returns the second leaf's id. */
function twoPanes(): { ws: WorkspaceState; right: string } {
  const next = counter();
  let ws = emptyWorkspace("L");
  ws = openInNewTab(ws, "a"); // L: [a]
  ws = splitPane(ws, "L", "row", next); // fresh empty leaf, focused
  const right = ws.focusedPaneId;
  ws = openInNewTab(ws, "b"); // right: [b]
  return { ws, right };
}

describe("dropNoteOnPane", () => {
  it("inserts a not-yet-open note into the target pane and focuses it", () => {
    const { ws } = twoPanes();
    const next = dropNoteOnPane(ws, "L", "c", 0);
    const leaf = findLeaf(next.root, "L")!;
    expect(leaf.tabs).toEqual(["c", "a"]);
    expect(leaf.activeTab).toBe("c");
    expect(next.focusedPaneId).toBe("L");
    assertNoDuplicates(next);
  });

  it("moves an already-open note into the target pane (no duplicate)", () => {
    const { ws } = twoPanes();
    const next = dropNoteOnPane(ws, "L", "b", 1); // b lives in the right pane
    expect(findNotePane(next, "b")).toBe("L");
    // The emptied source pane is removed; the tree collapses to L.
    expect(collectLeaves(next.root)).toHaveLength(1);
    expect(findLeaf(next.root, "L")!.tabs).toContain("b");
    assertNoDuplicates(next);
  });

  it("reorders within the same pane", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, "a");
    ws = openInNewTab(ws, "b");
    ws = openInNewTab(ws, "c"); // L: [a, b, c]
    const next = dropNoteOnPane(ws, "L", "c", 0);
    expect(findLeaf(next.root, "L")!.tabs).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when the target pane doesn't exist", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, "a");
    expect(dropNoteOnPane(ws, "nope", "x", 0)).toBe(ws);
  });
});

describe("splitPaneWithNote", () => {
  it("splits row/after — original first, new focused leaf (with the note) second", () => {
    const next = counter();
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, "a"); // L: [a]
    const out = splitPaneWithNote(ws, "L", "row", "after", "b", next);
    expect(out.root.kind).toBe("split");
    expect(collectLeaves(out.root)).toHaveLength(2);
    expect(findLeaf(out.root, "L")!.tabs).toEqual(["a"]);
    expect(findLeaf(out.root, out.focusedPaneId)!.tabs).toEqual(["b"]);
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
    ws = openInNewTab(ws, "a");
    const out = splitPaneWithNote(ws, "L", "row", "before", "b", next);
    if (out.root.kind === "split") {
      expect(out.root.children[0]!.id).toBe(out.focusedPaneId);
      expect(out.root.children[1]).toMatchObject({ id: "L" });
    }
  });

  it("moves an already-open note out of its pane when splitting another", () => {
    const { ws, right } = twoPanes(); // L:[a], right:[b]
    const next = counter();
    next(); // burn p1/p2 already used by twoPanes to avoid id reuse
    next();
    const out = splitPaneWithNote(ws, "L", "column", "after", "b", next);
    // b moved into the new focused leaf; its old pane is gone (it emptied).
    expect(findNotePane(out, "b")).toBe(out.focusedPaneId);
    expect(findLeaf(out.root, right)?.tabs ?? []).not.toContain("b");
    assertNoDuplicates(out);
  });

  it("is a no-op when the note is the target pane's only tab", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, "a"); // a is L's sole tab
    expect(splitPaneWithNote(ws, "L", "row", "after", "a", counter())).toBe(ws);
  });

  it("is a no-op when the target pane doesn't exist", () => {
    let ws = emptyWorkspace("L");
    ws = openInNewTab(ws, "a");
    expect(
      splitPaneWithNote(ws, "nope", "row", "after", "x", counter()),
    ).toBe(ws);
  });
});
