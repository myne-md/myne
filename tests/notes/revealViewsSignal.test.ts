// The "reveal Views section" signal store (SYNC-7). Covers monotonic nonce
// bump, subscriber notification, and the one-shot `pending` consume contract —
// the primitive that lets the BottomBar `editor.views-cta` button + `views.show`
// palette action nudge a `ViewsSection` that may not be mounted yet (it mounts
// only after the click expands a collapsed sidebar).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetRevealViewsForTest,
  consumeRevealViews,
  getRevealViewsNonce,
  requestRevealViews,
  subscribeRevealViews,
} from "../../src/notes/views/revealViewsSignal";

afterEach(() => __resetRevealViewsForTest());

describe("revealViewsSignal store", () => {
  it("increments the nonce on each request (monotonic)", () => {
    const before = getRevealViewsNonce();
    requestRevealViews();
    expect(getRevealViewsNonce()).toBe(before + 1);
    requestRevealViews();
    expect(getRevealViewsNonce()).toBe(before + 2);
  });

  it("notifies subscribers synchronously on request", () => {
    const listener = vi.fn();
    subscribeRevealViews(listener);
    requestRevealViews();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("consume returns true exactly once per request", () => {
    expect(consumeRevealViews()).toBe(false); // nothing pending yet
    requestRevealViews();
    expect(consumeRevealViews()).toBe(true); // pending consumed
    expect(consumeRevealViews()).toBe(false); // already consumed
  });

  it("a later request re-arms pending even if a prior one was consumed", () => {
    requestRevealViews();
    expect(consumeRevealViews()).toBe(true);
    requestRevealViews();
    expect(consumeRevealViews()).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRevealViews(listener);
    unsubscribe();
    requestRevealViews();
    expect(listener).not.toHaveBeenCalled();
  });
});
