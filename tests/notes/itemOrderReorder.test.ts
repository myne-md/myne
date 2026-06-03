// Unit tests for the pure unified-`item_order` reorder computation + the
// dual-write orchestration contract (MYND-183 Task 6).

import { describe, it, expect, vi } from "vitest";
import {
  itemOrderKey,
  computeItemOrderAfterReorder,
  applyReorderWrite,
} from "../../src/notes/components/itemOrderReorder";

describe("itemOrderKey", () => {
  it("folds folder paths and keeps note UUIDs verbatim", () => {
    expect(itemOrderKey("Projects/")).toBe("projects/");
    expect(itemOrderKey("0190-uuid")).toBe("0190-uuid");
  });
});

describe("computeItemOrderAfterReorder — same-container reorder", () => {
  it("moves a note below its target within the container", () => {
    // container children (excl. dragged "b"): ["a","c"]; drop b below a.
    const next = computeItemOrderAfterReorder({
      itemOrder: ["a", "b", "c"],
      containerChildKeys: ["a", "c"],
      draggedKey: "b",
      targetKey: "a",
      place: "below",
    });
    expect(next).toEqual(["a", "b", "c"]);
  });

  it("moves a note above its target", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: ["a", "b", "c"],
      containerChildKeys: ["a", "b"],
      draggedKey: "c",
      targetKey: "a",
      place: "above",
    });
    expect(next).toEqual(["c", "a", "b"]);
  });
});

describe("computeItemOrderAfterReorder — interleave + cross-kind", () => {
  it("interleaves a note between folders at root", () => {
    // root children (excl. dragged note "n2"): ["n1","Apple/","Zebra/"].
    const next = computeItemOrderAfterReorder({
      itemOrder: ["n1", "Apple/", "Zebra/"],
      containerChildKeys: ["n1", "Apple/", "Zebra/"],
      draggedKey: "n2",
      targetKey: "Apple/",
      place: "below",
    });
    expect(next).toEqual(["n1", "Apple/", "n2", "Zebra/"]);
  });

  it("reorders a folder relative to a folder by folded identity", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: ["Apple/", "n1", "Zebra/"],
      containerChildKeys: ["Apple/", "n1"],
      draggedKey: "Zebra/",
      targetKey: "Apple/",
      place: "above",
    });
    expect(next).toEqual(["Zebra/", "Apple/", "n1"]);
  });

  it("collapses display-form folder variants on identity (no duplicate)", () => {
    // Global list carries 'Projects/'; the container references the folded
    // 'projects/' — the old entry is removed, not duplicated.
    const next = computeItemOrderAfterReorder({
      itemOrder: ["Projects/", "n1"],
      containerChildKeys: ["n1"],
      draggedKey: "projects/",
      targetKey: "n1",
      place: "above",
    });
    expect(next).toEqual(["projects/", "n1"]);
  });
});

describe("computeItemOrderAfterReorder — cross-container placement", () => {
  it("appends the dragged note into the target container, stripping its old slot", () => {
    // n2 was elsewhere; now moved to root, dropped below Projects/.
    const next = computeItemOrderAfterReorder({
      itemOrder: ["n1", "Projects/", "n2"],
      containerChildKeys: ["n1", "Projects/"], // root children, excl. n2
      draggedKey: "n2",
      targetKey: "Projects/",
      place: "below",
    });
    expect(next).toEqual(["n1", "Projects/", "n2"]);
  });

  it("appends when the target is unlisted (targetIdx -1)", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: ["a"],
      containerChildKeys: ["a"],
      draggedKey: "b",
      targetKey: "zzz-missing",
      place: "above",
    });
    expect(next).toEqual(["a", "b"]);
  });
});

describe("applyReorderWrite — dual-write contract", () => {
  it("same-container: optimistic set + persist → positioned", async () => {
    const setOrder = vi.fn();
    const persist = vi.fn().mockResolvedValue(undefined);
    const outcome = await applyReorderWrite({
      moveFirst: null,
      computeNext: () => ["a", "b"],
      prevOrder: ["b", "a"],
      setOrder,
      persist,
    });
    expect(outcome).toBe("positioned");
    expect(setOrder).toHaveBeenCalledTimes(1);
    expect(setOrder).toHaveBeenCalledWith(["a", "b"]);
    expect(persist).toHaveBeenCalledWith(["a", "b"]);
  });

  it("cross-container: moveFirst runs before any prefs write", async () => {
    const calls: string[] = [];
    const moveFirst = vi.fn(async () => {
      calls.push("move");
    });
    const setOrder = vi.fn(() => calls.push("setOrder"));
    const persist = vi.fn(async () => {
      calls.push("persist");
    });
    const outcome = await applyReorderWrite({
      moveFirst,
      computeNext: () => ["a", "b"],
      prevOrder: ["a"],
      setOrder,
      persist,
    });
    expect(outcome).toBe("positioned");
    expect(calls).toEqual(["move", "setOrder", "persist"]);
  });

  it("moveFirst failure ABORTS — no optimistic update, no persist", async () => {
    const setOrder = vi.fn();
    const persist = vi.fn();
    const computeNext = vi.fn(() => ["a", "b"]);
    const outcome = await applyReorderWrite({
      moveFirst: async () => {
        throw new Error("moveNote failed");
      },
      computeNext,
      prevOrder: ["a"],
      setOrder,
      persist,
    });
    expect(outcome).toBe("aborted");
    expect(computeNext).not.toHaveBeenCalled();
    expect(setOrder).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("persist failure → moved-recency: order reverts to prev (position is soft)", async () => {
    const seen: string[][] = [];
    const setOrder = vi.fn((o: string[]) => seen.push(o));
    const outcome = await applyReorderWrite({
      moveFirst: async () => {},
      computeNext: () => ["a", "b", "c"],
      prevOrder: ["a", "b"],
      setOrder,
      persist: async () => {
        throw new Error("over cap");
      },
    });
    expect(outcome).toBe("moved-recency");
    // First the optimistic next, then the revert to prev.
    expect(seen).toEqual([
      ["a", "b", "c"],
      ["a", "b"],
    ]);
  });
});
