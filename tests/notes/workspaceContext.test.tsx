// @vitest-environment jsdom
//
// WorkspaceProvider / useWorkspace tests (MYND-166, Tasks 3–4). Covers the
// multi-pane API the editor + sidebar drive: open (reuse / new-tab /
// to-side), split, close-pane (≥1-leaf invariant), per-pane activate /
// close-tab, and the flush registry.

import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  WorkspaceProvider,
  useWorkspace,
} from "../../src/notes/workspaceContext";
import type { ReactNode } from "react";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

describe("useWorkspace — focused-pane open", () => {
  it("openInFocused seeds then reuses the active slot", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    expect(result.current.leaves).toHaveLength(1);

    act(() => result.current.openInFocused("A"));
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["A"]);

    act(() => result.current.openInFocused("B")); // reuse
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["B"]);
  });

  it("openNewTabInFocused accumulates; reveal on duplicate", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openNewTabInFocused("B"));
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["A", "B"]);

    act(() => result.current.openNewTabInFocused("A")); // already open → reveal
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["A", "B"]);
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
  });
});

describe("useWorkspace — split panes", () => {
  it("openToSide creates a second pane holding the note and focuses it", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("B"));
    expect(result.current.leaves).toHaveLength(2);
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["B"]);
  });

  it("openToSide on an already-open note reveals, never splits", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("A"));
    expect(result.current.leaves).toHaveLength(1);
  });

  it("splitFocused makes a fresh empty focused pane", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.splitFocused("row"));
    expect(result.current.leaves).toHaveLength(2);
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual([]);
    expect(result.current.focusedLeaf.activeTab).toBeNull();
  });

  it("closePane removes a pane; the last leaf can't be closed", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("B"));
    const sideId = result.current.focusedPaneId;

    act(() => result.current.closePane(sideId));
    expect(result.current.leaves).toHaveLength(1);

    // The only leaf can't be closed (no-op).
    const onlyId = result.current.focusedPaneId;
    act(() => result.current.closePane(onlyId));
    expect(result.current.leaves).toHaveLength(1);
  });
});

describe("useWorkspace — per-pane tab ops", () => {
  it("activateInPane focuses that pane and activates the tab", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    const homeId = result.current.focusedPaneId;
    act(() => result.current.openToSide("B")); // focus moves to side pane
    expect(result.current.focusedPaneId).not.toBe(homeId);

    act(() => result.current.activateInPane(homeId, "A"));
    expect(result.current.focusedPaneId).toBe(homeId);
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
  });

  it("closeTabInPane emptying a non-last pane removes it", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("B"));
    const sideId = result.current.focusedPaneId;
    act(() => result.current.closeTabInPane(sideId, "B"));
    expect(result.current.leaves).toHaveLength(1);
  });

  it("closing the last tab of the ONLY pane leaves it tabless (empty-shell)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    const id = result.current.focusedPaneId;
    act(() => result.current.closeTabInPane(id, "A"));
    expect(result.current.leaves).toHaveLength(1);
    expect(result.current.focusedLeaf.activeTab).toBeNull();
  });
});

describe("useWorkspace — back/forward history (MYND-260)", () => {
  it("steps back and forward through the sequence of opened notes", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openInFocused("B"));
    act(() => result.current.openInFocused("C"));
    expect(result.current.focusedLeaf.activeTab?.id).toBe("C");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);

    act(() => result.current.goBack());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("B");
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(true);

    act(() => result.current.goBack());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
    expect(result.current.canGoBack).toBe(false);

    act(() => result.current.goForward());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("B");
    act(() => result.current.goForward());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("C");
    expect(result.current.canGoForward).toBe(false);
  });

  it("re-opens a note that has left the strip (browse-replace flow)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    // openInFocused reuses the active slot, so A leaves the strip when B opens.
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openInFocused("B"));
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["B"]);

    act(() => result.current.goBack());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["A"]);
  });

  it("opening a fresh note after a back truncates the forward tail", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openInFocused("B"));
    act(() => result.current.goBack()); // back to A — B is now forward
    expect(result.current.canGoForward).toBe(true);

    act(() => result.current.openInFocused("C")); // new branch drops B
    expect(result.current.focusedLeaf.activeTab?.id).toBe("C");
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.goBack());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
  });

  it("both directions are disabled before any second note opens", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
    act(() => result.current.openInFocused("A"));
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it("keeps independent history per pane (follows focus)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openInFocused("B")); // home pane: [A,B]
    const homeId = result.current.focusedPaneId;
    act(() => result.current.openToSide("X")); // side pane focused, fresh history
    expect(result.current.canGoBack).toBe(false); // side pane has only X

    act(() => result.current.focusPane(homeId)); // back to home pane
    expect(result.current.canGoBack).toBe(true); // home still remembers A
    act(() => result.current.goBack());
    expect(result.current.focusedLeaf.activeTab?.id).toBe("A");
  });
});

