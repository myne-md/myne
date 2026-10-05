// Refresh a just-created note into the sidebar cache BEFORE opening it
// (myne-md/myne#820, pinned by myne-md/myne#824).
//
// The open bridge treats an id that is not live as a DELETED note and refuses
// to open it (myne#655). A note created moments ago is not in `ctx.cache` yet,
// so the template-create flow must `refreshOne` before `open` or the freshly
// created template cannot be opened for editing.
//
// Extracted from the `TemplatesManager` `onOpenNote` handler so the ordering is
// pinned by a unit test: the previous inline version had no test, and reverting
// it to a bare `open` left every test green.

/** The two IPC calls whose order matters here. `useSelectedNote()`'s context
 *  satisfies this structurally. */
export interface RefreshThenOpenSeam {
  refreshOne: (id: string) => Promise<unknown>;
  open: (id: string) => Promise<unknown>;
}

/**
 * Refresh `id` into the cache, then open it. Rejects if either step does; the
 * caller surfaces that (the note is at least still listed once refreshed).
 */
export async function refreshThenOpen(
  seam: RefreshThenOpenSeam,
  id: string,
): Promise<void> {
  await seam.refreshOne(id);
  await seam.open(id);
}
