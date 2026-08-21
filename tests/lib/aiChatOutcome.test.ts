// Where a chat send's OUTCOME is classified (myne-md/myne#466).
//
// The transport has to distinguish an empty completion from a policy refusal
// and from a reply shape Myne does not model, so a remote provider reports it
// as the typed failure `empty_completion`. To the reader it is not a failure at
// all: the model was reached, it answered, and the answer was nothing. That is
// the same outcome a local engine produces by finalizing a turn with no text.
//
// The two used to converge in JSX, with `error: true` un-failed at render time
// by two conditions that had to stay exact complements. They converge here now,
// which is why `AiChatTab` reads one field. This file is what keeps that true:
// move the classification back into the component and the first case below
// fails.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../../src/platform/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  // `sendChat` opens a token channel before it awaits the host, so the mock has
  // to carry one. Nothing streams through it here: every case under test is
  // decided by how the host's REJECTION is classified.
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

import { sendChat } from "../../src/lib/ai-chat";
import { getChat, sendAgentTurn, __resetChatForTest } from "../../src/notes/ai/chatStore";

/** The assistant turn of the transcript, which is the one under test. */
function assistantTurn() {
  const turns = getChat().turns;
  return turns[turns.length - 1];
}

beforeEach(() => {
  invoke.mockReset();
  __resetChatForTest();
});

describe("chat send outcome classification", () => {
  it("finalizes an empty completion instead of failing it", async () => {
    invoke.mockRejectedValue({ kind: "empty_completion" });
    await sendChat("Hello");

    const turn = assistantTurn();
    // `error: false` is the assertion, not the absence of a cause: the
    // component branches on this field, and the whole point of classifying
    // here is that the field means what it says by the time it is rendered.
    expect(turn.error).toBe(false);
    expect(turn.text).toBe("");
  });

  it("still fails a policy refusal, which is a fault and reads like one", async () => {
    invoke.mockRejectedValue({ kind: "policy_refused" });
    await sendChat("Hello");

    const turn = assistantTurn();
    expect(turn.error).toBe(true);
    expect(turn.errorCause).toBe("policy_refused");
  });

  it("carries every other cause through unchanged", async () => {
    // Non-vacuity for the pair above: if the empty-completion arm were widened
    // by accident (say to any cause the table does not recognise), these would
    // stop failing and nothing else would notice.
    for (const kind of ["local_model_missing", "not_ready", "unauthorized", "timeout"]) {
      __resetChatForTest();
      invoke.mockRejectedValue({ kind });
      await sendChat("Hello");
      const turn = assistantTurn();
      expect(turn.error, `${kind} should still be a failure`).toBe(true);
      expect(turn.errorCause).toBe(kind);
    }
  });
});

describe("what the ask model is told the conversation was", () => {
  /** The `history` the last `chat_stream` call carried. */
  function sentHistory(): Array<{ role: string; content: string }> {
    const call = invoke.mock.calls.at(-1)!;
    return (call[1] as { history: Array<{ role: string; content: string }> }).history;
  }

  it("sends the chat's own turns", async () => {
    invoke.mockResolvedValue({ answer: "", sources: [], served_by: { class: "x", name: null } });
    await sendChat("first");
    await sendChat("second");
    // The first exchange, and not the message being sent right now.
    expect(sentHistory().map((m) => m.content)).toEqual(["first"]);
  });

  it("does NOT send an agent run's task, which was addressed to a different loop", async () => {
    // The property `docs/decisions/ai/0518` states and `ai-chat.ts` claims. It
    // was false on the first pass: the turn renders as an ordinary bubble, so it
    // was built with `kind: "text"`, and the filter is keyed on the kind. A task
    // carrying instructions the user aimed at the agent, under a scope this call
    // knows nothing about, went into the ask model's context.
    invoke.mockResolvedValue({ answer: "", sources: [], served_by: { class: "x", name: null } });
    sendAgentTurn("rewrite every heading in Projects", "Projects");
    await sendChat("what is this note about?");
    expect(sentHistory()).toEqual([]);
  });
});
