// SYNC-5: the vault-wide index-changed nonce store. Covers monotonic bump,
// subscriber notification, and microtask coalescing of a synchronous burst.

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
});
