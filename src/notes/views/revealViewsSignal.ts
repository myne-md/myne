// "Reveal the Views section" signal — the cross-surface nudge behind the
// BottomBar `editor.views-cta` button + the `views.show` palette action (SYNC-7).
// The Views section lives in the left (notes) sidebar, a separate render subtree
// from the BottomBar that triggers it, so the two can't share React context.
// Mirrors the external-store shape of `prefsNonce.ts`.
//
// Two parts travel together: a monotonic `nonce` (so an already-mounted
// `ViewsSection` re-runs its reveal effect) and a one-shot `pending` flag (so a
// `ViewsSection` that mounts AFTER the request — because the click first had to
// expand a collapsed sidebar — still picks the request up on mount). The
// consumer clears `pending` exactly once; an ordinary sidebar open (not via the
// button) leaves `pending` false, so it stays inert.

import { useSyncExternalStore } from "react";

let nonce = 0;
let pending = false;
const listeners = new Set<() => void>();

/**
 * Ask the Views section to reveal itself (scroll into view + brief highlight).
 * Safe to call whether or not the section is currently mounted.
 */
export function requestRevealViews(): void {
  pending = true;
  nonce += 1;
  for (const listener of listeners) listener();
}

/**
 * Consume a pending reveal request, returning whether one was outstanding.
 * Returns true at most once per `requestRevealViews()`.
 */
export function consumeRevealViews(): boolean {
  if (!pending) return false;
  pending = false;
  return true;
}

/** Subscribe to reveal requests; returns an unsubscribe fn. */
export function subscribeRevealViews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). */
export function getRevealViewsNonce(): number {
  return nonce;
}

/** Re-renders the caller when a reveal is requested. */
export function useRevealViewsNonce(): number {
  return useSyncExternalStore(
    subscribeRevealViews,
    getRevealViewsNonce,
    getRevealViewsNonce,
  );
}

/** Test-only: reset module state between tests. */
export function __resetRevealViewsForTest(): void {
  nonce = 0;
  pending = false;
  listeners.clear();
}
