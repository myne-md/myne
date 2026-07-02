// Ephemeral AI-output render store (note-summarization MYND-409 task 4).
//
// The single RAM home for a rendered AI result (a summary today; Q&A answers
// later) that the AI Chat tab (ai-ux-surface MYND-408) displays. The output is
// an **AS1-class RAM artifact**: held only here, never persisted, and dropped on
// lock / open-note teardown (best-effort V8 string drop — the find-bar
// match-cache posture, SYNC-8). A module-level store (not component state) so
// the summarize command handler can drive it (`THINKING` before the blocking
// `infer`, `RESOLVED` after) while the AI Chat tab subscribes and renders — but
// that means teardown is **explicit**: the note-close / lock path calls
// `clearAiOutput()` (a module store survives an Editor unmount on its own).
//
// No plaintext is logged here; the output text is the model's own words, an
// AS1 artifact (never a note body, but same drop-on-lock discipline).

import { useSyncExternalStore } from "react";

/** Lifecycle status of the rendered AI output. */
export type AiOutputStatus = "idle" | "thinking" | "ready" | "error";

export interface AiOutputState {
  status: AiOutputStatus;
  /** The rendered output text. `null` unless `status === "ready"` — a new run
   *  or a teardown drops the reference (best-effort AS1 wipe). */
  text: string | null;
  /** Task-2 truncation notice: the model saw only the first N characters. */
  truncated: boolean;
  /** How many characters were summarized when `truncated` (task 2). */
  summarizedChars: number;
}

export const AI_OUTPUT_INITIAL: AiOutputState = {
  status: "idle",
  text: null,
  truncated: false,
  summarizedChars: 0,
};

export type AiOutputAction =
  | { type: "THINKING" }
  | {
      type: "RESOLVED";
      text: string;
      truncated: boolean;
      summarizedChars: number;
    }
  | { type: "FAILED" }
  | { type: "CLEARED" };

/**
 * Pure state transition. `THINKING` drops any prior text (a new run never shows
 * stale output), `RESOLVED` holds the result + truncation notice, `FAILED` and
 * `CLEARED` both drop the text reference — `CLEARED` is the lock/teardown wipe.
 */
export function aiOutputReducer(
  state: AiOutputState,
  action: AiOutputAction,
): AiOutputState {
  switch (action.type) {
    case "THINKING":
      return { status: "thinking", text: null, truncated: false, summarizedChars: 0 };
    case "RESOLVED":
      return {
        status: "ready",
        text: action.text,
        truncated: action.truncated,
        summarizedChars: action.summarizedChars,
      };
    case "FAILED":
      return { status: "error", text: null, truncated: false, summarizedChars: 0 };
    case "CLEARED":
      return AI_OUTPUT_INITIAL;
    default:
      return state;
  }
}

// ---- module-level store (drives command → render, cleared explicitly) -------

let current: AiOutputState = AI_OUTPUT_INITIAL;
const listeners = new Set<() => void>();

// Monotonic run epoch. A summarize/ask run captures the epoch when it starts and
// only applies its terminal result if the epoch is unchanged — so a slow run
// whose note the user switched away from (or that was superseded by a newer run,
// or a vault lock) can never render or be inserted into the WRONG note, and two
// overlapping runs can never resolve out of order. `beginAiRunEpoch` bumps it;
// `clearAiOutput` and starting a new run both invalidate any in-flight run.
let runEpoch = 0;

/** Start a new run: invalidate any in-flight run and return this run's token. */
export function beginAiRunEpoch(): number {
  runEpoch += 1;
  return runEpoch;
}

/** Whether `token` is still the active run (no newer run / clear / lock since). */
export function isAiRunCurrent(token: number): boolean {
  return token === runEpoch;
}

/** Current store snapshot (referentially stable until a dispatch). */
export function getAiOutput(): AiOutputState {
  return current;
}

/** Apply an action + notify subscribers. */
export function dispatchAiOutput(action: AiOutputAction): void {
  const next = aiOutputReducer(current, action);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Drop the rendered output — the lock / open-note / note-switch teardown wipe
 *  (SYNC-8). Bumps the run epoch so any in-flight run's result is dropped rather
 *  than rendered against the wrong note. */
export function clearAiOutput(): void {
  runEpoch += 1;
  dispatchAiOutput({ type: "CLEARED" });
}

/** Subscribe to store changes; returns an unsubscribe. */
export function subscribeAiOutput(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so a store built at module scope doesn't leak across tests. */
export function __resetAiOutputForTest(): void {
  current = AI_OUTPUT_INITIAL;
  listeners.clear();
  runEpoch = 0;
}

/** React binding: the live AI-output state, re-rendering on every dispatch. */
export function useAiOutput(): AiOutputState {
  return useSyncExternalStore(subscribeAiOutput, getAiOutput, getAiOutput);
}
