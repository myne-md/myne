import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TAG_SUGGEST_INITIAL,
  clearTagSuggest,
  dispatchTagSuggest,
  getTagSuggest,
  subscribeTagSuggest,
  tagSuggestReducer,
  __resetTagSuggestForTest,
} from "../../src/notes/ai/tagSuggestStore";
import { runTagSuggestToStore } from "../../src/notes/ai/runTagSuggestToStore";
import type { TagSuggestAction } from "../../src/notes/ai/tagSuggestStore";

// auto-tag-link (MYND-411) task 4 — the tag-suggestion render store.
describe("tagSuggestReducer", () => {
  it("THINKING drops stale suggestions", () => {
    const prior = {
      status: "ready" as const,
      suggestions: [{ tag: "old", isNew: true }],
    };
    expect(tagSuggestReducer(prior, { type: "THINKING" })).toEqual({
      status: "thinking",
      suggestions: [],
    });
  });

  it("READY holds the ranked set; FAILED and CLEARED drop it", () => {
    const s = [{ tag: "rust", isNew: true }];
    expect(tagSuggestReducer(TAG_SUGGEST_INITIAL, { type: "READY", suggestions: s })).toEqual({
      status: "ready",
      suggestions: s,
    });
    expect(tagSuggestReducer({ status: "ready", suggestions: s }, { type: "FAILED" })).toEqual({
      status: "error",
      suggestions: [],
    });
    expect(tagSuggestReducer({ status: "ready", suggestions: s }, { type: "CLEARED" })).toEqual(
      TAG_SUGGEST_INITIAL,
    );
  });
});

describe("tagSuggest module store", () => {
  beforeEach(() => __resetTagSuggestForTest());
  afterEach(() => __resetTagSuggestForTest());

  it("dispatch drives state + notifies; clear wipes", () => {
    let n = 0;
    subscribeTagSuggest(() => (n += 1));
    dispatchTagSuggest({ type: "READY", suggestions: [{ tag: "a", isNew: true }] });
    expect(getTagSuggest().status).toBe("ready");
    clearTagSuggest();
    expect(getTagSuggest()).toEqual(TAG_SUGGEST_INITIAL);
    expect(n).toBe(2);
  });
});

describe("runTagSuggestToStore", () => {
  beforeEach(() => __resetTagSuggestForTest());
  afterEach(() => __resetTagSuggestForTest());

  it("dispatches THINKING then READY with the ranked suggestions", async () => {
    const actions: TagSuggestAction[] = [];
    const infer = vi.fn().mockResolvedValue("rust, work");
    await runTagSuggestToStore({
      noteBody: "a note",
      noteFolder: "Notes/",
      existingTags: ["work"],
      excludedFolders: [],
      infer,
      dispatch: (a) => actions.push(a),
    });
    expect(actions[0]).toEqual({ type: "THINKING" });
    expect(actions[1].type).toBe("READY");
    // existing "work" ranks first, "rust" is new
    const ready = actions[1] as { type: "READY"; suggestions: unknown[] };
    expect(ready.suggestions).toEqual([
      { tag: "work", isNew: false },
      { tag: "rust", isNew: true },
    ]);
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it("clears (no chips) and never calls infer for an excluded-folder note", async () => {
    const actions: TagSuggestAction[] = [];
    const infer = vi.fn();
    await runTagSuggestToStore({
      noteBody: "secret",
      noteFolder: "Private/Journal/",
      existingTags: [],
      excludedFolders: ["Private/"],
      infer,
      dispatch: (a) => actions.push(a),
    });
    expect(infer).not.toHaveBeenCalled();
    expect(actions.map((a) => a.type)).toEqual(["THINKING", "CLEARED"]);
  });

  it("dispatches FAILED when the engine errors", async () => {
    const actions: TagSuggestAction[] = [];
    const infer = vi.fn().mockRejectedValue(new Error("down"));
    await runTagSuggestToStore({
      noteBody: "b",
      noteFolder: "Notes/",
      existingTags: [],
      excludedFolders: [],
      infer,
      dispatch: (a) => actions.push(a),
    });
    expect(actions.map((a) => a.type)).toEqual(["THINKING", "FAILED"]);
  });
});
