// "Open a note and scroll to the search query's match" signal (MYND-448b) — the
// search-result twin of `revealHeadingSignal`. The command palette lives in a
// separate render subtree from the `PaneView` that owns the editor + its
// `setScrollAnchor`, so it emits the intent through this module-level store; the
// FOCUSED pane converts it into the SAME `scrollAnchor` a wikilink chip or the
// Outline tab uses — here with a `{ query }` anchor, which the editor resolves to
// the earliest literal term match and SELECTS (MYND-448 D3/D4).
//
// Self-gated on the monotonic `nonce` (like `revealHeadingSignal` / CMEditor's
// applied-scroll-nonce): the pane only acts once its `activeId` matches the
// request's `noteId` (the note has finished opening), and re-clicking the same
// result re-fires because the nonce bumps.

import { useSyncExternalStore } from "react";

/** A pending "scroll to this query's match in this note" request. */
export interface RevealMatchRequest {
  readonly noteId: string;
  readonly query: string;
  readonly nonce: number;
}

let request: RevealMatchRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/**
 * Ask the pane showing `noteId` to scroll to the first literal occurrence of
 * `query` and select it. Fired by the command palette right after it opens the
 * note; safe whether or not the target pane has finished opening it yet.
 */
export function requestRevealMatch(noteId: string, query: string): void {
  nonce += 1;
  request = { noteId, query, nonce };
  for (const listener of listeners) listener();
}

/** Read the current request WITHOUT clearing it (consumer self-gates on nonce). */
export function peekRevealMatch(): RevealMatchRequest | null {
  return request;
}

/** Subscribe to reveal-match requests; returns an unsubscribe fn. */
export function subscribeRevealMatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current nonce value (monotonic). */
export function getRevealMatchNonce(): number {
  return nonce;
}

/** Re-renders the caller when a reveal-match request is made. */
export function useRevealMatchNonce(): number {
  return useSyncExternalStore(subscribeRevealMatch, getRevealMatchNonce, getRevealMatchNonce);
}

/** Test-only: reset module state between tests. */
export function __resetRevealMatchForTest(): void {
  request = null;
  nonce = 0;
  listeners.clear();
}
