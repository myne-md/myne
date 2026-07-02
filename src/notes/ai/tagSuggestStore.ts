// Ephemeral tag-suggestion render store (auto-tag-link MYND-411 task 4).
//
// The RAM home for a ranked `TagSuggestion[]` the AI Chat tab renders as chips.
// Same AS1-class-RAM discipline as `aiOutputStore`: a module-level store (so the
// suggest command drives it while the tab subscribes) that is **dropped on lock
// / open-note teardown** via the explicit `clearTagSuggest()` the editor host
// wires. Nothing is persisted; the suggestions are model-derived, dropped on the
// same teardown as the summary output.

import { useSyncExternalStore } from "react";

import type { TagSuggestion } from "./tagRanker";

export type TagSuggestStatus = "idle" | "thinking" | "ready" | "error";

export interface TagSuggestState {
  status: TagSuggestStatus;
  suggestions: readonly TagSuggestion[];
}

export const TAG_SUGGEST_INITIAL: TagSuggestState = {
  status: "idle",
  suggestions: [],
};

export type TagSuggestAction =
  | { type: "THINKING" }
  | { type: "READY"; suggestions: readonly TagSuggestion[] }
  | { type: "FAILED" }
  | { type: "CLEARED" };

/** Pure transition. `THINKING` drops stale suggestions; `READY` holds the ranked
 *  set; `FAILED`/`CLEARED` drop them (teardown wipe). */
export function tagSuggestReducer(
  state: TagSuggestState,
  action: TagSuggestAction,
): TagSuggestState {
  switch (action.type) {
    case "THINKING":
      return { status: "thinking", suggestions: [] };
    case "READY":
      return { status: "ready", suggestions: action.suggestions };
    case "FAILED":
      return { status: "error", suggestions: [] };
    case "CLEARED":
      return TAG_SUGGEST_INITIAL;
    default:
      return state;
  }
}

let current: TagSuggestState = TAG_SUGGEST_INITIAL;
const listeners = new Set<() => void>();

// Run epoch (see aiOutputStore): a suggest run only applies its result if the
// epoch is unchanged, so a slow run whose note the user switched away from — or
// that a lock / newer run superseded — never renders chips for (or applies tags
// to) the WRONG note.
let runEpoch = 0;

/** Start a new run: invalidate any in-flight run and return this run's token. */
export function beginTagRunEpoch(): number {
  runEpoch += 1;
  return runEpoch;
}

/** Whether `token` is still the active run (no newer run / clear / lock since). */
export function isTagRunCurrent(token: number): boolean {
  return token === runEpoch;
}

export function getTagSuggest(): TagSuggestState {
  return current;
}

export function dispatchTagSuggest(action: TagSuggestAction): void {
  const next = tagSuggestReducer(current, action);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

/** Drop the rendered suggestions — the lock / open-note / note-switch teardown
 *  wipe (SYNC-8). Bumps the run epoch so an in-flight run's result is dropped. */
export function clearTagSuggest(): void {
  runEpoch += 1;
  dispatchTagSuggest({ type: "CLEARED" });
}

export function subscribeTagSuggest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only reset so a module-scope store doesn't leak across tests. */
export function __resetTagSuggestForTest(): void {
  current = TAG_SUGGEST_INITIAL;
  listeners.clear();
  runEpoch = 0;
}

/** React binding: the live tag-suggestion state, re-rendering on every dispatch. */
export function useTagSuggest(): TagSuggestState {
  return useSyncExternalStore(subscribeTagSuggest, getTagSuggest, getTagSuggest);
}
