// Left-ribbon resolver tests (myne-md/myne#699, task 3).

import { describe, expect, it } from "vitest";
import { resolveRibbonItems } from "../../src/notes/ribbonItems";
import { RIBBON_DEFAULT_IDS } from "../../src/commands";
import { reorderByDrop, moveBarItem, canMoveBarItem } from "../../src/notes/barItemsOrder";

const ELIGIBLE = ["a", "b", "c", "d"];

describe("resolveRibbonItems", () => {
  it("seeds the curated default when the pref was never configured", () => {
    expect(resolveRibbonItems(null, [...ELIGIBLE, ...RIBBON_DEFAULT_IDS])).toEqual([
      ...RIBBON_DEFAULT_IDS,
    ]);
  });

  it("keeps an emptied rail empty instead of re-seeding the default", () => {
    expect(resolveRibbonItems([], ELIGIBLE)).toEqual([]);
  });

  it("drops ids that are no longer eligible", () => {
    expect(resolveRibbonItems(["a", "gone", "c"], ELIGIBLE)).toEqual(["a", "c"]);
  });

  it("preserves stored order and dedupes", () => {
    expect(resolveRibbonItems(["c", "a", "c", "b"], ELIGIBLE)).toEqual(["c", "a", "b"]);
  });

  it("reorders through the shared barItemsOrder maths", () => {
    const order = ["a", "b", "c", "d"];
    expect(reorderByDrop(order, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(canMoveBarItem(order, "a", -1)).toBe(false);
    // One step toward the front lands d just before its neighbour c.
    expect(moveBarItem(order, order, "d", -1)).toEqual(["a", "b", "d", "c"]);
  });
});
