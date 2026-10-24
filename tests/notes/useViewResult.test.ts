// @vitest-environment jsdom
//
// `useViewResult` (Saved Views #5, MYND-275) — resolves a SavedView def from
// prefs and runs it to grouped rows. Mocks `usePrefs` / `useIndexNonce` /
// `useRunViewContext` (the impure seams) and a captured `runView` so the test
// pins this hook's OWN logic: def resolution by id, the null-def short-circuit,
// the approval gate (view-manifests task 7), and the cover-image column
// augmentation (`def.image` is appended to the fetched columns iff not already
// present — so the card cover value is fetched alongside the display columns and
// excluded from the text column list by the renderer).
//
// The approval cases are the load-bearing ones: a definition this device has not
// approved must not be RUN, not merely not rendered. Hiding a result that was
// already computed would still have read the vault on the reader's behalf,
// which is the exact thing the approval gate exists to prevent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult } from "../../src/notes/queryEngine";

const runViewMock = vi.fn();
const ctx = { liveIds: new Set<string>(), resolvers: {}, rowFor: () => ({ title: null, folder: null }), recencyFallback: (x: string[]) => x };

let savedViews: SavedView[] = [];
let viewApprovals: Record<string, number> = {};
const approveView = vi.fn();

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({
    prefs: { saved_views: savedViews, view_approvals: viewApprovals },
    approveView: (...a: unknown[]) => approveView(...a),
  }),
}));
vi.mock("../../src/notes/indexNonce", () => ({ useIndexNonce: () => 0 }));
vi.mock("../../src/notes/views/useRunViewContext", () => ({
  useRunViewContext: () => ctx,
}));
vi.mock("../../src/notes/queryEngine", async () => {
  const real = await vi.importActual<typeof import("../../src/notes/queryEngine")>(
    "../../src/notes/queryEngine",
  );
  return { ...real, runView: (...a: unknown[]) => runViewMock(...a) };
});

import { useViewResult } from "../../src/notes/views/useViewResult";

const EMPTY: ViewResult = { groups: [] };

const view = (over: Partial<SavedView> = {}): SavedView => ({
  id: "v1",
  name: "Books",
  view_type: "table",
  filters: { kind: "all" },
  ...over,
});

beforeEach(() => {
  savedViews = [];
  viewApprovals = {};
  approveView.mockReset();
  runViewMock.mockReset().mockResolvedValue(EMPTY);
});

afterEach(() => vi.clearAllMocks());

describe("useViewResult", () => {
  it("resolves the def from saved_views by id", async () => {
    const v = view({ id: "v1" });
    savedViews = [view({ id: "other" }), v];
    const { result } = renderHook(() => useViewResult("v1"));
    expect(result.current.def).toBe(v);
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
  });

  it("returns a null def + null result for an unknown id, and never runs the view", async () => {
    savedViews = [view({ id: "v1" })];
    const { result } = renderHook(() => useViewResult("missing"));
    expect(result.current.def).toBeNull();
    // The effect's null-def branch nulls the result and skips runView entirely.
    await waitFor(() => expect(result.current.result).toBeNull());
    expect(runViewMock).not.toHaveBeenCalled();
  });

  it("appends the cover-image property to the fetched columns when absent", async () => {
    savedViews = [view({ columns: ["author"], image: "cover" })];
    renderHook(() => useViewResult("v1"));
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
    const def = runViewMock.mock.calls[0][0] as { columns: string[] };
    expect(def.columns).toEqual(["author", "cover"]);
  });

  it("does NOT duplicate the cover-image column when already present", async () => {
    savedViews = [view({ columns: ["cover", "author"], image: "cover" })];
    renderHook(() => useViewResult("v1"));
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
    const def = runViewMock.mock.calls[0][0] as { columns: string[] };
    expect(def.columns).toEqual(["cover", "author"]);
  });

  it("passes filter/groupBy/sort straight through to runView", async () => {
    savedViews = [
      view({
        filters: { kind: "hasTag", tag: "x" },
        group_by: "status",
        sort: { key: "rating", direction: "desc" },
      }),
    ];
    renderHook(() => useViewResult("v1"));
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
    const def = runViewMock.mock.calls[0][0] as Record<string, unknown>;
    expect(def.filter).toEqual({ kind: "hasTag", tag: "x" });
    expect(def.groupBy).toBe("status");
    expect(def.sort).toEqual({ key: "rating", direction: "desc" });
  });

  it("does not run a versioned view this device has not approved", async () => {
    savedViews = [view({ version: 2 })];
    viewApprovals = { v1: 1 };
    const { result } = renderHook(() => useViewResult("v1"));

    expect(result.current.def).not.toBeNull();
    expect(result.current.approved).toBe(false);
    await waitFor(() => expect(result.current.result).toBeNull());
    // The assertion that matters: the query never ran, so nothing was read.
    expect(runViewMock).not.toHaveBeenCalled();
  });

  it("runs the view once this device's approval names its version", async () => {
    savedViews = [view({ version: 2 })];
    viewApprovals = { v1: 2 };
    const { result } = renderHook(() => useViewResult("v1"));

    expect(result.current.approved).toBe(true);
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
  });

  it("runs a versionless view, which only this vault could have authored", async () => {
    savedViews = [view()];
    const { result } = renderHook(() => useViewResult("v1"));

    expect(result.current.approved).toBe(true);
    await waitFor(() => expect(runViewMock).toHaveBeenCalled());
  });

  it("exposes the same prefs instance's approval setter", async () => {
    savedViews = [view({ version: 1 })];
    const { result } = renderHook(() => useViewResult("v1"));

    await result.current.approve("v1", 1);
    expect(approveView).toHaveBeenCalledWith("v1", 1);
  });

  it("surfaces the runView result", async () => {
    const out: ViewResult = { groups: [{ key: "", type: "none", rows: [] }] };
    runViewMock.mockResolvedValue(out);
    savedViews = [view()];
    const { result } = renderHook(() => useViewResult("v1"));
    await waitFor(() => expect(result.current.result).toBe(out));
  });
});
