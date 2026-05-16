// Pure-helper tests for `src/notes/sidebarState.tsx`. The React Context
// provider is exercised at integration time (`Editor.tsx` mount); these
// tests cover the cache transitions, optimistic-UI snapshots, rollback
// paths, and sort comparator without a React renderer.

import { describe, expect, it } from "vitest";
import {
  EMPTY_SIDEBAR_STATE,
  applyCacheUpdate,
  applyOptimisticCreate,
  applyOptimisticDelete,
  applyOptimisticRename,
  rollbackOptimisticCreate,
  rollbackOptimisticDelete,
  rollbackOptimisticRename,
  sortBatchIds,
  type SidebarState,
} from "../../src/notes/sidebarState";

function stateWith(
  entries: Array<[string, string | null, Date | null]>,
  selectedId: string | null = null,
): SidebarState {
  const cache = new Map();
  for (const [id, title, updatedAt] of entries) {
    cache.set(id, { noteUuid: id, title, updatedAt });
  }
  return {
    selectedId,
    renamingId: null,
    cache,
  };
}

describe("EMPTY_SIDEBAR_STATE", () => {
  it("has null selection and an empty Map cache", () => {
    expect(EMPTY_SIDEBAR_STATE.selectedId).toBeNull();
    expect(EMPTY_SIDEBAR_STATE.renamingId).toBeNull();
    expect(EMPTY_SIDEBAR_STATE.cache.size).toBe(0);
  });
});

describe("applyCacheUpdate", () => {
  it("inserts a new cache entry", () => {
    const next = applyCacheUpdate(EMPTY_SIDEBAR_STATE, "id-1", {
      noteUuid: "id-1",
      title: "New",
      updatedAt: null,
    });
    expect(next.cache.size).toBe(1);
    expect(next.cache.get("id-1")?.title).toBe("New");
  });

  it("returns a new Map (immutability invariant for React useState)", () => {
    const before = EMPTY_SIDEBAR_STATE;
    const next = applyCacheUpdate(before, "id-1", {
      noteUuid: "id-1",
      title: "T",
      updatedAt: null,
    });
    expect(next).not.toBe(before);
    expect(next.cache).not.toBe(before.cache);
  });

  it("overwrites an existing entry", () => {
    const before = stateWith([["id-1", "Old", null]]);
    const next = applyCacheUpdate(before, "id-1", {
      noteUuid: "id-1",
      title: "Updated",
      updatedAt: new Date("2026-05-10T00:00:00Z"),
    });
    expect(next.cache.get("id-1")?.title).toBe("Updated");
    expect(next.cache.get("id-1")?.updatedAt?.toISOString()).toBe(
      "2026-05-10T00:00:00.000Z",
    );
  });
});

describe("applyOptimisticCreate + rollback", () => {
  it("appends a row with null title (Untitled placeholder)", () => {
    const next = applyOptimisticCreate(EMPTY_SIDEBAR_STATE, "new-id");
    const rec = next.cache.get("new-id");
    expect(rec?.title).toBeNull();
    expect(rec?.updatedAt).toBeNull();
  });

  it("rollback drops the row", () => {
    const seeded = applyOptimisticCreate(EMPTY_SIDEBAR_STATE, "new-id");
    const rolled = rollbackOptimisticCreate(seeded, "new-id");
    expect(rolled.cache.has("new-id")).toBe(false);
  });

  it("rollback is a no-op if the row is no longer in cache", () => {
    const rolled = rollbackOptimisticCreate(EMPTY_SIDEBAR_STATE, "ghost");
    expect(rolled).toBe(EMPTY_SIDEBAR_STATE);
  });
});

describe("applyOptimisticDelete + rollback", () => {
  it("removes the row and captures the snapshot", () => {
    const before = stateWith([["id-1", "Doomed", null]]);
    const { next, snapshot } = applyOptimisticDelete(before, "id-1");
    expect(next.cache.has("id-1")).toBe(false);
    expect(snapshot.record?.title).toBe("Doomed");
    expect(snapshot.wasSelected).toBe(false);
  });

  it("captures wasSelected when deleting the active note", () => {
    const before = stateWith([["id-1", "T", null]], "id-1");
    const { next, snapshot } = applyOptimisticDelete(before, "id-1");
    expect(snapshot.wasSelected).toBe(true);
    expect(next.selectedId).toBeNull();
  });

  it("rollback restores the row and selection state", () => {
    const before = stateWith([["id-1", "T", null]], "id-1");
    const { next, snapshot } = applyOptimisticDelete(before, "id-1");
    const restored = rollbackOptimisticDelete(next, "id-1", snapshot);
    expect(restored.cache.get("id-1")?.title).toBe("T");
    expect(restored.selectedId).toBe("id-1");
  });

  it("clearing renamingId on delete prevents stale inline-rename state", () => {
    const before: SidebarState = {
      ...stateWith([["id-1", "T", null]]),
      renamingId: "id-1",
    };
    const { next } = applyOptimisticDelete(before, "id-1");
    expect(next.renamingId).toBeNull();
  });
});

