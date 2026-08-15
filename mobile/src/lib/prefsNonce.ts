// Vault-prefs "changed" nonce — the shared refresh signal for `usePrefs`
// consumers across sibling surfaces (Saved Views #4 follow-up). `usePrefs` is
// modal-scoped local state (no shared store), so a saved-view mutation made
// through ONE surface (e.g. the Tag browser's "Save as view") left the sidebar's
// own `usePrefs` instance stale until a remount. Mirrors `indexNonce.ts` (SYNC-5):
// bumped at the SINGLE post-mutation chokepoint (the saved-view prefs writers,
// AFTER the IPC resolves — never before, else a re-read pulls stale disk truth).
//
// Subscribers re-read `vault.prefs` (a cheap decrypt of a small blob) and the
// hook stabilizes via setState; notifies are coalesced onto a microtask so a
// synchronous burst collapses to one.

import { useSyncExternalStore } from "react";

let nonce = 0;
let flushScheduled = false;
let batchDepth = 0;
// Increments that have happened and have NOT been published. Held rather than
// applied because `getPrefsNonce` is `useSyncExternalStore`'s `getSnapshot`, and
// that contract requires the snapshot to change only when the subscription
// fires. Incrementing without notifying satisfies the letter of "monotonic" and
// breaks the store: React re-reads the snapshot on EVERY re-render, so a
// component re-rendering mid-batch for an unrelated reason would see the new
// value and run exactly the read the batch exists to avoid.
let pendingBumps = 0;
let batchWatchdog: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/**
 * How long a batch may hold the notify before the module stops waiting for it.
 *
 * The suppression is module-wide, not per-action: while a batch is open, a
 * write made anywhere else in the app has its notify deferred too. That is
 * bounded and harmless in the normal case, because subscribers re-read disk
 * truth rather than applying a diff, so the one notify at the end carries the
 * concurrent write as well. What is NOT acceptable is an unbounded wait: if a
 * batched write hangs rather than resolving or rejecting, `batchDepth` would
 * never return to zero and every prefs notify for the rest of the session would
 * be swallowed, leaving surfaces on stale values with nothing to recover them.
 * Five seconds is far longer than any prefs round-trip and far shorter than a
 * session.
 */
const BATCH_NOTIFY_CEILING_MS = 5000;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    // Reset AFTER notifying: a re-entrant `bumpPrefsNonce()` from inside a
    // listener is then absorbed into THIS flush (the latest nonce is already
    // observable via getPrefsNonce) instead of scheduling a second microtask,
    // preserving the "synchronous burst collapses to one" invariant.
    for (const listener of listeners) listener();
    flushScheduled = false;
  });
}

/**
 * Advance the prefs-changed nonce. MUST be called only at the post-mutation
 * chokepoint, after the prefs write has resolved.
 */
export function bumpPrefsNonce(): void {
  if (batchDepth > 0) {
    pendingBumps += 1;
    return;
  }
  nonce += 1;
  scheduleFlush();
}

/**
 * Run a multi-write user action as ONE nonce advance.
 *
 * The microtask coalescing above only collapses a SYNCHRONOUS burst. A user
 * action that awaits between writes gets one flush per write, and each flush
 * re-runs the `[load, nonce]` effect in every mounted `usePrefs`, where a read
 * is a full backend round-trip: read `vault.meta`, derive the prefs subkey,
 * decrypt `vault.prefs`, deserialize. A folder rename writes
 * `deliberate_folders`, `archived_folders`, `item_colors` and `folder_icons`
 * in sequence, so it cost up to four advances times the number of mounted
 * hooks, and the newest read discards the rest after paying for them.
 *
 * The counter is held with the notify, not advanced behind it, because
 * `getPrefsNonce` is `useSyncExternalStore`'s `getSnapshot` and that contract
 * requires the snapshot to change only when the subscription fires. At the end
 * of the batch it moves once, by everything the batch wrote, so it stays
 * monotonic and a subscriber never observes a value that skipped a change: it
 * re-reads disk truth, which already carries every write in between. Nested
 * calls are counted, and a throw inside `fn` still publishes whatever landed
 * before it.
 *
 * **The suppression is module-wide, not per-action.** While a batch is open, a
 * write made anywhere else in the app has its notify deferred to the same end
 * point. Nothing is lost: subscribers re-read disk truth rather than applying a
 * diff, so the single notify carries the concurrent write too. What the
 * `BATCH_NOTIFY_CEILING_MS` watchdog bounds is the WAIT, so a batched write that
 * hangs instead of settling cannot swallow notifications for the rest of the
 * session.
 *
 * The batch is a display concern only. A prefs command applies its own
 * host-side effect before it returns (screen-capture protection, for one, is
 * applied inside the command at `core/src/plugins/prefs/commands.rs`), so
 * deferring the notify never defers enforcement.
 */
export async function withPrefsBatch<T>(fn: () => Promise<T>): Promise<T> {
  openBatch();
  try {
    return await fn();
  } finally {
    closeBatch();
  }
}

function openBatch(): void {
  batchDepth += 1;
  if (batchDepth > 1) return;
  batchWatchdog = setTimeout(() => {
    // The batch did not close. Stop waiting for it rather than swallowing every
    // prefs notify for the rest of the session: `batchDepth` is zeroed here, so
    // the pending `closeBatch` calls become no-ops and suppression ends now.
    batchWatchdog = null;
    batchDepth = 0;
    flushBatched();
  }, BATCH_NOTIFY_CEILING_MS);
}

function closeBatch(): void {
  if (batchDepth === 0) return; // the watchdog already ended this batch
  batchDepth -= 1;
  if (batchDepth > 0) return;
  if (batchWatchdog !== null) {
    clearTimeout(batchWatchdog);
    batchWatchdog = null;
  }
  flushBatched();
}

function flushBatched(): void {
  if (pendingBumps === 0) return;
  // Published as one step, so the snapshot moves exactly once and moves by
  // everything the batch wrote. It is still monotonic and it still never skips:
  // a subscriber goes from the pre-batch value to the post-batch value and
  // re-reads disk truth, which carries every write in between.
  nonce += pendingBumps;
  pendingBumps = 0;
  scheduleFlush();
}

/** Subscribe to nonce advances; returns an unsubscribe fn. */
export function subscribePrefsNonce(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). */
export function getPrefsNonce(): number {
  return nonce;
}

/** Re-renders the caller when the prefs-changed nonce advances. */
export function usePrefsNonce(): number {
  return useSyncExternalStore(subscribePrefsNonce, getPrefsNonce, getPrefsNonce);
}

/** Test-only: reset module state between tests. */
export function __resetPrefsNonceForTest(): void {
  nonce = 0;
  flushScheduled = false;
  batchDepth = 0;
  pendingBumps = 0;
  if (batchWatchdog !== null) {
    clearTimeout(batchWatchdog);
    batchWatchdog = null;
  }
  listeners.clear();
}
