// Which registry commands this session has run, newest first (myne-md/myne#772).
//
// The new-tab surface mixes recent notes with recent commands, so a person who
// opens the graph every morning finds it one click from an empty tab. Notes
// carry their own recency (`updatedAt`); commands had none, so this is it.
//
// Session-only on purpose. A command id is not vault content, but a persisted
// list would still be a record of what someone does in the app, written in
// plaintext beside an encrypted vault, and the surface it feeds is useful
// without surviving a restart. Recorded by the three paths that RUN a command:
// the palette, the keybind dispatcher, and the `ribbonCommands` bridge (which
// the new tab itself goes through), so every entry point counts once.

import { useSyncExternalStore } from "react";

export type CommandRun = { id: string; at: number };

/** Enough for any surface that reads it; older runs fall off the end. */
export const COMMAND_RECENCY_LIMIT = 20;

let runs: readonly CommandRun[] = [];
const listeners = new Set<() => void>();

/** Move `id` to the front with the current time. */
export function recordCommandRun(id: string, now: number = Date.now()): void {
  runs = [{ id, at: now }, ...runs.filter((r) => r.id !== id)].slice(
    0,
    COMMAND_RECENCY_LIMIT,
  );
  for (const l of listeners) l();
}

export function recentCommandRuns(): readonly CommandRun[] {
  return runs;
}

/** Test seam: forget every run. */
export function resetCommandRecency(): void {
  runs = [];
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The live list, newest first. */
export function useRecentCommandRuns(): readonly CommandRun[] {
  return useSyncExternalStore(subscribe, recentCommandRuns, recentCommandRuns);
}
