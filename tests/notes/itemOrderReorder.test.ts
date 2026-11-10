// Unit tests for the pure `item_order` reorder computation + the dual-write
// orchestration contract (MYND-183; MYND-596 container-keyed reshape). The
// desktop consumers reach these through the `./itemOrderReorder` shim, which
// re-exports the shared `@myne/editor/host/notes/itemOrder` module.

import { describe, it, expect, vi } from "vitest";
import {
  itemOrderKey,
  computeItemOrderAfterReorder,
  reorderSequence,
  applyReorderWrite,
} from "../../src/notes/components/itemOrderReorder";
import { rewriteItemOrderPrefix } from "../../editor/src/host/notes/itemOrder";

describe("itemOrderKey", () => {
  it("folds folder paths and keeps note UUIDs verbatim", () => {
    expect(itemOrderKey("Projects/")).toBe("projects/");
    expect(itemOrderKey("0190-uuid")).toBe("0190-uuid");
  });
});

describe("reorderSequence — pure single-sequence reorder (favorites + one container)", () => {
  it("drops the dragged below its target", () => {
    expect(
      reorderSequence({
        containerChildKeys: ["a", "c"],
        draggedKey: "b",
        targetKey: "a",
        place: "below",
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("drops the dragged above its target", () => {
    expect(
      reorderSequence({
        containerChildKeys: ["a", "b"],
        draggedKey: "c",
        targetKey: "a",
        place: "above",
      }),
    ).toEqual(["c", "a", "b"]);
  });

  it("appends when the target is unlisted (targetIdx -1)", () => {
    expect(
      reorderSequence({
        containerChildKeys: ["a"],
        draggedKey: "b",
        targetKey: "zzz-missing",
        place: "above",
      }),
    ).toEqual(["a", "b"]);
  });

  it("matches folder targets by folded identity", () => {
    expect(
      reorderSequence({
        containerChildKeys: ["Apple/", "n1"],
        draggedKey: "Zebra/",
        targetKey: "apple/", // display-variant target folds to Apple/'s key
        place: "above",
      }),
    ).toEqual(["Zebra/", "Apple/", "n1"]);
  });
});

describe("computeItemOrderAfterReorder — rewrites ONLY the named container", () => {
  it("moves a note below its target within the root container", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["a", "b", "c"] },
      container: "",
      containerChildKeys: ["a", "c"], // root children excl. dragged "b"
      draggedKey: "b",
      targetKey: "a",
      place: "below",
    });
    expect(next).toEqual({ "": ["a", "b", "c"] });
  });

  it("moves a note above its target", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["a", "b", "c"] },
      container: "",
      containerChildKeys: ["a", "b"],
      draggedKey: "c",
      targetKey: "a",
      place: "above",
    });
    expect(next).toEqual({ "": ["c", "a", "b"] });
  });

  it("interleaves a note between folders at root", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["n1", "Apple/", "Zebra/"] },
      container: "",
      containerChildKeys: ["n1", "Apple/", "Zebra/"],
      draggedKey: "n2",
      targetKey: "Apple/",
      place: "below",
    });
    expect(next).toEqual({ "": ["n1", "Apple/", "n2", "Zebra/"] });
  });

  it("reorders a folder relative to a folder by folded identity", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["Apple/", "n1", "Zebra/"] },
      container: "",
      containerChildKeys: ["Apple/", "n1"],
      draggedKey: "Zebra/",
      targetKey: "Apple/",
      place: "above",
    });
    expect(next).toEqual({ "": ["Zebra/", "Apple/", "n1"] });
  });

  it("replaces the container with the folded folder form (no display-variant duplicate)", () => {
    // The container carried the display form 'Projects/'; a reorder that drags
    // the folded 'projects/' rewrites the whole sequence, so the display variant
    // is gone rather than duplicated.
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["Projects/", "n1"] },
      container: "",
      containerChildKeys: ["n1"],
      draggedKey: "projects/",
      targetKey: "n1",
      place: "above",
    });
    expect(next).toEqual({ "": ["projects/", "n1"] });
  });

  it("appends into the container when the target is unlisted (targetIdx -1)", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: { "": ["a"] },
      container: "",
      containerChildKeys: ["a"],
      draggedKey: "b",
      targetKey: "zzz-missing",
      place: "above",
    });
    expect(next).toEqual({ "": ["a", "b"] });
  });

  it("does NOT touch a sibling container's sequence (MYND-596 per-container reorder)", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: {
        "": ["n1", "Projects/"],
        "projects/": ["p1", "p2"], // another container — must pass through verbatim
      },
      container: "",
      containerChildKeys: ["n1", "Projects/"],
      draggedKey: "n2",
      targetKey: "Projects/",
      place: "below",
    });
    // Only "" is rewritten; "projects/" is byte-identical (a concurrent reorder
    // of that container on another device is not clobbered).
    expect(next).toEqual({
      "": ["n1", "Projects/", "n2"],
      "projects/": ["p1", "p2"],
    });
  });

  it("reorders a nested container without disturbing the root", () => {
    const next = computeItemOrderAfterReorder({
      itemOrder: {
        "": ["n1", "Projects/"],
        "projects/": ["p1", "p2", "p3"],
      },
      container: "projects/",
      containerChildKeys: ["p1", "p3"], // projects/ children excl. dragged p2
      draggedKey: "p2",
      targetKey: "p1",
      place: "above",
    });
    expect(next).toEqual({
      "": ["n1", "Projects/"],
      "projects/": ["p2", "p1", "p3"],
    });
  });
});

