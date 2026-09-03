// Which notes the reader touched most recently, newest first (myne-md/myne#601).
//
// The `[[` picker breaks ties with this, and while the query is still empty it
// IS the order, which is the moment that matters, because the picker opens on
// `[[` before a character is typed and the note being linked to is almost always
// one that was just open.
//
// "Touched" is defined here, once, as BECOMING A PANE'S ACTIVE NOTE. That is the
// chokepoint every way of opening a note ends at (the sidebar, a tab click, a
// wikilink, the command palette, a split, a restored session), so recording it
// there needs no cooperation from any of them. Editing is deliberately NOT a
// second signal: a note being edited is a note that is open, so it is already at
// the head of this list, and counting keystrokes would only add a way for the
// order to drift from what the reader remembers doing.
//
// Module scope rather than React state: a pane unmounts on every split, and the
// order is a property of the SESSION, not of any pane. Session-lived by the same
// reasoning: this is a convenience, and a stale ordering from three days ago is
// worse than none. Nothing here is persisted, so nothing here reaches the vault.

/** How many ids to keep. The picker shows at most `PICKER_CAP` (50) rows, and an
 *  ordering hint deeper than that would never be read. */
const LIMIT = 50;

let order: string[] = [];

/** Record that `noteId` became a pane's active note. Idempotent for a repeat of
 *  the same note (it is already at the head), so a re-render cannot churn it. */
export function noteBecameActive(noteId: string): void {
  if (order[0] === noteId) return;
  order = [noteId, ...order.filter((id) => id !== noteId)].slice(0, LIMIT);
}

/** The current order, newest first. A new array reference is returned only when
 *  the order actually changed, so a consumer can use it as a render key. */
export function recentNoteIds(): readonly string[] {
  return order;
}

/** Forget the order.
 *
 * Called on both vault-leaving paths (`lockVault`, `leaveActiveVault`) and
 * asserted there by `scripts/check-frontend-lock-teardown.mjs`, for the reason
 * `resetScrollMemory` carries: a module-scope list of the note ids one vault
 * opened has no business outliving that vault's session. Also the reset the
 * tests use between cases. */
export function resetRecentNotes(): void {
  order = [];
}
