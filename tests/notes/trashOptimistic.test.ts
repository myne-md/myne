// Pure-helper tests for the soft-trash optimistic state transitions
// (MYND-133). The provider orchestration (trashWithRollback /
// restoreWithRollback / emptyTrashWithSync) is exercised at integration time;
// these cover the testable pure pieces. (Relative-age display reuses the
// shared `formatRelativeTime`, covered by its own tests.)

import { describe, expect, it } from "vitest";
import {
  EMPTY_SIDEBAR_STATE,
  applyCacheUpdate,
  applyOptimisticTrashedFlag,
  rollbackOptimisticTrashedFlag,
  type SidebarState,
} from "../../src/notes/sidebarState";

function seed(id: string, trashed: string | null): SidebarState {
  return applyCacheUpdate(EMPTY_SIDEBAR_STATE, id, {
    noteUuid: id,
    title: "Note",
    folder: null,
    updatedAt: null,
    trashed,
  });
}

const TS = "2026-06-03T11:00:00Z";

describe("applyOptimisticTrashedFlag — trash", () => {
  it("sets the marker so the row leaves the live view; snapshot captures prev", () => {
    const { next, snapshot } = applyOptimisticTrashedFlag(seed("a", null), "a", TS);
    expect(next.cache.get("a")?.trashed).toBe(TS);
    expect(snapshot).toEqual({ prev: null });
  });

  it("clears the marker on restore (value = null)", () => {
    const { next, snapshot } = applyOptimisticTrashedFlag(seed("a", TS), "a", null);
    expect(next.cache.get("a")?.trashed).toBeNull();
    expect(snapshot).toEqual({ prev: TS });
  });

  it("is a no-op for an uncached id", () => {
    const { next, snapshot } = applyOptimisticTrashedFlag(EMPTY_SIDEBAR_STATE, "x", TS);
    expect(next).toBe(EMPTY_SIDEBAR_STATE);
    expect(snapshot).toEqual({ prev: null });
  });
});

describe("rollbackOptimisticTrashedFlag", () => {
  it("restores the previous marker after a failed trash", () => {
    const { snapshot } = applyOptimisticTrashedFlag(seed("a", null), "a", TS);
    const optimistic = seed("a", TS);
    const rolled = rollbackOptimisticTrashedFlag(optimistic, "a", snapshot);
    expect(rolled.cache.get("a")?.trashed).toBeNull();
  });

  it("is a no-op when the cache entry has vanished", () => {
    const rolled = rollbackOptimisticTrashedFlag(EMPTY_SIDEBAR_STATE, "gone", {
      prev: TS,
    });
    expect(rolled).toBe(EMPTY_SIDEBAR_STATE);
  });
});