describe("applyReorderWrite — dual-write contract (generic over order type)", () => {
  it("same-container: optimistic set + persist → positioned", async () => {
    const setOrder = vi.fn();
    const persist = vi.fn().mockResolvedValue(undefined);
    const outcome = await applyReorderWrite<string[]>({
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
    const outcome = await applyReorderWrite<string[]>({
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
    const outcome = await applyReorderWrite<string[]>({
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
    const outcome = await applyReorderWrite<string[]>({
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

  it("is generic over the map order type (item_order container map)", async () => {
    // Proves T can be the whole container-keyed map, not just a flat list.
    const seen: Record<string, string[]>[] = [];
    const setOrder = vi.fn((o: Record<string, string[]>) => seen.push(o));
    const outcome = await applyReorderWrite<Record<string, string[]>>({
      moveFirst: null,
      computeNext: () => ({ "": ["a", "b"] }),
      prevOrder: { "": ["b", "a"] },
      setOrder,
      persist: async () => {},
    });
    expect(outcome).toBe("positioned");
    expect(seen).toEqual([{ "": ["a", "b"] }]);
  });
});

describe("rewriteItemOrderPrefix, a RENAME keeps the manual order", () => {
  // The owner's report (2026-11-08): rearrange a folder, rename it, and its
  // position changes. `item_order` is path-keyed twice over, so a rename has to
  // move the container KEY and every child ENTRY that names the folder.
  it("re-keys the renamed container and every descendant container", () => {
    const order = { "projects/": ["n1", "n2"], "projects/old/": ["n3"], "other/": ["n4"] };
    const { next, changed } = rewriteItemOrderPrefix(order, "Projects/", "Work/");
    expect(changed).toBe(true);
    expect(next).toEqual({
      "work/": ["n1", "n2"],
      "work/old/": ["n3"],
      "other/": ["n4"],
    });
  });

  it("rewrites the parent's child entry, so the row keeps its slot", () => {
    const order = { "": ["n0", "Projects/", "Zeta/"] };
    const { next } = rewriteItemOrderPrefix(order, "Projects/", "Work/");
    expect(next[""]).toEqual(["n0", "Work/", "Zeta/"]);
  });

  it("leaves note UUIDs alone and reports no change for an unrelated path", () => {
    const order = { "": ["0190-uuid", "Zeta/"] };
    const untouched = rewriteItemOrderPrefix(order, "Projects/", "Work/");
    expect(untouched.changed).toBe(false);
    expect(untouched.next).toBe(order);
    const uuids = rewriteItemOrderPrefix({ "projects/": ["0190-uuid"] }, "Projects/", "Work/");
    expect(uuids.next["work/"]).toEqual(["0190-uuid"]);
  });

  it("is a no-op for a case-only rename, which folds to the same identity", () => {
    const order = { "projects/": ["n1"] };
    expect(rewriteItemOrderPrefix(order, "Projects/", "PROJECTS/").changed).toBe(false);
  });
});
