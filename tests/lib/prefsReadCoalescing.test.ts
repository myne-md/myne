// A prefs-nonce bump must cost ONE backend read, not one per subscriber.
// myne-md/myne#556.
//
// # The defect this is written against, measured in a browser
//
// Every mounted `usePrefs` subscribes to the prefs nonce, and a bump notifies
// all of them in one synchronous loop — so a single Settings change made
// fourteen instances call `prefsRead()` in the same tick, each a full backend
// round-trip for the same bytes. Most of those concurrent reads FAILED, with
// `Io`. Instrumenting `prefsRead` itself and adding no traffic of its own, on
// one write:
//
//     read-ok als=60   x6      <- six instances reloaded and got the new value
//     read-fail Io     x10     <- and the rest did not
//     read-ok als=60   x1
//     read-fail Io     x8
//
// `usePrefs`'s `reload` catches and keeps the current cache ("safer state per
// spec 9.5.5"), so every instance that lost the race stayed on DEFAULT_PREFS,
// silently, for the rest of the session — and which ones lost varied per run.
// The case that surfaced it: `Editor.tsx`'s instance kept
// `auto_lock_seconds: null`, so `useIdleAutoLock` never armed and the vault
// never auto-locked, while Settings showed the timeout the user had chosen.
//
// # What is asserted here, and what is deliberately elsewhere
//
// This pins the COALESCING — one round-trip per nonce, a fresh one after a
// bump, and no sharing across a bump. Whether the backend can serve fourteen
// concurrent reads is a different question and not this file's; the point of
// the fix is that it is never asked to.
//
// The browser half stays in `e2e-web/auto-lock-hidden-tab.e2e.ts`, which is
// where the failure was observable in the first place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** How many times the IPC layer was actually called. */
let calls = 0;
/** Resolvers for the in-flight invokes, so a test can hold them open. */
let pending: Array<(v: unknown) => void> = [];

vi.mock("../../src/platform/core", () => ({
  invoke: (_command: string) => {
    calls += 1;
    return new Promise((resolve) => pending.push(resolve));
  },
}));

import { prefsRead, __resetPrefsReadForTest } from "../../src/lib/prefs";
import { __resetPrefsNonceForTest, bumpPrefsNonce } from "../../src/notes/prefsNonce";

/** Settle every invoke currently in flight with `view`. */
function settleAll(view: unknown): void {
  const waiting = pending;
  pending = [];
  for (const resolve of waiting) resolve(view);
}

describe("prefsRead coalescing (myne-md/myne#556)", () => {
  beforeEach(() => {
    calls = 0;
    pending = [];
    __resetPrefsReadForTest();
    __resetPrefsNonceForTest();
  });

  afterEach(() => {
    settleAll({});
  });

  it("serves a burst of concurrent readers from ONE round-trip", async () => {
    // Fourteen, because that is what the browser measured — a real session's
    // mounted `usePrefs` count, not a round number.
    const readers = Array.from({ length: 14 }, () => prefsRead());
    expect(
      calls,
      `${calls} backend reads were issued for one burst of 14 concurrent callers. ` +
        `That is the thundering herd this fix exists to remove: fourteen full ` +
        `round-trips for the same bytes, most of which failed with Io, each failure ` +
        `silently leaving one usePrefs instance on DEFAULT_PREFS for the session.`,
    ).toBe(1);

    settleAll({ auto_lock_seconds: 60 });
    const views = await Promise.all(readers);
    for (const view of views) {
      expect(
        (view as { auto_lock_seconds?: unknown }).auto_lock_seconds,
        "a shared reader got something other than the one response, so the " +
          "coalescing is handing back the wrong bytes",
      ).toBe(60);
    }
  });

  it("does NOT share across a nonce bump", async () => {
    // The correctness half. Sharing on time alone would hand a caller that
    // arrived AFTER a write the bytes from before it — and the nonce is exactly
    // the "something changed" signal, so a caller at a higher nonce must read
    // again.
    const before = prefsRead();
    expect(calls).toBe(1);

    bumpPrefsNonce();

    const after = prefsRead();
    expect(
      calls,
      "a reader that arrived after a nonce bump was served the read that started " +
        "BEFORE it. That read cannot carry the write the bump is announcing, so " +
        "the subscriber would apply pre-write bytes and never learn otherwise — " +
        "which is a staler failure than the one this coalescing fixes.",
    ).toBe(2);

    settleAll({ auto_lock_seconds: 60 });
    await Promise.all([before, after]);
  });

  it("starts fresh once a read has settled", async () => {
    const first = prefsRead();
    settleAll({ auto_lock_seconds: null });
    await first;

    // Same nonce, but nothing is in flight any more: a later caller must get a
    // real read rather than a cached promise. This is what keeps the coalescing
    // a de-duplicator and not a cache — `prefsRead` has no invalidation and must
    // never behave as though it did.
    const second = prefsRead();
    expect(
      calls,
      "a caller after the shared read had already settled was handed the settled " +
        "promise again. That turns this into an unbounded cache of the first " +
        "answer, which is worse than the herd it replaced.",
    ).toBe(2);
    settleAll({ auto_lock_seconds: 60 });
    await second;
  });
});
