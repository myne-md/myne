// Vault-wide "index-changed" nonce (SYNC-5, knowledge-graph-ux). The shared
// refresh signal for reader surfaces: bumped at the SINGLE post-mutation
// chokepoint (`vaultIndicesApply` / `vaultIndicesRemove`, AFTER the index slice
// updates — never before, else a re-query reads stale until the next bump).
//
// Subscribers re-query a CHEAP in-RAM lookup and memoize the result so a
// reference-equal result bails the React render (SYNC-5 condition 2 — a bulk
// fan-out must not produce N visible renders).
//
// # Why notifies are THROTTLED rather than coalesced onto a microtask
//
// They used to be, and the comment here claimed a microtask "collapses a
// synchronous burst into one". That is true and it was also beside the point:
// the loop that produces the bulk of the bumps is not synchronous. The
// rebuild-on-unlock sweep is `for (const id of stale) await reindexNote(id)`
// (`vaultIndices.ts`), and every `await` drains the microtask queue — so each
// note got its own flush, and a cold 442-note vault produced 442 fan-outs, each
// waking every subscriber. The mechanism was real; the shape of its caller
// simply never matched it (myne#217).
//
// So the microtask hop STAYS — it is what makes a synchronous burst one notify,
// and dropping it would have turned such a burst into two (a leading notify plus
// a trailing one). A throttle window is layered on top of it:
//
//   - the first bump of an idle store notifies on the microtask, as before;
//   - that opens a window, and every bump inside it folds into ONE trailing
//     notify when the window expires.
//
// A synchronous burst therefore still costs one notify, and the sweep costs one
// notify per window instead of one per note — while surfaces still fill in
// PROGRESSIVELY as it runs. Collapsing the whole sweep into a single flush at
// the end would have been simpler and worse: it would leave the backlink and
// outline panes blank for the length of the sweep.
//
// `getIndexNonce()` is advanced synchronously on every bump regardless — only
// the notification is throttled — so a `useSyncExternalStore` consumer that
// re-renders for an unrelated reason always reads the current value.

import { useSyncExternalStore } from "react";

/** Throttle window for subscriber notification. Long enough that a bulk sweep
 *  collapses into a handful of fan-outs, short enough that a surface refreshing
 *  after someone else's edit still feels immediate. */
const NOTIFY_WINDOW_MS = 200;

let nonce = 0;
/** Set while a window is open. `null` when idle — the next bump opens one. */
let windowTimer: ReturnType<typeof setTimeout> | null = null;
/** A bump arrived inside the open window, so a trailing notify is owed. */
let trailingPending = false;
/** A leading notify is already queued on the microtask for this tick. */
let leadingScheduled = false;
const listeners = new Set<() => void>();

function notifyNow(): void {
  for (const listener of listeners) listener();
}

/** Open (or re-open) the throttle window. On expiry, fire the trailing notify
 *  if one is owed and keep the window open — a burst that spans several windows
 *  must not drop its tail by closing early. */
function openWindow(): void {
  windowTimer = setTimeout(() => {
    windowTimer = null;
    if (!trailingPending) return; // quiet window → go idle, next bump leads
    trailingPending = false;
    notifyNow();
    openWindow();
  }, NOTIFY_WINDOW_MS);
}

/**
 * Advance the index-changed nonce. MUST be called only at the post-mutation
 * chokepoint, after the index slice has updated.
 */
export function bumpIndexNonce(): void {
  nonce += 1;
  if (windowTimer !== null) {
    // Inside an open window — fold into the trailing notify.
    trailingPending = true;
    return;
  }
  if (leadingScheduled) return; // same tick, already queued
  leadingScheduled = true;
  queueMicrotask(() => {
    leadingScheduled = false;
    notifyNow();
    openWindow();
  });
}

/** Subscribe to nonce advances; returns an unsubscribe fn. */
export function subscribeIndexNonce(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). Always up to date — the throttle delays
 *  notification, never the value. */
export function getIndexNonce(): number {
  return nonce;
}

/** Re-renders the caller when the index-changed nonce advances. */
export function useIndexNonce(): number {
  return useSyncExternalStore(
    subscribeIndexNonce,
    getIndexNonce,
    getIndexNonce,
  );
}

/** Test-only: reset module state between tests. Cancels a pending trailing
 *  notify too — a timer surviving into the next test would fire against its
 *  listeners. */
export function __resetIndexNonceForTest(): void {
  if (windowTimer !== null) clearTimeout(windowTimer);
  windowTimer = null;
  trailingPending = false;
  leadingScheduled = false;
  nonce = 0;
  listeners.clear();
}
