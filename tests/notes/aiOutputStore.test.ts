import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AI_OUTPUT_INITIAL,
  aiOutputReducer,
  clearAiOutput,
  dispatchAiOutput,
  getAiOutput,
  subscribeAiOutput,
  __resetAiOutputForTest,
} from "../../src/notes/ai/aiOutputStore";

// note-summarization (MYND-409) task 4 — the ephemeral AI-output render store.
describe("aiOutputReducer", () => {
  it("THINKING drops any prior text (no stale output on a new run)", () => {
    const prior = { status: "ready" as const, text: "old", truncated: true, summarizedChars: 9 };
    expect(aiOutputReducer(prior, { type: "THINKING" })).toEqual({
      status: "thinking",
      text: null,
      truncated: false,
      summarizedChars: 0,
    });
  });

  it("RESOLVED holds the text + truncation notice", () => {
    const out = aiOutputReducer(AI_OUTPUT_INITIAL, {
      type: "RESOLVED",
      text: "a summary",
      truncated: true,
      summarizedChars: 1200,
    });
    expect(out).toEqual({
      status: "ready",
      text: "a summary",
      truncated: true,
      summarizedChars: 1200,
    });
  });

  it("FAILED drops the text reference (no partial output on error)", () => {
    const prior = { status: "thinking" as const, text: null, truncated: false, summarizedChars: 0 };
    expect(aiOutputReducer(prior, { type: "FAILED" }).status).toBe("error");
    expect(aiOutputReducer(prior, { type: "FAILED" }).text).toBeNull();
  });

  it("CLEARED wipes back to the initial state (lock/teardown drop)", () => {
    const prior = { status: "ready" as const, text: "secret-ish", truncated: false, summarizedChars: 0 };
    expect(aiOutputReducer(prior, { type: "CLEARED" })).toEqual(AI_OUTPUT_INITIAL);
    expect(aiOutputReducer(prior, { type: "CLEARED" }).text).toBeNull();
  });
});

describe("module store (dispatch / get / subscribe / clear)", () => {
  beforeEach(() => __resetAiOutputForTest());
  afterEach(() => __resetAiOutputForTest());

  it("starts idle", () => {
    expect(getAiOutput()).toEqual(AI_OUTPUT_INITIAL);
  });

  it("dispatch drives the state and notifies subscribers", () => {
    let notified = 0;
    const unsub = subscribeAiOutput(() => {
      notified += 1;
    });
    dispatchAiOutput({ type: "THINKING" });
    expect(getAiOutput().status).toBe("thinking");
    dispatchAiOutput({ type: "RESOLVED", text: "s", truncated: false, summarizedChars: 1 });
    expect(getAiOutput().status).toBe("ready");
    expect(getAiOutput().text).toBe("s");
    expect(notified).toBe(2);
    unsub();
  });

  it("clearAiOutput wipes the rendered output (teardown)", () => {
    dispatchAiOutput({ type: "RESOLVED", text: "held", truncated: false, summarizedChars: 0 });
    expect(getAiOutput().text).toBe("held");
    clearAiOutput();
    expect(getAiOutput()).toEqual(AI_OUTPUT_INITIAL);
    expect(getAiOutput().text).toBeNull();
  });

  it("an unsubscribed listener is not notified", () => {
    let notified = 0;
    const unsub = subscribeAiOutput(() => {
      notified += 1;
    });
    unsub();
    dispatchAiOutput({ type: "THINKING" });
    expect(notified).toBe(0);
  });

  it("a no-op dispatch (unchanged state) does not notify", () => {
    let notified = 0;
    subscribeAiOutput(() => {
      notified += 1;
    });
    // CLEARED on an already-initial store is a no-op (same reference).
    clearAiOutput();
    expect(notified).toBe(0);
  });
});
