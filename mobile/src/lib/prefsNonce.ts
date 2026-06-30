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
const listeners = new Set<() => void>();

/**
 * Advance the prefs-changed nonce. MUST be called only at the post-mutation
 * chokepoint, after the prefs write has resolved.
 */
export function bumpPrefsNonce(): void {
  nonce += 1;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    // Reset AFTER notifying: a re-entrant `bumpPrefsNonce()` from inside a
    // listener is then absorbed into THIS flush (the latest nonce is already
    // observable via getPrefsNonce) instead of scheduling a second microtask —
    // preserving the "synchronous burst collapses to one" invariant.
    for (const listener of listeners) listener();
    flushScheduled = false;
  });
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
  listeners.clear();
}
