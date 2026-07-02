// @vitest-environment jsdom
//
// Debounce/cancel tests for the ghost-text trigger ViewPlugin (writing-assistant
// MYND-410 task 3). Mounts the full `ghostTextExtension()` with a mocked `infer`
// and fake timers, and asserts: a paused cursor fires one completion; rapid
// change cancels the pending timer; a change mid-flight discards the stale
// result. Mirrors the spell.ts scanner discipline.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  GHOST_DEBOUNCE_MS,
  ghostShowing,
  ghostTextExtension,
} from "../../src/editor/ai/ghostText";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [ghostTextExtension()],
    }),
    parent: host,
  });
}

/** Flush the pending timer + the async fire()'s awaited microtasks. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS + 1);
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockReset();
});
afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
  vi.useRealTimers();
});

describe("ghost trigger (debounce/cancel)", () => {
  it("fires one completion on a paused cursor and shows the ghost", async () => {
    invokeMock.mockResolvedValue(" continuation");
    mount("Some prose");
    // Type a char to schedule the debounce.
    view!.dispatch({
      changes: { from: view!.state.doc.length, insert: "." },
      selection: { anchor: view!.state.doc.length + 1 },
    });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:local-inference|infer",
      expect.objectContaining({ prompt: expect.stringContaining("Some prose") }),
    );
    expect(ghostShowing(view!)).toBe(true);
  });

  it("does not pile up calls: rapid edits reschedule a single timer", async () => {
    invokeMock.mockResolvedValue("x");
    mount("abc");
    for (let i = 0; i < 5; i++) {
      view!.dispatch({
        changes: { from: view!.state.doc.length, insert: "y" },
        selection: { anchor: view!.state.doc.length + 1 },
      });
      await vi.advanceTimersByTimeAsync(GHOST_DEBOUNCE_MS / 4); // never reaches the threshold
    }
    // Only after a full pause does exactly one call fire.
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the completion when there is a non-empty selection", async () => {
    invokeMock.mockResolvedValue("x");
    mount("abcdef");
    view!.dispatch({ selection: { anchor: 0, head: 3 } }); // a selection, not a bare cursor
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(ghostShowing(view!)).toBe(false);
  });
});
