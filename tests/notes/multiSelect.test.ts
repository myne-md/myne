// Pure-helper tests for the multi-selection set transitions in
// `src/notes/sidebarState.tsx` (MYND-367 — multi-select notes + bulk ops).
// These cover toggle / range / replace / clear without a React renderer; the
// load-bearing invariant is that NONE of them ever mutate `selectedId` (which
// drives Editor.tsx's open-bridge — see `SidebarState.selectedIds`).

import { describe, expect, it } from "vitest";
import {
  clearMultiSelection,
  replaceSelection,
  selectRange,
  toggleInSelection,
  type SidebarState,
} from "../../src/notes/sidebarState";

function stateWith(
  over: Partial<SidebarState> = {},
): SidebarState {
  return {
    selectedId: null,
    selectedIds: new Set(),
    anchorId: null,
    renamingId: null,
    // Required since myne#654 put the newest create at the top of its
    // container. A fixture that omits it is not a smaller state, it is a state
    // the reducer cannot be handed.
    justCreatedId: null,
    cache: new Map(),
    contentReloadNonce: 0,
    ...over,
  };
}

const ORDER = ["a", "b", "c", "d", "e"];

describe("toggleInSelection", () => {
  it("adds an absent id and sets the anchor", () => {
    const next = toggleInSelection(stateWith(), "b");
    expect([...next.selectedIds]).toEqual(["b"]);
    expect(next.anchorId).toBe("b");
  });

  it("removes a present id (still updates the anchor to it)", () => {
    const start = stateWith({ selectedIds: new Set(["a", "b"]), anchorId: "a" });
    const next = toggleInSelection(start, "b");
    expect([...next.selectedIds]).toEqual(["a"]);
    expect(next.anchorId).toBe("b");
  });

  it("returns a fresh Set (does not mutate the input)", () => {
    const start = stateWith({ selectedIds: new Set(["a"]) });
    const next = toggleInSelection(start, "b");
    expect(next.selectedIds).not.toBe(start.selectedIds);
    expect([...start.selectedIds]).toEqual(["a"]); // input untouched
  });

  it("never touches selectedId", () => {
    const next = toggleInSelection(stateWith({ selectedId: "z" }), "b");
    expect(next.selectedId).toBe("z");
  });
});

describe("selectRange", () => {
  it("ranges forward from the anchor, inclusive", () => {
    const start = stateWith({ anchorId: "b" });
    const next = selectRange(start, ORDER, "d");
    expect([...next.selectedIds]).toEqual(["b", "c", "d"]);
  });

  it("ranges backward (target before anchor)", () => {
    const start = stateWith({ anchorId: "d" });
    const next = selectRange(start, ORDER, "b");
    expect([...next.selectedIds]).toEqual(["b", "c", "d"]);
  });

  it("falls back to selectedId as the anchor when no anchorId", () => {
    const start = stateWith({ selectedId: "a" });
    const next = selectRange(start, ORDER, "c");
    expect([...next.selectedIds]).toEqual(["a", "b", "c"]);
  });

  it("falls back to a single-target selection when no anchor at all", () => {
    const next = selectRange(stateWith(), ORDER, "c");
    expect([...next.selectedIds]).toEqual(["c"]);
  });

  it("single-element range when anchor === target", () => {
    const start = stateWith({ anchorId: "c" });
    const next = selectRange(start, ORDER, "c");
    expect([...next.selectedIds]).toEqual(["c"]);
  });

  it("leaves the anchor in place for successive shift-clicks", () => {
    const start = stateWith({ anchorId: "b" });
    const next = selectRange(start, ORDER, "d");
    expect(next.anchorId).toBe("b");
    const again = selectRange(next, ORDER, "a");
    expect([...again.selectedIds]).toEqual(["a", "b"]);
  });

  it("returns the state unchanged when the target is unknown", () => {
    const start = stateWith({ anchorId: "b" });
    const next = selectRange(start, ORDER, "zzz");
    expect(next).toBe(start);
  });

  it("never touches selectedId", () => {
    const start = stateWith({ selectedId: "a", anchorId: "b" });
    const next = selectRange(start, ORDER, "d");
    expect(next.selectedId).toBe("a");
  });
});

describe("replaceSelection", () => {
  it("replaces the set and anchors on the last id", () => {
    const next = replaceSelection(stateWith({ selectedIds: new Set(["x"]) }), [
      "a",
      "b",
      "c",
    ]);
    expect([...next.selectedIds]).toEqual(["a", "b", "c"]);
    expect(next.anchorId).toBe("c");
  });

  it("empty input clears the anchor", () => {
    const next = replaceSelection(stateWith({ anchorId: "z" }), []);
    expect(next.selectedIds.size).toBe(0);
    expect(next.anchorId).toBeNull();
  });

  it("never touches selectedId", () => {
    const next = replaceSelection(stateWith({ selectedId: "keep" }), ["a"]);
    expect(next.selectedId).toBe("keep");
  });
});

describe("clearMultiSelection", () => {
  it("empties the set and anchor", () => {
    const start = stateWith({ selectedIds: new Set(["a", "b"]), anchorId: "a" });
    const next = clearMultiSelection(start);
    expect(next.selectedIds.size).toBe(0);
    expect(next.anchorId).toBeNull();
  });

  it("is a no-op (same reference) when already empty", () => {
    const start = stateWith();
    expect(clearMultiSelection(start)).toBe(start);
  });

  it("never touches selectedId", () => {
    const start = stateWith({ selectedId: "open", selectedIds: new Set(["a"]) });
    const next = clearMultiSelection(start);
    expect(next.selectedId).toBe("open");
  });
});
