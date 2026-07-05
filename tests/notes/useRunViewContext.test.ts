// @vitest-environment jsdom
//
// `useRunViewContext` (Saved Views #5/#4) — assembles the impure RunViewContext
// the query engine needs from the sidebar cache + index accessors. Mocks every
// wiring surface and asserts the assembly contract: the live set excludes
// trashed/template notes (the single T3 gate), each resolver delegates to the
// right accessor (hasTag/inFolder/search/propertyValues), search maps hits →
// ids, rowFor falls back to null for an unknown id, and recencyFallback delegates
// to sortBatchIds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const byTagMock = vi.fn();
const propertyValuesMock = vi.fn();
const searchNotesMock = vi.fn();
const folderSubtreeMock = vi.fn();
const sortBatchIdsMock = vi.fn();

const cache = new Map([
  ["live1", { noteUuid: "live1", title: "Live One", folder: "A/", updatedAt: null, trashed: null, template: false }],
  ["live2", { noteUuid: "live2", title: "Live Two", folder: null, updatedAt: null, trashed: null, template: false }],
  ["trashed1", { noteUuid: "trashed1", title: "Gone", folder: null, updatedAt: null, trashed: "2026-01-01T00:00:00Z", template: false }],
  ["tmpl1", { noteUuid: "tmpl1", title: "Template", folder: null, updatedAt: null, trashed: null, template: true }],
]);

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { deliberate_folders: [], archived_folders: [] } }),
}));
vi.mock("../../src/notes/sidebarState", async () => {
  // Reuse the REAL liveCache / sortBatchIds (pure) so the live-set gate is the
  // production logic, not a re-stub; only the React hook is faked.
  const real = await vi.importActual<typeof import("../../src/notes/sidebarState")>(
    "../../src/notes/sidebarState",
  );
  return {
    liveCache: real.liveCache,
    sortBatchIds: (...a: unknown[]) => sortBatchIdsMock(...a),
    useSelectedNote: () => ({ cache }),
  };
});
vi.mock("../../src/notes/folderTree", () => ({
  deriveFolderTree: () => ({ roots: [] }),
}));
vi.mock("../../src/notes/searchNotes", () => ({
  searchNotes: (...a: unknown[]) => searchNotesMock(...a),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  byTag: (...a: unknown[]) => byTagMock(...a),
  vaultIndicesPropertyValues: (...a: unknown[]) => propertyValuesMock(...a),
}));
vi.mock("../../src/notes/queryEngine", async () => {
  const real = await vi.importActual<typeof import("../../src/notes/queryEngine")>(
    "../../src/notes/queryEngine",
  );
  return {
    ...real,
    folderSubtreeNoteIds: (...a: unknown[]) => folderSubtreeMock(...a),
  };
});

import { useRunViewContext } from "../../src/notes/views/useRunViewContext";

beforeEach(() => {
  byTagMock.mockReset().mockResolvedValue(["live1"]);
  propertyValuesMock.mockReset().mockResolvedValue([["live1", { key: "k", type: "string", value: "v" }]]);
  searchNotesMock.mockReset().mockResolvedValue([
    { note_id: "live2", title: "x", score: 1, matched_in: { title: false, body: true } },
    { note_id: "live1", title: "y", score: 1, matched_in: { title: false, body: true } },
  ]);
  folderSubtreeMock.mockReset().mockReturnValue(["live1"]);
  sortBatchIdsMock.mockReset().mockReturnValue(["live2", "live1"]);
});

afterEach(() => vi.clearAllMocks());

describe("useRunViewContext", () => {
  it("builds a live set excluding trashed + template notes", () => {
    const { result } = renderHook(() => useRunViewContext());
    expect([...result.current.liveIds].sort()).toEqual(["live1", "live2"]);
  });

  it("hasTag delegates to byTag with the live id set", async () => {
    const { result } = renderHook(() => useRunViewContext());
    await result.current.resolvers.hasTag("project");
    expect(byTagMock).toHaveBeenCalledTimes(1);
    expect(byTagMock.mock.calls[0][0]).toBe("project");
    const liveArg = byTagMock.mock.calls[0][1] as Set<string>;
    expect([...liveArg].sort()).toEqual(["live1", "live2"]);
  });

  it("inFolder delegates to folderSubtreeNoteIds for the path", async () => {
    const { result } = renderHook(() => useRunViewContext());
    await expect(result.current.resolvers.inFolder("A/")).resolves.toEqual(["live1"]);
    expect(folderSubtreeMock).toHaveBeenCalledWith({ roots: [] }, "A/");
  });

  it("search maps NoteSearchResult hits to bare note ids", async () => {
    const { result } = renderHook(() => useRunViewContext());
    await expect(result.current.resolvers.search("q")).resolves.toEqual([
      "live2",
      "live1",
    ]);
    expect(searchNotesMock).toHaveBeenCalledWith("q");
  });

  it("propertyValues delegates to vaultIndicesPropertyValues", async () => {
    const { result } = renderHook(() => useRunViewContext());
    await result.current.resolvers.propertyValues("rating");
    expect(propertyValuesMock).toHaveBeenCalledWith("rating");
  });

  it("rowFor returns the cached title/folder, and null/null for an unknown id", () => {
    const { result } = renderHook(() => useRunViewContext());
    expect(result.current.rowFor("live1")).toEqual({ title: "Live One", folder: "A/" });
    expect(result.current.rowFor("nope")).toEqual({ title: null, folder: null });
  });

  it("recencyFallback delegates to sortBatchIds over the live cache", () => {
    const { result } = renderHook(() => useRunViewContext());
    expect(result.current.recencyFallback(["live1", "live2"])).toEqual([
      "live2",
      "live1",
    ]);
    expect(sortBatchIdsMock).toHaveBeenCalledTimes(1);
    expect(sortBatchIdsMock.mock.calls[0][0]).toEqual(["live1", "live2"]);
  });
});
