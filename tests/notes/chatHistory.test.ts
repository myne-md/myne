// What a run is seeded with (myne-md/myne#617).
//
// The rule under test is "what is on screen is what is sent", and its whole
// value is that it is ONE rule. Every case below is a way that rule could
// quietly become two: an agent turn whose answer lives on a different field
// from a text turn's, a turn still streaming, a turn that errored.
//
// The BUDGET is not tested here and cannot be: it is applied host-side, in
// `core/src/plugins/agent/history.rs`, because what reaches the model is policy
// and a caller that pre-trimmed would be deciding it. This module's job is only
// to say what is visible.

import { describe, expect, it } from "vitest";

import { visibleHistory } from "../../src/notes/ai/chatHistory";
import type { ChatTurn } from "../../src/notes/ai/chatStore";

function turn(over: Partial<ChatTurn>): ChatTurn {
  return {
    id: "t",
    kind: "agent",
    role: "assistant",
    text: "",
    streaming: false,
    error: false,
    ...over,
  } as ChatTurn;
}

describe("visibleHistory", () => {
  it("carries the user's own words and the model's answer, in order", () => {
    const out = visibleHistory([
      turn({ id: "1", role: "user", text: "what apps are in this note" }),
      turn({
        id: "2",
        role: "assistant",
        agentSummary: { summary: "gifski, libheif, IINA" } as ChatTurn["agentSummary"],
      }),
    ]);
    expect(out).toEqual([
      { role: "user", text: "what apps are in this note" },
      { role: "assistant", text: "gifski, libheif, IINA" },
    ]);
  });

  /// The two flows keep their answer on different fields. Reading only one
  /// would drop half a conversation depending on which produced it, and the
  /// panel renders both as ordinary bubbles, so nothing on screen would say why.
  it("reads a text turn's answer off `text` and an agent turn's off its summary", () => {
    const out = visibleHistory([
      turn({ id: "1", kind: "text", role: "assistant", text: "a plain answer" }),
      turn({
        id: "2",
        kind: "agent",
        role: "assistant",
        text: "ignored",
        agentSummary: { summary: "an agent answer" } as ChatTurn["agentSummary"],
      }),
    ]);
    expect(out.map((t) => t.text)).toEqual(["a plain answer", "an agent answer"]);
  });

  /// A streaming turn's text is a partial the next dispatch replaces. Seeding a
  /// half-sentence teaches the model a fact that was never true.
  it("skips a turn that is still streaming", () => {
    const out = visibleHistory([
      turn({ id: "1", role: "user", text: "go" }),
      turn({ id: "2", role: "assistant", text: "half a sen", streaming: true }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("skips a turn that errored, whose text is a failure notice rather than an answer", () => {
    const out = visibleHistory([
      turn({ id: "1", role: "assistant", text: "The agent could not start.", error: true }),
    ]);
    expect(out).toHaveLength(0);
  });

  it("skips a turn with nothing to show", () => {
    const out = visibleHistory([
      turn({ id: "1", role: "user", text: "   " }),
      turn({ id: "2", role: "assistant", agentSummary: undefined }),
    ]);
    expect(out).toHaveLength(0);
  });

  /// The half that is easy to get wrong in the other direction: an agent turn
  /// that answered nothing (an edit run, which has counts and no summary) is
  /// not seeded as an empty assistant turn.
  it("does not seed an agent turn that proposed changes without answering", () => {
    const out = visibleHistory([
      turn({ id: "1", role: "user", text: "tidy the headings" }),
      turn({
        id: "2",
        role: "assistant",
        agentSummary: { summary: "" } as ChatTurn["agentSummary"],
      }),
    ]);
    expect(out).toEqual([{ role: "user", text: "tidy the headings" }]);
  });

  it("returns nothing for an empty transcript, which is the first message in a session", () => {
    expect(visibleHistory([])).toEqual([]);
  });
});
