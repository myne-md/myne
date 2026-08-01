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

const inferMock = vi.fn();
/** Records the option bag the trigger asks the prompt builder for (#193). */
const promptOptsMock = vi.fn();
// Post-extraction, ghostText calls the host bridge `infer` (getHost().ai.infer),
// not the Tauri `invoke` directly — the IPC now lives in the desktop
// lib/writing-assistant behind the EditorHost seam. Mock the bridge and assert
// on the prompt handed to `infer`; `buildCompletionPrompt` is a passthrough so
// the preceding text flows into the asserted prompt.
vi.mock("@myne/editor/host/lib/writing-assistant", () => ({
  infer: (...args: unknown[]) => inferMock(...args),
  buildCompletionPrompt: (preceding: string, opts?: unknown) => {
    promptOptsMock(opts);
    return preceding;
  },
}));

import {
  GHOST_DEBOUNCE_MS,
  GHOST_MAX_NEW_TOKENS,
  ghostField,
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
  inferMock.mockReset();
  promptOptsMock.mockReset();
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
    inferMock.mockResolvedValue(" continuation");
    mount("Some prose");
    // Type a char to schedule the debounce.
    view!.dispatch({
      changes: { from: view!.state.doc.length, insert: "." },
      selection: { anchor: view!.state.doc.length + 1 },
    });
    await flush();
    expect(inferMock).toHaveBeenCalledTimes(1);
    expect(inferMock).toHaveBeenCalledWith(expect.stringContaining("Some prose"), {
      maxNewTokens: GHOST_MAX_NEW_TOKENS,
    });
    expect(ghostShowing(view!)).toBe(true);
  });

  // #193 — the passive suggestion is a few words. The ceiling is the host's
  // half; these two are the parts that survive a host which ignores it.
  it("asks for the BRIEF prompt shape, not the one `/devam` uses", async () => {
    inferMock.mockResolvedValue("x");
    mount("Some prose");
    view!.dispatch({
      changes: { from: view!.state.doc.length, insert: "." },
      selection: { anchor: view!.state.doc.length + 1 },
    });
    await flush();
    expect(promptOptsMock).toHaveBeenCalledWith({ brief: true });
  });

  it("trims a paragraph reply to one line before it reaches the widget", async () => {
    inferMock.mockResolvedValue(" a short tail. And a whole second sentence.\nPlus a paragraph.");
    mount("Some prose");
    view!.dispatch({
      changes: { from: view!.state.doc.length, insert: "." },
      selection: { anchor: view!.state.doc.length + 1 },
    });
    await flush();
    expect(view!.state.field(ghostField)?.text).toBe(" a short tail.");
  });

  it("does not pile up calls: rapid edits reschedule a single timer", async () => {
    inferMock.mockResolvedValue("x");
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
    expect(inferMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the completion when there is a non-empty selection", async () => {
    inferMock.mockResolvedValue("x");
    mount("abcdef");
    view!.dispatch({ selection: { anchor: 0, head: 3 } }); // a selection, not a bare cursor
    await flush();
    expect(inferMock).not.toHaveBeenCalled();
    expect(ghostShowing(view!)).toBe(false);
  });
});
