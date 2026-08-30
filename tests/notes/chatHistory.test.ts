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

import { beforeEach, describe, expect, it } from "vitest";

import { visibleHistory } from "../../src/notes/ai/chatHistory";
import {
  __resetChatForTest,
  blockSeedingOfExistingTurns,
  getChat,
  isSeedable,
  sendAgentTurn,
} from "../../src/notes/ai/chatStore";
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

// **Excluding a folder stops what is already on screen from being seeded**
// (myne-md/myne#617 review, D1 and D3 both).
//
// An agent turn's summary is model prose derived from the notes it read, and
// `ai_excluded_folders` is the control a user tightens specifically to stop that
// content reaching a provider. SYNC-14 carries no in-flight carve-out:
// `apply.rs` states that an exclusion added while a run is open or a review is
// pending takes effect at once, and the newest answer decides. Seeding is the
// same question one door over, and before this the derived summary was re-sent
// on every iteration of every later run in the conversation.
//
// The cut is by TIME rather than per note because a turn carries text and no
// provenance: nothing records which notes produced which sentence. Asserted on
// what `visibleHistory` RETURNS, since that is the value that reaches the host.
describe("an exclusion change stops earlier turns being seeded", () => {
  beforeEach(() => {
    __resetChatForTest();
  });

  it("drops every turn that was on screen when the exclusion set changed", () => {
    sendAgentTurn("what apps are in this note", "This note");
    expect(visibleHistory(getChat().turns).length).toBeGreaterThan(0);

    blockSeedingOfExistingTurns();
    expect(visibleHistory(getChat().turns)).toEqual([]);
  });

  it("still seeds turns created AFTER the change", () => {
    sendAgentTurn("before the change", "This note");
    blockSeedingOfExistingTurns();
    sendAgentTurn("after the change", "This note");

    const texts = visibleHistory(getChat().turns).map((t) => t.text);
    expect(texts).toContain("after the change");
    expect(texts).not.toContain("before the change");
  });

  it("is keyed on turn id, not on position", () => {
    sendAgentTurn("first", "This note");
    const firstId = getChat().turns[0]!.id;
    blockSeedingOfExistingTurns();
    expect(isSeedable(firstId)).toBe(false);

    sendAgentTurn("second", "This note");
    const later = getChat().turns.find((t) => t.text === "second");
    expect(later).toBeDefined();
    expect(isSeedable(later!.id)).toBe(true);
  });
});
