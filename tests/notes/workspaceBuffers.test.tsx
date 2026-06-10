// @vitest-environment jsdom
//
// Multi-buffer residency tests (MYND-166, Task 2). Proves the four
// acceptance criteria of one-component-per-open-note residency:
//  1. independent autosave per buffer (no cross-write),
//  2. a tab switch (visibility toggle) preserves each buffer's edits,
//  3. closing a tab unmounts its buffer → best-effort flush + teardown,
//  4. opening adds a buffer without disturbing existing ones.
//
// Implementation under test: `src/notes/workspaceBuffers.tsx`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  WorkspaceBuffers,
  type NoteBufferRenderProps,
} from "../../src/notes/workspaceBuffers";
import { AUTOSAVE_IDLE_MS } from "../../src/notes/saveNote";

/** Latest render-props per noteId, captured by the test render-prop. */
function makeHarness() {
  const handles = new Map<string, NoteBufferRenderProps>();
  const render = (p: NoteBufferRenderProps) => {
    handles.set(p.noteId, p);
    return <div data-testid={p.noteId}>{p.content}</div>;
  };
  return { handles, render };
}

const readImpl = (id: string) => Promise.resolve(`body:${id}`);

describe("WorkspaceBuffers residency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives each open note an independent buffer + autosave (no cross-write)", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { handles, render: renderBuf } = makeHarness();

    await act(async () => {
      render(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A", "B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });

    // Both buffers loaded their own content.
    expect(handles.get("A")!.content).toBe("body:A");
    expect(handles.get("B")!.content).toBe("body:B");

    // Edit only A → only A autosaves, with A's body.
    await act(async () => {
      handles.get("A")!.setContent("body:A edited");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenCalledWith("A", "body:A edited");

    // Edit only B → only B autosaves, with B's body. A is untouched.
    await act(async () => {
      handles.get("B")!.setContent("body:B edited");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(saveImpl).toHaveBeenCalledTimes(2);
    expect(saveImpl).toHaveBeenLastCalledWith("B", "body:B edited");
    // No save ever crossed wires (A never saved B's body or vice-versa).
    expect(saveImpl).not.toHaveBeenCalledWith("A", "body:B edited");
    expect(saveImpl).not.toHaveBeenCalledWith("B", "body:A edited");
  });

  it("preserves a background buffer's edits across a visibility toggle", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { handles, render: renderBuf } = makeHarness();

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A", "B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });

    await act(async () => {
      handles.get("B")!.setContent("B work-in-progress");
    });

    // Hide B (still open, just not the active tab in its pane).
    await act(async () => {
      view.rerender(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });
    expect(handles.get("B")!.active).toBe(false);
    expect(handles.get("B")!.content).toBe("B work-in-progress"); // not lost

    // Show B again — same edited content, now visible.
    await act(async () => {
      view.rerender(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A", "B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });
    expect(handles.get("B")!.active).toBe(true);
    expect(handles.get("B")!.content).toBe("B work-in-progress");
  });

  it("flushes a dirty buffer on close (unmount → best-effort save + teardown)", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { handles, render: renderBuf } = makeHarness();

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A", "B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });

    // Make A dirty but do NOT let the idle timer fire (no save yet).
    await act(async () => {
      handles.get("A")!.setContent("A unsaved");
    });
    expect(saveImpl).not.toHaveBeenCalled();

    // Close A (remove from openNoteIds) → its buffer unmounts.
    await act(async () => {
      view.rerender(
        <WorkspaceBuffers
          openNoteIds={["B"]}
          visibleNoteIds={["B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });

    // Unmount cleanup fired the best-effort flush with A's latest body.
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenCalledWith("A", "A unsaved");

    // After teardown, A's idle timer must not fire a second save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).not.toHaveBeenCalledWith("B", expect.anything());
  });

  it("opening a note adds a buffer without disturbing existing ones", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { handles, render: renderBuf } = makeHarness();

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(
        <WorkspaceBuffers
          openNoteIds={["A"]}
          visibleNoteIds={["A"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });
    await act(async () => {
      handles.get("A")!.setContent("A edited");
    });

    // Open B alongside A.
    await act(async () => {
      view.rerender(
        <WorkspaceBuffers
          openNoteIds={["A", "B"]}
          visibleNoteIds={["A", "B"]}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={renderBuf}
        />,
      );
    });

    expect(handles.get("B")!.content).toBe("body:B"); // freshly loaded
    expect(handles.get("A")!.content).toBe("A edited"); // undisturbed
  });
});
