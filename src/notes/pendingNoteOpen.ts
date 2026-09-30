// A one-shot "open this note when the editor next mounts" request
// (myne-md/myne#788, task 9).
//
// The plain-file surface renders INSTEAD of the vault stage (`App.tsx`:
// `plainScreen ? <PlainFileScreen /> : screen`), so when the Import action
// creates a vault note the Editor is unmounted and no React context is
// reachable from the caller. This models that as what it is: a one-shot fact
// the next editor mount consumes, the same shape `src/lib/routing.ts` uses for
// the boot deep link (module state, read once, dropped if the note is not in
// the live list).
//
// Deliberately not a window event: the request is made BEFORE the tab closes
// and the Editor mounts AFTER, so a listener-based signal would be emitted
// into an empty room.

let pending: string | null = null;

/** Ask the editor to select `noteId` the next time it mounts. */
export function requestNoteOpen(noteId: string): void {
  pending = noteId;
}

/**
 * The requested note id, or `null`. Consuming, once.
 *
 * The caller MUST check the id against the live note list before opening it:
 * the note may have been deleted between the request and the mount, and an id
 * that is not in the list is dropped.
 */
export function takeRequestedNoteOpen(): string | null {
  const id = pending;
  pending = null;
  return id;
}

/** @internal Test-only reset of the one-shot. */
export function __resetPendingNoteOpenForTest(): void {
  pending = null;
}
