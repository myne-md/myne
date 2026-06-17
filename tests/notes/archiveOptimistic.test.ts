// Pure-helper tests for the archive optimistic state transitions (MYND-331).
// The provider orchestration (archiveWithRollback / unarchiveWithRollback /
// bulkArchiveWithSync) is exercised at integration time; these cover the
// testable pure pieces — including the archive ⊥ trash optimistic clear.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SIDEBAR_STATE,
  applyCacheUpdate,
  applyOptimisticArchivedFlag,
  rollbackOptimisticArchivedFlag,
  liveCache,
  type SidebarState,
  type TitleRecord,
} from "../../src/notes/sidebarState";

function seed(
  id: string,
  archived: string | null,
  trashed: string | null = null,
): SidebarState {
  const rec: TitleRecord = {
    noteUuid: id,
    title: "Note",
    folder: null,
    updatedAt: null,
    trashed,
    archived,
    template: false,
    folderIndex: false,
  };
  return applyCacheUpdate(EMPTY_SIDEBAR_STATE, id, rec);
}

const A = "2026-06-17T09:30:00Z";
const T = "2026-06-03T11:00:00Z";

describe("applyOptimisticArchivedFlag — archive", () => {
  it("sets archived so the row leaves the live view; snapshot captures prev", () => {
    const { next, snapshot } = applyOptimisticArchivedFlag(seed("a", null), "a", A);
    expect(next.cache.get("a")?.archived).toBe(A);
    expect(liveCache(next.cache).has("a")).toBe(false);
    expect(snapshot).toEqual({ prevArchived: null, prevTrashed: null });
  });

  it("clears trashed when archiving a trashed note (archive ⊥ trash)", () => {
    const { next, snapshot } = applyOptimisticArchivedFlag(seed("a", null, T), "a", A);
    expect(next.cache.get("a")?.archived).toBe(A);
    expect(next.cache.get("a")?.trashed).toBeNull();
    expect(snapshot).toEqual({ prevArchived: null, prevTrashed: T });
  });

  it("is a no-op when the entry is not cached", () => {
    const { next, snapshot } = applyOptimisticArchivedFlag(EMPTY_SIDEBAR_STATE, "x", A);
    expect(next).toBe(EMPTY_SIDEBAR_STATE);
    expect(snapshot).toEqual({ prevArchived: null, prevTrashed: null });
  });
});

describe("applyOptimisticArchivedFlag — unarchive", () => {
  it("clears archived so the row re-enters the live view", () => {
    const { next } = applyOptimisticArchivedFlag(seed("a", A), "a", null);
    expect(next.cache.get("a")?.archived).toBeNull();
    expect(liveCache(next.cache).has("a")).toBe(true);
  });
});

describe("rollbackOptimisticArchivedFlag", () => {
  it("restores both prior markers after a failed archive of a trashed note", () => {
    const start = seed("a", null, T);
    const { next, snapshot } = applyOptimisticArchivedFlag(start, "a", A);
    const rolled = rollbackOptimisticArchivedFlag(next, "a", snapshot);
    expect(rolled.cache.get("a")?.archived).toBeNull();
    expect(rolled.cache.get("a")?.trashed).toBe(T);
  });
});
