// Vault-wide "index-changed" nonce (SYNC-5, knowledge-graph-ux). The shared
// refresh signal for reader surfaces: bumped at the SINGLE post-mutation
// chokepoint (`vaultIndicesApply` / `vaultIndicesRemove`, AFTER the index slice
// updates — never before, else a re-query reads stale until the next bump).
//
// Subscribers re-query a CHEAP in-RAM lookup and memoize the result so a
// reference-equal result bails the React render (SYNC-5 condition 2 — a bulk
// fan-out must not produce N visible renders). Notifies are coalesced onto a
// microtask so a synchronous burst collapses to one. (A coarser rAF/rebuild
// batch is a deferred optimization — the reference-equal bail already prevents
// render thrash and the re-query is decrypt-free.)

import { useSyncExternalStore } from "react";

let nonce = 0;
let flushScheduled = false;
const listeners = new Set<() => void>();

/**
 * Advance the index-changed nonce. MUST be called only at the post-mutation
 * chokepoint, after the index slice has updated.
 */
export function bumpIndexNonce(): void {
  nonce += 1;
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    // Reset AFTER notifying: a re-entrant `bumpIndexNonce()` from inside a
    // listener is then absorbed into THIS flush (the latest nonce is already
    // observable via getIndexNonce) instead of scheduling a second microtask —
    // preserving the SYNC-5 "synchronous burst collapses to one" invariant.
    for (const listener of listeners) listener();
    flushScheduled = false;
  });
}

/** Subscribe to nonce advances; returns an unsubscribe fn. */
export function subscribeIndexNonce(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). */
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

/** Test-only: reset module state between tests. */
export function __resetIndexNonceForTest(): void {
  nonce = 0;
  flushScheduled = false;
  listeners.clear();
}