describe("useWorkspace — flush registry", () => {
  it("flushAll calls every registered pane flusher; unregister stops it", async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const f1 = vi.fn().mockResolvedValue(true);
    const f2 = vi.fn().mockResolvedValue(true);

    act(() => {
      result.current.registerFlush("p1", f1);
      result.current.registerFlush("p2", f2);
    });
    await act(async () => {
      await result.current.flushAll();
    });
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);

    act(() => result.current.unregisterFlush("p2"));
    await act(async () => {
      await result.current.flushAll();
    });
    expect(f1).toHaveBeenCalledTimes(2);
    expect(f2).toHaveBeenCalledTimes(1); // not called again
  });

  it("flushAll forwards its options to every flusher", async () => {
    // Proves the `forceBaseGuard` override is threaded through the registry:
    // replacing `f(opts)` with `f()` would silently disable the detached-window
    // removal fix (myne-md/myne#839) and this assertion is what catches it.
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const f1 = vi.fn().mockResolvedValue(true);
    act(() => result.current.registerFlush("p1", f1));
    await act(async () => {
      await result.current.flushAll({ forceBaseGuard: true });
    });
    expect(f1).toHaveBeenCalledWith({ forceBaseGuard: true });
    await act(async () => {
      await result.current.flushAll();
    });
    expect(f1).toHaveBeenLastCalledWith(undefined);
  });

  // myne-md/myne#520. `flushAll` used to swallow every per-flusher rejection,
  // and `useAutosave.fireSave` swallows one of its own into that pane's
  // `saveStatus`, so a pane whose `note_update` FAILED reported success to
  // every caller: the folder rename, the inbound title rename, the frontmatter
  // writers and vim `:w` all read stale disk bytes and wrote on top of them.
  // The flusher now answers whether the pane SETTLED, and these three cases are
  // what make that answer load-bearing rather than decorative.
  it("rejects when a pane reports it did not settle", async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => {
      result.current.registerFlush("clean", vi.fn().mockResolvedValue(true));
      result.current.registerFlush("dirty", vi.fn().mockResolvedValue(false));
    });
    await act(async () => {
      await expect(result.current.flushAll()).rejects.toThrow(/did not settle/);
    });
  });

  it("rejects when a flusher throws outright, and still runs the others", async () => {
    // Both directions in one: the rejection must not be swallowed, AND it must
    // not short-circuit `Promise.all` and hide the sibling panes.
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const other = vi.fn().mockResolvedValue(true);
    act(() => {
      result.current.registerFlush("boom", vi.fn().mockRejectedValue(new Error("io")));
      result.current.registerFlush("other", other);
    });
    await act(async () => {
      await expect(result.current.flushAll()).rejects.toThrow(/did not settle/);
    });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("names WHICH panes did not settle, so one failure does not hide two", async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => {
      result.current.registerFlush("pane-a", vi.fn().mockResolvedValue(false));
      result.current.registerFlush("pane-b", vi.fn().mockResolvedValue(false));
      result.current.registerFlush("pane-settled", vi.fn().mockResolvedValue(true));
    });
    await act(async () => {
      const failed = await result.current.flushAll().then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
      expect(failed).not.toBeNull();
      // The count AND the ids, read out of the parenthesised list rather than
      // by substring: the surrounding sentence contains ordinary English words,
      // so a `toContain` on a short id passes on the prose. A count alone
      // cannot be acted on, and the settled pane must not appear.
      expect(failed).toMatch(/2 pane\(s\)/);
      const listed = /\(([^)]*)\)/.exec(failed?.replace("pane(s)", "") ?? "")?.[1];
      expect(listed?.split(", ").sort()).toEqual(["pane-a", "pane-b"]);
    });
  });
});

