// @vitest-environment jsdom
//
// `useFilterCount` (Saved Views #4, MYND-282) — the filter builder's live "N
// notes" count. Mocks `useRunViewContext` / `useIndexNonce` and a captured
// `evaluateFilter` to pin this hook's own logic: null while the first eval is in
// flight, the resolved match count, re-evaluation on a filter change, and the
// error → null fallback (a locked vault / index hiccup never throws to the UI).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { FilterNode } from "../../src/lib/prefs";

const evaluateFilterMock = vi.fn();
const liveIds = new Set(["a", "b", "c"]);
const resolvers = {};

vi.mock("../../src/notes/indexNonce", () => ({ useIndexNonce: () => 0 }));
vi.mock("../../src/notes/views/useRunViewContext", () => ({
  useRunViewContext: () => ({ liveIds, resolvers }),
}));
vi.mock("../../src/notes/queryEngine", () => ({
  evaluateFilter: (...a: unknown[]) => evaluateFilterMock(...a),
}));

import { useFilterCount } from "../../src/notes/views/useFilterCount";

beforeEach(() => {
  evaluateFilterMock.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("useFilterCount", () => {
  it("starts null while the first evaluation is in flight", () => {
    let resolve!: (ids: string[]) => void;
    evaluateFilterMock.mockReturnValue(new Promise<string[]>((r) => (resolve = r)));
    const { result } = renderHook(() => useFilterCount({ kind: "all" }));
    expect(result.current).toBeNull();
    resolve(["a"]); // settle so the effect's pending promise doesn't leak
  });

  it("resolves to the number of matched ids", async () => {
    evaluateFilterMock.mockResolvedValue(["a", "b"]);
    const { result } = renderHook(() => useFilterCount({ kind: "all" }));
    await waitFor(() => expect(result.current).toBe(2));
    expect(evaluateFilterMock).toHaveBeenCalledWith({ kind: "all" }, liveIds, resolvers);
  });

  it("re-evaluates when the filter changes", async () => {
    // Stable per-phase resolutions (React 19 strict mode double-fires the effect,
    // so `...Once` would be exhausted by the first mount).
    evaluateFilterMock.mockResolvedValue(["a", "b", "c"]);
    const f1: FilterNode = { kind: "all" };
    const f2: FilterNode = { kind: "hasTag", tag: "x" };
    const { result, rerender } = renderHook(({ f }) => useFilterCount(f), {
      initialProps: { f: f1 },
    });
    await waitFor(() => expect(result.current).toBe(3));

    evaluateFilterMock.mockResolvedValue(["a"]);
    rerender({ f: f2 });
    await waitFor(() => expect(result.current).toBe(1));
    expect(evaluateFilterMock).toHaveBeenLastCalledWith(f2, liveIds, resolvers);
  });

  it("falls back to null when evaluation rejects (locked vault / index hiccup)", async () => {
    // Seed a non-null count first, then a rejecting re-eval must reset to null.
    evaluateFilterMock.mockResolvedValue(["a", "b"]);
    const { result, rerender } = renderHook(({ f }) => useFilterCount(f), {
      initialProps: { f: { kind: "all" } as FilterNode },
    });
    await waitFor(() => expect(result.current).toBe(2));

    evaluateFilterMock.mockRejectedValue(new Error("SlotNotUnlocked"));
    rerender({ f: { kind: "hasTag", tag: "y" } as FilterNode });
    await waitFor(() => expect(result.current).toBeNull());
  });
});
