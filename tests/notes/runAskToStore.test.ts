import { describe, expect, it, vi } from "vitest";

import { runAskToStore } from "../../src/notes/ai/runAskToStore";
import type { AiOutputAction } from "../../src/notes/ai/aiOutputStore";

// semantic-search-qa (MYND-412) tasks 6/7 — the ask→store orchestration that the
// AI Chat tab's question box drives.
describe("runAskToStore", () => {
  it("dispatches THINKING then RESOLVED with the grounded answer", async () => {
    const actions: AiOutputAction[] = [];
    const ask = vi.fn().mockResolvedValue("the grounded answer");

    await runAskToStore({
      question: "What did I note about mitochondria?",
      ask,
      dispatch: (a) => actions.push(a),
    });

    expect(actions[0]).toEqual({ type: "THINKING" });
    expect(actions[1]).toEqual({
      type: "RESOLVED",
      text: "the grounded answer",
      truncated: false,
      summarizedChars: 0,
    });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toBe("What did I note about mitochondria?");
  });

  it("trims the question before asking", async () => {
    const ask = vi.fn().mockResolvedValue("a");
    await runAskToStore({ question: "  spaced out  ", ask, dispatch: () => {} });
    expect(ask.mock.calls[0][0]).toBe("spaced out");
  });

  it("is a no-op on a blank question — never dispatches, never calls the engine", async () => {
    const actions: AiOutputAction[] = [];
    const ask = vi.fn().mockResolvedValue("unused");

    await runAskToStore({ question: "   ", ask, dispatch: (a) => actions.push(a) });

    expect(actions).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("dispatches THINKING then FAILED when the engine errors", async () => {
    const actions: AiOutputAction[] = [];
    const ask = vi.fn().mockRejectedValue(new Error("engine down"));

    await runAskToStore({
      question: "anything",
      ask,
      dispatch: (a) => actions.push(a),
    });

    expect(actions.map((a) => a.type)).toEqual(["THINKING", "FAILED"]);
  });
});