describe("useWorkspace — saved-view (item) tabs (MYND-274)", () => {
  it("openView shows a view tab; a note and a view may share an id", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openView("a")); // a VIEW "a" into the empty pane
    expect(result.current.focusedLeaf.tabs).toEqual([{ kind: "view", id: "a" }]);
    expect(result.current.focusedLeaf.activeTab).toEqual({ kind: "view", id: "a" });
    // A NOTE with the same id-string is a distinct item (no collision).
    act(() => result.current.openNewTabInFocused("a"));
    expect(result.current.focusedLeaf.tabs).toEqual([
      { kind: "view", id: "a" },
      { kind: "note", id: "a" },
    ]);
  });

  it("openView reveals an already-open view (no duplicate)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openView("books"));
    act(() => result.current.openNewTabInFocused("n1"));
    act(() => result.current.openView("books")); // already open → reveal
    const views = result.current.focusedLeaf.tabs.filter((t) => t.kind === "view");
    expect(views).toHaveLength(1);
    expect(result.current.focusedLeaf.activeTab).toEqual({ kind: "view", id: "books" });
  });

  it("closeItemInPane closes a view tab via the strip", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openView("v1")); // [view v1]
    act(() => result.current.openNewTabInFocused("n1")); // [view v1, note n1]
    const pane = result.current.focusedPaneId;
    act(() => result.current.closeItemInPane(pane, { kind: "view", id: "v1" }));
    expect(result.current.focusedLeaf.tabs).toEqual([{ kind: "note", id: "n1" }]);
  });

  it("a view tab moves into a split alongside a note tab", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("n1")); // pane root: [note n1]
    const root = result.current.focusedPaneId;
    act(() => result.current.openNewTabInFocused("v-as-note-filler"));
    act(() => result.current.openView("v1")); // reuses active slot → [n1, view v1]
    // Drag the view out into a column split on the same pane.
    act(() =>
      result.current.splitPaneWithItem(root, "column", "after", {
        kind: "view",
        id: "v1",
      }),
    );
    expect(result.current.leaves).toHaveLength(2);
    // The new focused leaf holds the view; the original keeps the notes.
    expect(result.current.focusedLeaf.tabs).toEqual([{ kind: "view", id: "v1" }]);
  });

  it("flushAll does not error on a workspace containing view tabs", async () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openView("v1")); // a view tab (no autosave/flush)
    const f = vi.fn().mockResolvedValue(true);
    act(() => result.current.registerFlush("note-pane", f));
    await act(async () => {
      await result.current.flushAll();
    });
    // The registered (note) flush ran; the view tab registered none and the
    // overall flush resolved without throwing.
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("useWorkspace — graph tab (MYND-198)", () => {
  it("openGraph reuses the active slot in the focused pane", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openGraph()); // into the empty focused pane
    expect(result.current.focusedLeaf.tabs).toEqual([{ kind: "graph", id: "graph" }]);
    expect(result.current.focusedLeaf.activeTab).toEqual({ kind: "graph", id: "graph" });
  });

  it("openGraph appends into a pending new tab instead of reusing", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A")); // [note A]
    const pane = result.current.focusedPaneId;
    act(() => result.current.beginNewTab(pane)); // pending "new tab"
    act(() => result.current.openGraph()); // appends, does NOT replace note A
    expect(result.current.focusedLeaf.tabs).toEqual([
      { kind: "note", id: "A" },
      { kind: "graph", id: "graph" },
    ]);
  });

  it("openGraph is a singleton — reveals the existing graph tab", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openGraph()); // root: [graph]
    act(() => result.current.openToSide("A")); // side pane focused
    expect(result.current.leaves).toHaveLength(2);
    act(() => result.current.openGraph()); // already open → reveal, no 2nd tab
    const graphs = result.current.leaves
      .flatMap((l) => l.tabs)
      .filter((t) => t.kind === "graph");
    expect(graphs).toHaveLength(1);
    expect(result.current.focusedLeaf.activeTab).toEqual({ kind: "graph", id: "graph" });
  });

  it("closeItemInPane closes the graph tab via the strip", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openGraph());
    act(() => result.current.openNewTabInFocused("n1")); // [graph, note n1]
    const pane = result.current.focusedPaneId;
    act(() => result.current.closeItemInPane(pane, { kind: "graph", id: "graph" }));
    expect(result.current.focusedLeaf.tabs).toEqual([{ kind: "note", id: "n1" }]);
  });
});

