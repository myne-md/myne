// SYNC-5: the vault-wide index-changed nonce store. Covers monotonic bump,
// subscriber notification, microtask coalescing of a synchronous burst, and the
// throttle window that coalesces an AWAIT-SEPARATED series (myne#217).
//
// The last one is the case the microtask alone never covered: the
// rebuild-on-unlock sweep awaits between notes, so every bump landed in its own
// tick and produced its own fan-out. A test that only bumps synchronously
// cannot tell the two designs apart — which is why the old suite passed while
// a cold vault produced one fan-out per note.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetIndexNonceForTest,
  bumpIndexNonce,
  getIndexNonce,
  subscribeIndexNonce,
} from "../../src/notes/indexNonce";

afterEach(() => __resetIndexNonceForTest());

const flushMicrotasks = () => Promise.resolve();

describe("indexNonce store", () => {
  it("increments the nonce immediately on bump (monotonic)", () => {
    const before = getIndexNonce();
    bumpIndexNonce();
    expect(getIndexNonce()).toBe(before + 1);
    bumpIndexNonce();
    expect(getIndexNonce()).toBe(before + 2);
  });

  it("notifies subscribers after a bump", async () => {
    const listener = vi.fn();
    subscribeIndexNonce(listener);
    bumpIndexNonce();
    expect(listener).not.toHaveBeenCalled(); // coalesced onto a microtask
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("coalesces a synchronous burst into a single notify", async () => {
    const listener = vi.fn();
    subscribeIndexNonce(listener);
    bumpIndexNonce();
    bumpIndexNonce();
    bumpIndexNonce();
    await flushMicrotasks();
    // 3 bumps in one tick → 1 notify; the snapshot reflects the final value.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getIndexNonce()).toBe(3);
  });

  it("stops notifying after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeIndexNonce(listener);
    unsubscribe();
    bumpIndexNonce();
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  describe("throttle window (myne#217)", () => {
    afterEach(() => vi.useRealTimers());

    /** Bump the way the unlock sweep does: one per tick, not one per statement. */
    const bumpAwaitSeparated = async (times: number): Promise<void> => {
      for (let i = 0; i < times; i++) {
        bumpIndexNonce();
        await flushMicrotasks();
      }
    };

    it("collapses an await-separated series into one notify per window", async () => {
      vi.useFakeTimers();
      const listener = vi.fn();
      subscribeIndexNonce(listener);

      await bumpAwaitSeparated(50);

      // The first bump led on its microtask; the other 49 folded into the
      // window. Without the throttle this would be 50.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getIndexNonce()).toBe(50);

      await vi.advanceTimersByTimeAsync(250);
      expect(listener).toHaveBeenCalledTimes(2); // one trailing notify for the rest
    });

    it("publishes the latest value on the trailing notify", async () => {
      vi.useFakeTimers();
      let seen = -1;
      subscribeIndexNonce(() => {
        seen = getIndexNonce();
      });

      await bumpAwaitSeparated(5);
      expect(seen).toBe(1); // the leading notify saw the first bump

      await vi.advanceTimersByTimeAsync(250);
      expect(seen).toBe(5); // the trailing one carries the whole burst
    });

    it("keeps notifying across a burst that spans several windows", async () => {
      vi.useFakeTimers();
      const listener = vi.fn();
      subscribeIndexNonce(listener);

      // Three windows' worth of traffic — the tail must not be dropped when a
      // window closes with work still arriving.
      for (let w = 0; w < 3; w++) {
        await bumpAwaitSeparated(3);
        await vi.advanceTimersByTimeAsync(250);
      }

      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(getIndexNonce()).toBe(9);
    });

    it("goes idle after a quiet window, so the next bump leads again", async () => {
      vi.useFakeTimers();
      const listener = vi.fn();
      subscribeIndexNonce(listener);

      bumpIndexNonce();
      await flushMicrotasks();
      expect(listener).toHaveBeenCalledTimes(1);

      // Quiet window closes with nothing owed → no spurious notify.
      await vi.advanceTimersByTimeAsync(250);
      expect(listener).toHaveBeenCalledTimes(1);

      // And the store is idle again: a later bump leads rather than waiting.
      bumpIndexNonce();
      await flushMicrotasks();
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("__resetIndexNonceForTest cancels a pending trailing notify", async () => {
      vi.useFakeTimers();
      const listener = vi.fn();
      subscribeIndexNonce(listener);

      await bumpAwaitSeparated(3);
      listener.mockClear();
      __resetIndexNonceForTest();

      // A timer surviving the reset would fire against the next test's store.
      await vi.advanceTimersByTimeAsync(500);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
