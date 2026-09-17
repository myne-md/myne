// The "reveal a task line in the editor" signal store (myne-md/myne#656).
// Covers the monotonic nonce bump, the peek contract (latest request wins, and
// a line that has SHIFTED is still matchable by its raw text), subscriber
// notification, and the test reset - the primitive that lets both task lists
// nudge a `PaneView` that shares no React context with them.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetRevealTaskForTest,
  getRevealTaskNonce,
  peekRevealTask,
  requestRevealTask,
  subscribeRevealTask,
} from "../../src/notes/views/revealTaskSignal";

afterEach(() => __resetRevealTaskForTest());

describe("revealTaskSignal store", () => {
  it("starts empty with a zero nonce", () => {
    expect(peekRevealTask()).toBeNull();
    expect(getRevealTaskNonce()).toBe(0);
  });

  it("publishes the request and bumps the nonce monotonically", () => {
    requestRevealTask("n1", 3, "- [ ] pay the rent");
    expect(peekRevealTask()).toEqual({ noteId: "n1", line: 3, text: "- [ ] pay the rent", nonce: 1 });
    expect(getRevealTaskNonce()).toBe(1);
    requestRevealTask("n2", 0, "- [ ] water the plants");
    expect(peekRevealTask()).toEqual({ noteId: "n2", line: 0, text: "- [ ] water the plants", nonce: 2 });
    expect(getRevealTaskNonce()).toBe(2);
  });

  it("notifies subscribers synchronously on request", () => {
    const listener = vi.fn();
    subscribeRevealTask(listener);
    requestRevealTask("n1", 3, "- [ ] pay the rent");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRevealTask(listener);
    unsubscribe();
    requestRevealTask("n1", 3, "- [ ] pay the rent");
    expect(listener).not.toHaveBeenCalled();
  });

  it("the reset helper clears the request, the nonce and the listeners", () => {
    const listener = vi.fn();
    subscribeRevealTask(listener);
    requestRevealTask("n1", 3, "- [ ] pay the rent");
    __resetRevealTaskForTest();
    expect(peekRevealTask()).toBeNull();
    expect(getRevealTaskNonce()).toBe(0);
    requestRevealTask("n1", 3, "- [ ] pay the rent");
    // The pre-reset subscription is gone: still exactly the one pre-reset call.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
