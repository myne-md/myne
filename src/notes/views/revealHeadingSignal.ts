// "Reveal a heading in the focused pane's editor" signal — the cross-surface
// nudge behind the right-panel Outline tab's heading rows. The Outline tab lives
// at PANEL level (a sibling of the center `PaneTree`), a separate render subtree
// from the `PaneView` that owns the editor + its `setScrollAnchor`, so the two
// can't share React context. Mirrors the external-store shape of
// `revealViewsSignal.ts` / `prefsNonce.ts`, but carries a payload (the heading
// text + an optional pane id).
//
// The consumer (PaneView) self-gates on the monotonic `nonce` — exactly like
// CMEditor's `appliedScrollNonceRef` — and only the FOCUSED pane acts, so a
// stale or non-focused pane never scrolls. Re-clicking the same heading bumps
// the nonce, so the scroll re-fires even when the target text is unchanged.

import { useSyncExternalStore } from "react";

/** A pending "scroll to this heading" request. `paneId` null ≡ the focused pane. */
export interface RevealHeadingRequest {
  readonly paneId: string | null;
  readonly heading: string;
  readonly nonce: number;
}

let request: RevealHeadingRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/**
 * Ask the focused pane's editor to scroll to the first heading whose fold-text
 * matches `heading`. `paneId` may target a specific pane; omit it (the default)
 * to let whichever pane is focused consume the request. Safe to call whether or
 * not any pane is currently mounted.
 */
export function requestRevealHeading(heading: string, paneId: string | null = null): void {
  nonce += 1;
  request = { paneId, heading, nonce };
  for (const listener of listeners) listener();
}

/**
 * Read the current request WITHOUT clearing it (the consumer self-gates on the
 * nonce, like CMEditor's applied-scroll-nonce ref). Returns null when no request
 * has ever been made.
 */
export function peekRevealHeading(): RevealHeadingRequest | null {
  return request;
}

/** Subscribe to reveal-heading requests; returns an unsubscribe fn. */
export function subscribeRevealHeading(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). */
export function getRevealHeadingNonce(): number {
  return nonce;
}

/** Re-renders the caller when a reveal-heading request is made. */
export function useRevealHeadingNonce(): number {
  return useSyncExternalStore(
    subscribeRevealHeading,
    getRevealHeadingNonce,
    getRevealHeadingNonce,
  );
}

/** Test-only: reset module state between tests. */
export function __resetRevealHeadingForTest(): void {
  request = null;
  nonce = 0;
  listeners.clear();
}
