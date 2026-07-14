// "Which heading is at the top of the viewport right now" signal — the reverse
// of `revealHeadingSignal.ts` (outline-scroll-tracking). The focused pane's
// editor computes its topmost visible heading on scroll and publishes it here;
// the panel-level Outline tab (a separate render subtree) reads it to highlight
// the current row and keep it in view.
//
// The payload carries the OWNING note id so a stale value from another pane's
// note is ignored — the Outline tab only reacts when `noteId` matches the note
// it is showing. Headings are keyed by their `from` offset (the dialect's
// `headingSections` UTF-16 position), which the tab's own entries share, so the
// join is exact in steady state (a live buffer that has drifted from disk since
// the last autosave flush simply fails to match for that sub-second window).

import { useSyncExternalStore } from "react";

/** The heading currently at the top of a pane's viewport. */
export interface ActiveHeading {
  /** The note the scrolling pane is showing. */
  readonly noteId: string;
  /** `headingSections` `from` offset of the topmost visible heading. */
  readonly from: number;
}

let current: ActiveHeading | null = null;
const listeners = new Set<() => void>();

/**
 * Publish the focused pane's current top heading (or `null` when the note has no
 * headings). No-ops when unchanged so a stream of scroll frames doesn't churn
 * subscribers.
 */
export function setActiveHeading(next: ActiveHeading | null): void {
  if (current === next) return;
  if (
    current !== null &&
    next !== null &&
    current.noteId === next.noteId &&
    current.from === next.from
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

/** Current value (external-store snapshot). */
export function getActiveHeading(): ActiveHeading | null {
  return current;
}

/** Subscribe to active-heading changes; returns an unsubscribe fn. */
export function subscribeActiveHeading(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the caller when the active heading changes. */
export function useActiveHeading(): ActiveHeading | null {
  return useSyncExternalStore(subscribeActiveHeading, getActiveHeading, getActiveHeading);
}

/** Test-only: reset module state between tests. */
export function __resetActiveHeadingForTest(): void {
  current = null;
  listeners.clear();
}
