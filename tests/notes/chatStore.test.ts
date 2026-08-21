import { afterEach, describe, expect, it } from "vitest";

import {
  CHAT_INITIAL,
  chatReducer,
  appendChatToken,
  clearChat,
  failChatTurn,
  finalizeChatTurn,
  getChat,
  sendChatMessage,
  stopChatTurn,
  __resetChatForTest,
  type ChatState,
} from "../../src/notes/ai/chatStore";

// conversational-ai-chat task 6 — the multi-turn transcript store.

afterEach(() => __resetChatForTest());

describe("chatReducer", () => {
  it("SEND appends a user turn + a fresh streaming assistant turn", () => {
    const out = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "hello",
    });
    expect(out.streaming).toBe(true);
    expect(out.turns).toHaveLength(2);
    expect(out.turns[0]).toMatchObject({ role: "user", text: "hello", streaming: false });
    expect(out.turns[1]).toMatchObject({ role: "assistant", text: "", streaming: true });
  });

  it("TOKEN appends to the active streaming assistant turn", () => {
    const sent = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "hi",
    });
    const t1 = chatReducer(sent, { type: "TOKEN", text: "he" });
    const t2 = chatReducer(t1, { type: "TOKEN", text: "llo" });
    expect(t2.turns[1].text).toBe("hello");
    expect(t2.turns[1].streaming).toBe(true);
  });

  it("TOKEN is a no-op when the last turn is not a streaming assistant turn", () => {
    // Only a user turn present (no assistant) → ignored.
    const state: ChatState = {
      turns: [{ id: "u1", role: "user", text: "x", streaming: false, error: false, citations: [] }],
      streaming: false,
    };
    expect(chatReducer(state, { type: "TOKEN", text: "z" })).toBe(state);
  });

  it("FINALIZE closes the assistant turn with citations and stops streaming", () => {
    const sent = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "q",
    });
    const streamed = chatReducer(sent, { type: "TOKEN", text: "answer" });
    const done = chatReducer(streamed, {
      type: "FINALIZE",
      citations: [{ noteId: "n1", byteStart: 0, byteEnd: 5, score: 0.9 }],
    });
    expect(done.streaming).toBe(false);
    expect(done.turns[1]).toMatchObject({ text: "answer", streaming: false });
    expect(done.turns[1].citations).toHaveLength(1);
  });

  it("FAIL marks the assistant turn errored and stops streaming", () => {
    const sent = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "q",
    });
    const failed = chatReducer(sent, { type: "FAIL" });
    expect(failed.streaming).toBe(false);
    expect(failed.turns[1].error).toBe(true);
  });

  it("STOP closes the turn but KEEPS the partial text", () => {
    const sent = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "q",
    });
    const partial = chatReducer(sent, { type: "TOKEN", text: "half an answ" });
    const stopped = chatReducer(partial, { type: "STOP" });
    expect(stopped.streaming).toBe(false);
    expect(stopped.turns[1].text).toBe("half an answ");
    expect(stopped.turns[1].error).toBe(false);
  });

  it("CLEARED wipes the whole transcript", () => {
    const sent = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "q",
    });
    expect(chatReducer(sent, { type: "CLEARED" })).toEqual(CHAT_INITIAL);
  });
});

describe("chat store helpers + run epoch", () => {
  it("sendChatMessage → appendChatToken → finalize streams into the transcript", () => {
    const token = sendChatMessage("what color is the sky?");
    appendChatToken(token, "It is ");
    appendChatToken(token, "blue.");
    finalizeChatTurn(token, [{ noteId: "n1", byteStart: 0, byteEnd: 3, score: 1 }]);

    const state = getChat();
    expect(state.streaming).toBe(false);
    expect(state.turns).toHaveLength(2);
    expect(state.turns[0].text).toBe("what color is the sky?");
    expect(state.turns[1].text).toBe("It is blue.");
    expect(state.turns[1].citations).toHaveLength(1);
  });

  it("a token from a stale (cleared) run is ignored — the lock-teardown guard", () => {
    const token = sendChatMessage("q");
    appendChatToken(token, "partial");
    clearChat(); // lock teardown — bumps the epoch, wipes the transcript
    // A late token from the now-stale stream must NOT resurrect anything.
    appendChatToken(token, " more");
    finalizeChatTurn(token, [{ noteId: "n1", byteStart: 0, byteEnd: 1, score: 1 }]);
    expect(getChat()).toEqual(CHAT_INITIAL);
  });

  it("stopChatTurn keeps the partial and ends streaming", () => {
    const token = sendChatMessage("q");
    appendChatToken(token, "cut here");
    stopChatTurn();
    const state = getChat();
    expect(state.streaming).toBe(false);
    expect(state.turns[1].text).toBe("cut here");
  });

  it("carries the provider error CLASS onto the turn, not just a boolean", () => {
    // myne-md/myne#440. The Rust layer classifies provider failures and
    // engine-error.ts already maps them, but the chat call site discarded the
    // error and rendered one sentence — so "your API key is wrong" and "the
    // provider is down" were indistinguishable and neither suggested an action.
    const token = sendChatMessage("q");
    failChatTurn(token, "unauthorized");

    const turn = getChat().turns.at(-1)!;
    expect(turn.error).toBe(true);
    expect(turn.errorCause).toBe("unauthorized");
  });

  it("still fails cleanly when no cause is known", () => {
    // A turn can fail before any classification exists; the generic sentence is
    // the fallback, not the default.
    const token = sendChatMessage("q");
    failChatTurn(token);

    const turn = getChat().turns.at(-1)!;
    expect(turn.error).toBe(true);
    expect(turn.errorCause).toBeUndefined();
  });

  it("failChatTurn from a stale run does not flip a fresh transcript to error", () => {
    const stale = sendChatMessage("q1");
    clearChat();
    const fresh = sendChatMessage("q2");
    // The stale run's failure must not touch the fresh run.
    failChatTurn(stale);
    expect(getChat().turns[1].error).toBe(false);
    // The fresh run can still finalize.
    finalizeChatTurn(fresh, []);
    expect(getChat().streaming).toBe(false);
  });

  it("sendChatMessage with insertable marks the assistant turn insertable (task 10)", () => {
    const token = sendChatMessage("Summarize this note", { insertable: true });
    appendChatToken(token, "the summary");
    finalizeChatTurn(token, []);
    const turns = getChat().turns;
    expect(turns[0].insertable).toBe(false); // user turn never insertable
    expect(turns[1].insertable).toBe(true);
  });
});

