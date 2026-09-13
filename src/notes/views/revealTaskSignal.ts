// "Reveal a task line in a note's editor" signal (myne-md/myne#656 review).
//
// Both task lists (the vault-wide tab and the note-scoped right panel) live in
// render subtrees that cannot share React context with the `PaneView` that owns
// the editor, so a click crosses via a module-level external store, exactly like
// `revealHeadingSignal.ts` / `revealMatchSignal.ts`.
//
// The consumer (PaneView) self-gates on the monotonic `nonce` and only the
// FOCUSED pane acts. A click first opens/reveals the note through the workspace,
// then bumps the nonce; the pane's effect re-runs once the note body is the
// active one and scrolls to the task's line.

import { useSyncExternalStore } from "react";

/**
 * A pending "scroll to this task line" request. `line` is 0-based, and `text`
 * is the task's raw line — the editor matches on it so a line that has SHIFTED
 * (or a body that has not finished loading) still lands correctly.
 */
export interface RevealTaskRequest {
  readonly noteId: string;
  readonly line: number;
  readonly text: string;
  readonly nonce: number;
}

let request: RevealTaskRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/** Ask the pane showing `noteId` to scroll to the task on `line`. */
export function requestRevealTask(noteId: string, line: number, text: string): void {
  nonce += 1;
  request = { noteId, line, text, nonce };
  for (const listener of listeners) listener();
}

/** Read the current request WITHOUT clearing it. */
export function peekRevealTask(): RevealTaskRequest | null {
  return request;
}

export function subscribeRevealTask(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRevealTaskNonce(): number {
  return nonce;
}

/** Re-renders the caller when a reveal-task request is made. */
export function useRevealTaskNonce(): number {
  return useSyncExternalStore(subscribeRevealTask, getRevealTaskNonce, getRevealTaskNonce);
}

/** Test-only: reset module state between tests. */
export function __resetRevealTaskForTest(): void {
  request = null;
  nonce = 0;
  listeners.clear();
}