describe("useWorkspace — sidebar folder-expand set (MYND-455)", () => {
  const add = (key: string) => (prev: ReadonlySet<string>) => new Set(prev).add(key);

  it("the updater resolves against the live container, so toggles accumulate", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    expect(result.current.expandedFolders).toEqual([]);

    act(() => result.current.setExpandedFolders(add("a/")));
    act(() => result.current.setExpandedFolders(add("b/")));
    expect([...result.current.expandedFolders].sort()).toEqual(["a/", "b/"]);
  });

  it("a toggle that lands BEFORE the async restore never resurrects the pre-restore set", () => {
    // The regression this pins: the expand set has ONE owner (the container).
    // A sidebar toggle firing in the window before `restoreContainer` lands must
    // not survive the restore — the persisted set wins, and the next toggle must
    // build on IT, not on the value the early toggle produced. A local mirror
    // would strand the pre-restore value and clobber the blob on the next push.
    const { result } = renderHook(() => useWorkspace(), { wrapper });

    act(() => result.current.setExpandedFolders(add("early/")));
    expect(result.current.expandedFolders).toEqual(["early/"]);

    act(() =>
      result.current.restoreContainer({
        ...result.current.workspacesSnapshot(),
        expandedFolders: ["persisted-1/", "persisted-2/"],
      }),
    );
    expect(result.current.expandedFolders).toEqual(["persisted-1/", "persisted-2/"]);

    act(() => result.current.setExpandedFolders(add("after/")));
    expect([...result.current.expandedFolders].sort()).toEqual([
      "after/",
      "persisted-1/",
      "persisted-2/",
    ]);
    expect(result.current.expandedFolders).not.toContain("early/");
  });

  it("emptying the set drops the field (omit-when-default)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.setExpandedFolders(add("a/")));
    expect(result.current.workspacesSnapshot().expandedFolders).toEqual(["a/"]);

    act(() => result.current.setExpandedFolders(new Set()));
    expect(result.current.workspacesSnapshot().expandedFolders).toBeUndefined();
  });
});

describe("useWorkspace — closeNoteEverywhere (#219)", () => {
  it("removes the note from its pane (leaving the others)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openNewTabInFocused("B"));
    act(() => result.current.closeNoteEverywhere("A"));
    expect(result.current.focusedLeaf.tabs.map((t) => t.id)).toEqual(["B"]);
  });

  it("removes the note from EVERY pane it is open in", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("A")); // A now lives in a second pane too
    act(() => result.current.closeNoteEverywhere("A"));
    const anyHasA = result.current.leaves.some((l) =>
      l.tabs.some((t) => t.id === "A"),
    );
    expect(anyHasA).toBe(false);
  });
});

// `api` identity across an otherwise inert re-render.
//
// `collectLeaves(root)` and `focusedLeaf(state)` each allocate a fresh array or
// object on every call, and both sat in the `api` memo's dep list. Called bare
// they rebuilt the whole `useWorkspace` value on EVERY render, including one
// where the pane tree had not moved at all, so an unrelated parent re-render
// re-rendered every workspace surface. The fix memoizes the two with deps
// naming the fields they actually read.
//
// Pinned as IDENTITY rather than as a render count: identity is the thing the
// memo gates on, and it is what a render count cannot isolate. The second case
// is the non-vacuity half — without it, a memo that returned a module constant
// would pass the first.
describe("useWorkspace — api identity is inert-render stable", () => {
  it("hands back the same api, leaves and focused leaf when nothing moved", () => {
    const { result, rerender } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openNewTabInFocused("A"));

    const api = result.current;
    const leaves = result.current.leaves;
    const focused = result.current.focusedLeaf;

    act(() => rerender());

    expect(result.current).toBe(api);
    expect(result.current.leaves).toBe(leaves);
    expect(result.current.focusedLeaf).toBe(focused);
  });

  it("still rebuilds when the pane tree actually moves", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    const before = result.current;
    act(() => result.current.openInFocused("A"));
    expect(result.current).not.toBe(before);
    expect(result.current.leaves).not.toBe(before.leaves);
  });
});
