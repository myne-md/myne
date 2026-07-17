// Local keep-both resolution for a `BaseMismatch` autosave rejection (§11.3
// expected-base guard): the buffer holds real keystrokes typed on a base a
// sync pull-apply has already replaced on disk. Mirrors the engine's own
// keep-both semantics — silently, like `useConflictMaterializer` (the copy is
// discoverable in the sidebar + Conflicts view; the `conflict` SaveStatus is
// the in-context signal, no toast).
//
// Order is load-bearing: the conflict COPY is created FIRST — if that fails,
// the buffer is never replaced, so the user's keystrokes are never lost. Only
// then is the pane re-based onto the pulled disk content.
//
// Deps-injected so the orchestration is unit-testable without Tauri IPC
// (`tests/notes/baseMismatch.test.ts`).

import { createConflictCopy } from "./conflictCopy";
import { noteRead } from "./readNote";

export type BaseMismatchDeps = {
  /** Materialize the stale buffer as a keep-both copy; returns the new id. */
  createCopy: (bufferBody: string, originalUuid: string) => Promise<string>;
  /** Read the (pulled) on-disk body of the original note. */
  readNote: (noteId: string) => Promise<string>;
  /** Re-baseline the pane onto the pulled body (autosave `acceptReloadedBody`
   *  + `setContent` — the caller owns both). */
  adoptDiskBody: (diskBody: string) => void;
  /** Surface the new copy in the sidebar (`ctx.refreshOne`). */
  refreshCopy: (copyId: string) => Promise<void> | void;
};

/**
 * Resolve a rejected save: preserve the buffer as a conflict copy, then
 * re-base the pane onto the pulled disk content. Throws only when the COPY
 * step fails (buffer untouched — the autosave falls back to its error state
 * and Retry re-runs the whole handler, which converges).
 */
export async function handleBaseMismatch(
  args: { noteId: string; bufferBody: string },
  deps: BaseMismatchDeps,
): Promise<void> {
  // 1. Keystrokes first — a failure here must leave the buffer as-is.
  const copyId = await deps.createCopy(args.bufferBody, args.noteId);
  // 2. Re-base the pane onto what sync actually put on disk.
  const diskBody = await deps.readNote(args.noteId);
  deps.adoptDiskBody(diskBody);
  // 3. Make the copy discoverable. Best-effort — the note exists either way.
  try {
    await deps.refreshCopy(copyId);
  } catch {
    // The sidebar catches up on its own refresh cadence.
  }
}

/** Production deps, minus the pane-owned `adoptDiskBody` / `refreshCopy`. */
export function productionBaseMismatchDeps(
  adoptDiskBody: (diskBody: string) => void,
  refreshCopy: (copyId: string) => Promise<void> | void,
): BaseMismatchDeps {
  return {
    createCopy: createConflictCopy,
    readNote: noteRead,
    adoptDiskBody,
    refreshCopy,
  };
}
