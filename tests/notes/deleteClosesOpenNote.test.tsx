// @vitest-environment jsdom
//
// myne-md/myne#819 follow-up: deleting (or trashing/archiving) a note that is
// open must leave NO tab holding it, or the pane keeps a resident, still-
// editable autosave buffer and the next keystroke writes the note back.
//
// `closeNoteEverywhere` is the workspace-side half every delete surface calls
// (NoteList's trash/archive handlers, TrashPanel's purge, the palette Empty
// trash). It used the USER-FACING `closeTab`, which refuses to close a PINNED
// tab, so a deleted pinned note stayed open and editable on every surface -
// including the sidebar path the issue names. These tests pin the invariant:
// a delete closes the note's tab whatever its pinned state.

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  WorkspaceProvider,
  useWorkspace,
} from "../../src/notes/workspaceContext";

function wrapper({ children }: { children: ReactNode }) {
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

/** Every note id still present in any pane's tab strip. */
function openNoteIds(
  leaves: Array<{ tabs: Array<{ kind: string; id: string }> }>,
): string[] {
  return leaves
    .flatMap((l) => l.tabs)
    .filter((t) => t.kind === "note")
    .map((t) => t.id);
}

describe("closeNoteEverywhere closes a deleted note's tab", () => {
  it("closes an unpinned tab (control)", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() => result.current.closeNoteEverywhere("A"));
    expect(openNoteIds(result.current.leaves)).not.toContain("A");
  });

  it("closes a PINNED tab too: the pin must not outlive the note", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    const paneId = result.current.focusedPaneId;
    act(() =>
      result.current.setItemPinned(paneId, { kind: "note", id: "A" }, true),
    );
    // Precondition: the pin really is set, so a green result is not a fixture
    // that never reached the defective state.
    expect(result.current.leaves[0]?.tabs[0]?.pinned).toBe(true);

    act(() => result.current.closeNoteEverywhere("A"));
    expect(openNoteIds(result.current.leaves)).not.toContain("A");
  });

  it("closes a pinned note across panes without touching other tabs", () => {
    const { result } = renderHook(() => useWorkspace(), { wrapper });
    act(() => result.current.openInFocused("A"));
    act(() =>
      result.current.setItemPinned(
        result.current.focusedPaneId,
        { kind: "note", id: "A" },
        true,
      ),
    );
    act(() => result.current.openToSide("B"));
    expect(result.current.leaves).toHaveLength(2);

    act(() => result.current.closeNoteEverywhere("A"));
    const open = openNoteIds(result.current.leaves);
    expect(open).not.toContain("A");
    expect(open).toContain("B");
  });
});