describe("applyOptimisticRename + rollback", () => {
  it("overwrites the title field and captures the previous value", () => {
    const before = stateWith([["id-1", "Old", null]]);
    const { next, snapshot } = applyOptimisticRename(before, "id-1", "New");
    expect(next.cache.get("id-1")?.title).toBe("New");
    expect(snapshot.prevTitle).toBe("Old");
  });

  it("captures null prevTitle when renaming an Untitled row", () => {
    const before = stateWith([["id-1", null, null]]);
    const { snapshot } = applyOptimisticRename(before, "id-1", "First Title");
    expect(snapshot.prevTitle).toBeNull();
  });

  it("is a no-op when the cache entry doesn't exist", () => {
    const { next, snapshot } = applyOptimisticRename(
      EMPTY_SIDEBAR_STATE,
      "ghost",
      "X",
    );
    expect(next).toBe(EMPTY_SIDEBAR_STATE);
    expect(snapshot.prevTitle).toBeNull();
  });

  it("rollback restores the previous title", () => {
    const before = stateWith([["id-1", "Old", null]]);
    const { next, snapshot } = applyOptimisticRename(before, "id-1", "New");
    const restored = rollbackOptimisticRename(next, "id-1", snapshot);
    expect(restored.cache.get("id-1")?.title).toBe("Old");
  });

  it("rollback is a no-op when the row was deleted concurrently", () => {
    const before = stateWith([["id-1", "Old", null]]);
    const { snapshot } = applyOptimisticRename(before, "id-1", "New");
    // Delete the row.
    const deleted = applyOptimisticDelete(before, "id-1").next;
    const restored = rollbackOptimisticRename(deleted, "id-1", snapshot);
    expect(restored.cache.has("id-1")).toBe(false);
  });
});

describe("sortBatchIds", () => {
  it("sorts by updatedAt desc when both records have it", () => {
    const cache = new Map();
    cache.set("a", {
      noteUuid: "a",
      title: "A",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    cache.set("b", {
      noteUuid: "b",
      title: "B",
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(sortBatchIds(["a", "b"], cache)).toEqual(["b", "a"]);
  });

  it("falls back to UUIDv7-derived timestamp when updatedAt is missing", () => {
    // Construct two UUIDv7s with embedded timestamps in the first 48 bits.
    // UUIDv7 layout: 48-bit unix-ms, 4-bit version (7), ..., 4-bit variant (8/9/a/b).
    // We just need parseable hex; the version/variant nibbles don't affect the
    // first-48-bit timestamp decode used by sortBatchIds.
    const olderHex = "018a00000000"; // 1,690,156,800,000ms ≈ 2023-07
    const newerHex = "0190000000ff"; // 1,720,000,000,000ms+ish ≈ 2024-07
    const older = `${olderHex.slice(0, 8)}-${olderHex.slice(8, 12)}-7000-8000-000000000000`;
    const newer = `${newerHex.slice(0, 8)}-${newerHex.slice(8, 12)}-7000-8000-000000000000`;
    const cache = new Map();
    cache.set(older, { noteUuid: older, title: "O", updatedAt: null });
    cache.set(newer, { noteUuid: newer, title: "N", updatedAt: null });
    const sorted = sortBatchIds([older, newer], cache);
    expect(sorted[0]).toBe(newer);
    expect(sorted[1]).toBe(older);
  });

  it("preserves stable order for equal timestamps via Array.sort behavior", () => {
    const cache = new Map();
    const sameDate = new Date("2026-05-10T00:00:00Z");
    cache.set("a", { noteUuid: "a", title: "A", updatedAt: sameDate });
    cache.set("b", { noteUuid: "b", title: "B", updatedAt: sameDate });
    cache.set("c", { noteUuid: "c", title: "C", updatedAt: sameDate });
    const sorted = sortBatchIds(["a", "b", "c"], cache);
    // Node's V8 sort is stable; equal keys → input order preserved.
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("missing cache entries fall back to UUIDv7 derivation", () => {
    const cache = new Map(); // empty
    const ids = [
      "01000000-0000-7000-8000-000000000000",
      "02000000-0000-7000-8000-000000000000",
    ];
    const sorted = sortBatchIds(ids, cache);
    // 0x02... > 0x01... in the first 48 bits → "02..." first.
    expect(sorted[0]?.startsWith("02")).toBe(true);
  });
});
