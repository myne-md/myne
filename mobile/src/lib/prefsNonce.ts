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
let bumpedWhileBatched = false;
const listeners = new Set<() => void>();

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
  nonce += 1;
  if (batchDepth > 0) {
    bumpedWhileBatched = true;
    return;
  }
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
 * The nonce still increments per write, so it stays monotonic and no subscriber
 * can observe a value that skipped a change. Only the NOTIFY is deferred, once,
 * to the end. Nested calls are counted, and a throw inside `fn` still flushes
 * whatever landed before it.
 */
export async function withPrefsBatch<T>(fn: () => Promise<T>): Promise<T> {
  batchDepth += 1;
  try {
    return await fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && bumpedWhileBatched) {
      bumpedWhileBatched = false;
      scheduleFlush();
    }
  }
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
  bumpedWhileBatched = false;
  listeners.clear();
}