// myne-md/myne#533. The transcript now carries agent runs as well as ask
// exchanges, and the reducer's four ask-terminal arms must leave a run's turn
// alone. These are the rejection cases: without them the whole `kind` predicate
// could be reverted and the suite would stay green.
describe("an ask terminal may not close an agent run's turn", () => {
  /** A transcript whose last turn is a run's, with an ask stream still open in
   *  the store's eyes. That is reachable: a run started while a generation was
   *  streaming leaves `streaming: true` and appends the agent turns after the
   *  assistant one. */
  function stateWithRunLast(): ChatState {
    let s = chatReducer(CHAT_INITIAL, {
      type: "SEND",
      userId: "u1",
      assistantId: "a1",
      text: "what is this note about",
      insertable: false,
    });
    s = chatReducer(s, {
      type: "AGENT_SEND",
      userId: "u2",
      agentId: "a2",
      task: "tidy the headings",
      scopeLabel: "This note",
    });
    return s;
  }

  it("TOKEN does not append the stream's text to the run's turn", () => {
    const before = stateWithRunLast();
    expect(chatReducer(before, { type: "TOKEN", text: "hello" })).toBe(before);
  });

  it("FINALIZE does not hang the stream's citations on the run's turn", () => {
    const before = stateWithRunLast();
    const after = chatReducer(before, {
      type: "FINALIZE",
      citations: [{ noteId: "n1", byteStart: 0, byteEnd: 4, score: 1 }],
    });
    expect(after.turns).toEqual(before.turns);
    // It still closes the stream flag, because the stream really did end.
    expect(after.streaming).toBe(false);
  });

  it("FAIL does not mark the run's turn as the stream's error", () => {
    const before = stateWithRunLast();
    const after = chatReducer(before, { type: "FAIL", cause: "timeout" });
    expect(after.turns).toEqual(before.turns);
    expect(after.streaming).toBe(false);
  });

  it("STOP does not close the run's turn", () => {
    const before = stateWithRunLast();
    const after = chatReducer(before, { type: "STOP" });
    expect(after.turns).toEqual(before.turns);
    expect(after.streaming).toBe(false);
  });

  it("AGENT_SETTLE finds the run's turn even when an ask exchange came after it", () => {
    // The sequence `lastAgentIndex`'s backwards scan exists for: a run pauses on
    // a scope question, the composer is live again, the user asks something
    // else, and then the approval settles the run. A `replaceLast` would write
    // the run's counts onto that unrelated question's assistant turn.
    let s = chatReducer(CHAT_INITIAL, {
      type: "AGENT_SEND",
      userId: "u1",
      agentId: "a1",
      task: "tidy the headings",
      scopeLabel: "This note",
    });
    s = chatReducer(s, {
      type: "SEND",
      userId: "u2",
      assistantId: "a2",
      text: "meanwhile, what is this note about",
      insertable: false,
    });
    s = chatReducer(s, { type: "FINALIZE", citations: [] });
    const summary = {
      runId: "r1",
      edits: 2,
      newNotes: 0,
      notesRead: 3,
      iterations: 4,
      charsOffDevice: null,
      end: "finished" as const,
    };
    s = chatReducer(s, { type: "AGENT_SETTLE", summary });
    expect(s.turns[1]!.agentSummary).toEqual(summary);
    expect(s.turns[3]!.agentSummary).toBeUndefined();
  });
});
