// Tests for the bottom-bar reorder helpers (MYND bottom-bar customization).

import { describe, expect, it } from "vitest";
import {
  RIGHT_CLUSTER_DEFAULT_ORDER,
  resolveBarOrder,
  reorderByDrop,
  canMoveBarItem,
  moveBarItem,
} from "../../src/notes/barItemsOrder";

describe("resolveBarOrder", () => {
  it("returns the canonical default for an empty stored order", () => {
    expect(resolveBarOrder([])).toEqual([...RIGHT_CLUSTER_DEFAULT_ORDER]);
  });

  it("honours the stored order, appending omitted canonical ids", () => {
    // Stored puts graph + lock first; the rest follow in canonical order.
    const out = resolveBarOrder(["graph", "lock"]);
    expect(out.slice(0, 2)).toEqual(["graph", "lock"]);
    // Every canonical id appears exactly once (a permutation).
    expect([...out].sort()).toEqual([...RIGHT_CLUSTER_DEFAULT_ORDER].sort());
  });

  it("drops unknown + duplicate stored ids", () => {
    const out = resolveBarOrder(["graph", "ghost", "graph", "tags"]);
    expect(out.slice(0, 2)).toEqual(["graph", "tags"]);
    expect(out).not.toContain("ghost");
    expect([...out].sort()).toEqual([...RIGHT_CLUSTER_DEFAULT_ORDER].sort());
  });
});

describe("reorderByDrop", () => {
  it("moves an item before a target", () => {
    expect(reorderByDrop(["a", "b", "c", "d"], "d", "b", "before")).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("moves an item after a target", () => {
    expect(reorderByDrop(["a", "b", "c", "d"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("is a no-op when dragged === target", () => {
    expect(reorderByDrop(["a", "b", "c"], "b", "b", "before")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op for an absent target", () => {
    expect(reorderByDrop(["a", "b"], "a", "ghost", "after")).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("canMoveBarItem", () => {
  it("is false at the visible boundaries", () => {
    expect(canMoveBarItem(["a", "b", "c"], "a", -1)).toBe(false);
    expect(canMoveBarItem(["a", "b", "c"], "c", 1)).toBe(false);
  });

  it("is true in the interior", () => {
    expect(canMoveBarItem(["a", "b", "c"], "b", -1)).toBe(true);
    expect(canMoveBarItem(["a", "b", "c"], "b", 1)).toBe(true);
  });

  it("is false for an item not in the visible set", () => {
    expect(canMoveBarItem(["a", "b"], "ghost", 1)).toBe(false);
  });
});

describe("moveBarItem", () => {
  it("moves a visible item left/right within the full order", () => {
    const order = ["a", "b", "c", "d"];
    const visible = ["a", "b", "c", "d"];
    expect(moveBarItem(order, visible, "c", -1)).toEqual(["a", "c", "b", "d"]);
    expect(moveBarItem(order, visible, "b", 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("skips a hidden neighbour so the visible effect is a real swap", () => {
    // `b` is hidden (not in visible); moving `c` left should land it before
    // `a`'s visible neighbour, hopping over the hidden `b` in the full order.
    const order = ["a", "b", "c"];
    const visible = ["a", "c"];
    expect(moveBarItem(order, visible, "c", -1)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op at the visible boundary", () => {
    const order = ["a", "b", "c"];
    const visible = ["a", "b", "c"];
    expect(moveBarItem(order, visible, "a", -1)).toEqual(["a", "b", "c"]);
  });
});
