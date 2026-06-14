// Unit tests for the pure per-pane navigation-history model (MYND-260).
// No React, no IPC — drives recordVisit, the back/forward cursor predicates,
// and the reconcileHistories fold (fresh visit vs. intent-driven cursor move,
// null-activeTab untouched, dead-pane pruning, forward-tail truncation).

import { describe, expect, it } from "vitest";
import {
  EMPTY_HISTORY,
  canStepBack,
  canStepForward,
  reconcileHistories,
  recordVisit,
  type NavIntent,
  type PaneHistory,
} from "../../src/notes/paneHistory";
import type { LeafPane, PaneId } from "../../src/notes/workspaceState";
import type { NoteId } from "../../src/notes/sidebarState";

/** Minimal leaf for the fold (tabs are irrelevant — only `activeTab` is read). */
function leaf(id: PaneId, activeTab: NoteId | null): LeafPane {
  return { kind: "leaf", id, tabs: activeTab === null ? [] : [activeTab], activeTab };
}

/** Walk a fresh single-pane history through a list of activeTab values. */
function foldVisits(paneId: PaneId, visits: (NoteId | null)[]): PaneHistory {
  let map: ReadonlyMap<PaneId, PaneHistory> = new Map();
  for (const v of visits) {
    map = reconcileHistories(map, [leaf(paneId, v)], null);
  }
  return map.get(paneId) ?? EMPTY_HISTORY;
}

describe("recordVisit", () => {
  it("appends a fresh note and advances the cursor", () => {
    const h = recordVisit(recordVisit(EMPTY_HISTORY, "A"), "B");
    expect(h).toEqual({ entries: ["A", "B"], index: 1 });
  });

  it("re-asserting the current note is a no-op (same reference)", () => {
    const h = recordVisit(EMPTY_HISTORY, "A");
    expect(recordVisit(h, "A")).toBe(h);
  });

  it("visiting after a back-step truncates the forward tail", () => {
    // [A,B,C] cursor at A (index 0) → visit D drops B,C.
    const base: PaneHistory = { entries: ["A", "B", "C"], index: 0 };
    expect(recordVisit(base, "D")).toEqual({ entries: ["A", "D"], index: 1 });
  });
});

describe("canStepBack / canStepForward", () => {
  it("are both false for empty / undefined history", () => {
    expect(canStepBack(undefined)).toBe(false);
    expect(canStepForward(undefined)).toBe(false);
    expect(canStepBack(EMPTY_HISTORY)).toBe(false);
    expect(canStepForward(EMPTY_HISTORY)).toBe(false);
  });

  it("track the cursor position within the entries", () => {
    const h: PaneHistory = { entries: ["A", "B", "C"], index: 1 };
    expect(canStepBack(h)).toBe(true);
    expect(canStepForward(h)).toBe(true);
    expect(canStepBack({ entries: ["A", "B"], index: 0 })).toBe(false);
    expect(canStepForward({ entries: ["A", "B"], index: 1 })).toBe(false);
  });
});

describe("reconcileHistories — fresh visits", () => {
  it("records the sequence of active notes in one pane", () => {
    expect(foldVisits("p1", ["A", "B", "C"])).toEqual({
      entries: ["A", "B", "C"],
      index: 2,
    });
  });

  it("leaves history untouched when activeTab is null (chooser / empty)", () => {
    // A, then a new-tab chooser (null), then B — the null does not record.
    expect(foldVisits("p1", ["A", null, "B"])).toEqual({
      entries: ["A", "B"],
      index: 1,
    });
  });

  it("does not grow when the same note re-asserts (focus toggles etc.)", () => {
    const before = new Map([["p1", { entries: ["A"], index: 0 }]]);
    const after = reconcileHistories(before, [leaf("p1", "A")], null);
    expect(after).toBe(before); // unchanged reference → no re-render
  });

  it("tracks independent per-pane histories", () => {
    let map: ReadonlyMap<PaneId, PaneHistory> = new Map();
    map = reconcileHistories(map, [leaf("p1", "A"), leaf("p2", "X")], null);
    map = reconcileHistories(map, [leaf("p1", "B"), leaf("p2", "X")], null);
    expect(map.get("p1")).toEqual({ entries: ["A", "B"], index: 1 });
    expect(map.get("p2")).toEqual({ entries: ["X"], index: 0 });
  });
});

describe("reconcileHistories — intent-driven cursor moves", () => {
  it("a matching intent moves the cursor instead of recording a visit", () => {
    // p1 history [A,B], cursor at B (index 1). A back step re-activates A and
    // declares intent targetIndex 0 → cursor moves to 0, no new entry.
    const before = new Map([["p1", { entries: ["A", "B"], index: 1 }]]);
    const intent: NavIntent = { paneId: "p1", targetIndex: 0 };
    const after = reconcileHistories(before, [leaf("p1", "A")], intent);
    expect(after.get("p1")).toEqual({ entries: ["A", "B"], index: 0 });
  });

  it("forward then a fresh visit truncates the tail (browser semantics)", () => {
    // [A,B,C] at C → back to B → back to A → visit D ⇒ [A,D].
    let map: ReadonlyMap<PaneId, PaneHistory> = new Map();
    map = reconcileHistories(map, [leaf("p1", "A")], null);
    map = reconcileHistories(map, [leaf("p1", "B")], null);
    map = reconcileHistories(map, [leaf("p1", "C")], null);
    map = reconcileHistories(map, [leaf("p1", "B")], { paneId: "p1", targetIndex: 1 });
    map = reconcileHistories(map, [leaf("p1", "A")], { paneId: "p1", targetIndex: 0 });
    expect(map.get("p1")).toEqual({ entries: ["A", "B", "C"], index: 0 });

    map = reconcileHistories(map, [leaf("p1", "D")], null);
    expect(map.get("p1")).toEqual({ entries: ["A", "D"], index: 1 });
  });

  it("ignores a stale intent whose target note no longer matches", () => {
    // Intent claims index 5 (out of range) → falls back to a fresh visit.
    const before = new Map([["p1", { entries: ["A"], index: 0 }]]);
    const after = reconcileHistories(
      before,
      [leaf("p1", "B")],
      { paneId: "p1", targetIndex: 5 },
    );
    expect(after.get("p1")).toEqual({ entries: ["A", "B"], index: 1 });
  });
});

describe("reconcileHistories — pruning", () => {
  it("drops the history of a pane that no longer exists", () => {
    const before = new Map([
      ["p1", { entries: ["A"], index: 0 }],
      ["p2", { entries: ["X"], index: 0 }],
    ]);
    const after = reconcileHistories(before, [leaf("p1", "A")], null);
    expect(after.has("p2")).toBe(false);
    expect(after.get("p1")).toEqual({ entries: ["A"], index: 0 });
  });
});
