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
