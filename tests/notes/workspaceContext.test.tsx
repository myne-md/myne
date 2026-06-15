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
    const f1 = vi.fn().mockResolvedValue(undefined);
    const f2 = vi.fn().mockResolvedValue(undefined);

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
    const f = vi.fn().mockResolvedValue(undefined);
    act(() => result.current.registerFlush("note-pane", f));
    await act(async () => {
      await result.current.flushAll();
    });
    // The registered (note) flush ran; the view tab registered none and the
    // overall flush resolved without throwing.
    expect(f).toHaveBeenCalledTimes(1);
  });
});
