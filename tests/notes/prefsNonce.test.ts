// The vault-prefs-changed nonce store (Saved Views #4 follow-up). Covers
// monotonic bump, subscriber notification, and microtask coalescing of a
// synchronous burst — the cross-surface refresh primitive `usePrefs` subscribes
// to so a saved-view mutation made through one surface refreshes the others.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetPrefsNonceForTest,
  bumpPrefsNonce,
  getPrefsNonce,
  subscribePrefsNonce,
} from "../../src/notes/prefsNonce";

afterEach(() => __resetPrefsNonceForTest());

const flushMicrotasks = () => Promise.resolve();

describe("prefsNonce store", () => {
  it("increments the nonce immediately on bump (monotonic)", () => {
    const before = getPrefsNonce();
    bumpPrefsNonce();
    expect(getPrefsNonce()).toBe(before + 1);
    bumpPrefsNonce();
    expect(getPrefsNonce()).toBe(before + 2);
  });

  it("notifies subscribers after a bump", async () => {
    const listener = vi.fn();
    subscribePrefsNonce(listener);
    bumpPrefsNonce();
    expect(listener).not.toHaveBeenCalled(); // coalesced onto a microtask
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("coalesces a synchronous burst into a single notify", async () => {
    const listener = vi.fn();
    subscribePrefsNonce(listener);
    bumpPrefsNonce();
    bumpPrefsNonce();
    bumpPrefsNonce();
    await flushMicrotasks();
    // 3 bumps in one tick → 1 notify; the snapshot reflects the final value.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPrefsNonce()).toBe(3);
  });

  it("stops notifying after unsubscribe", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePrefsNonce(listener);
    unsubscribe();
    bumpPrefsNonce();
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });
});
