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
    expect(result.current.focusedLeaf.tabs).toEqual(["A"]);

    act(() => result.current.openInFocused("B")); // reuse
    expect(result.current.focusedLeaf.tabs).toEqual(["B"]);
  });

  it("openNewTabInFocused accumulates; reveal on duplicate", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openNewTabInFocused("B"));
    expect(result.current.focusedLeaf.tabs).toEqual(["A", "B"]);

    act(() => result.current.openNewTabInFocused("A")); // already open → reveal
    expect(result.current.focusedLeaf.tabs).toEqual(["A", "B"]);
    expect(result.current.focusedLeaf.activeTab).toBe("A");
  });
});

describe("useWorkspace — split panes", () => {
  it("openToSide creates a second pane holding the note and focuses it", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.openToSide("B"));
    expect(result.current.leaves).toHaveLength(2);
    expect(result.current.focusedLeaf.tabs).toEqual(["B"]);
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
    expect(result.current.focusedLeaf.tabs).toEqual([]);
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
    expect(result.current.focusedLeaf.activeTab).toBe("A");
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
