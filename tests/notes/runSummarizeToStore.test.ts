import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import { runSummarizeToStore } from "../../src/notes/ai/runSummarizeToStore";
import {
  type AiOutputAction,
  clearAiOutput,
  __resetAiOutputForTest,
} from "../../src/notes/ai/aiOutputStore";

function state(doc: string, sel?: { anchor: number; head: number }): EditorState {
  return EditorState.create(sel ? { doc, selection: sel } : { doc });
}

// note-summarization (MYND-409) tasks 3+4 — the summarize→store orchestration.
describe("runSummarizeToStore", () => {
  it("dispatches THINKING then RESOLVED with the summary and truncation notice", async () => {
    const actions: AiOutputAction[] = [];
    const dispatch = (a: AiOutputAction) => actions.push(a);
    // budget 3 forces truncation of the 5-char doc.
    const infer = vi.fn().mockResolvedValue("the summary");

    await runSummarizeToStore({
      state: state("abcde"),
      budget: 3,
      infer,
      dispatch,
    });

    expect(actions[0]).toEqual({ type: "THINKING" });
    expect(actions[1]).toEqual({
      type: "RESOLVED",
      text: "the summary",
      truncated: true,
      summarizedChars: 3,
    });
    // The prompt was assembled over the truncated prefix (task 2).
    expect(infer).toHaveBeenCalledTimes(1);
    expect(infer.mock.calls[0][0]).toContain("abc");
  });

  it("summarizes the selection when one is present (task 1 wiring)", async () => {
    const actions: AiOutputAction[] = [];
    const infer = vi.fn().mockResolvedValue("sel summary");
    await runSummarizeToStore({
      state: state("Hello world", { anchor: 0, head: 5 }),
      budget: 100,
      infer,
      dispatch: (a) => actions.push(a),
    });
    // The prompt is over "Hello" (the selection), not the whole doc.
    expect(infer.mock.calls[0][0]).toContain("Hello");
    expect(infer.mock.calls[0][0]).not.toContain("world");
    expect(actions[1].type).toBe("RESOLVED");
  });

  it("dispatches THINKING then FAILED when the engine errors", async () => {
    const actions: AiOutputAction[] = [];
    const infer = vi.fn().mockRejectedValue(new Error("engine down"));

    await runSummarizeToStore({
      state: state("abc"),
      budget: 100,
      infer,
      dispatch: (a) => actions.push(a),
    });

    expect(actions.map((a) => a.type)).toEqual(["THINKING", "FAILED"]);
  });

  it("drops a stale result when the run is superseded (note switch / lock) before it resolves", async () => {
    __resetAiOutputForTest();
    const actions: AiOutputAction[] = [];
    let release: ((v: string) => void) | undefined;
    const infer = vi.fn(
      () =>
        new Promise<string>((res) => {
          release = res;
        }),
    );
    const p = runSummarizeToStore({
      state: state("abc"),
      budget: 100,
      infer,
      dispatch: (a) => actions.push(a),
    });
    // Simulate a note switch / vault lock mid-inference (bumps the run epoch).
    clearAiOutput();
    release?.("late summary for the note we already left");
    await p;
    // THINKING fired, but the stale RESOLVED is dropped — never rendered against
    // (or inserted into) the note the user switched to.
    expect(actions.map((a) => a.type)).toEqual(["THINKING"]);
  });
});
