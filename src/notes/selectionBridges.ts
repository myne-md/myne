// The two selection-bridge rules, as pure predicates (myne-md/myne#655).
//
// `Editor.tsx` runs two one-way syncs between the sidebar's `selectedId` and the
// focused pane's active tab. Their own comment calls them non-looping, and they
// are, for a note that is alive. A delete breaks that premise for a moment: the
// cache row is dropped optimistically while the tab is removed from every pane
// by a separate `setState`. In the gap the focused pane's active tab is still
// the dead note, so the mirror puts the dead id into `selectedId`, the opener
// finds it open in no pane and re-opens it into the focused pane, which makes it
// the active tab again. Each hand-off remounts the pane, which is the flashing,
// and it does not stop.
//
// # Why they live here rather than inline in the effects
//
// So a test can drive the rule rather than a copy of it. The first version of
// `tests/notes/deleteSwapLoop.test.ts` re-implemented both predicates inside the
// test file, which detects a change to the model and not to the app: deleting
// both guards from `Editor.tsx` left every case green. A roster compared against
// a second copy of itself proves nothing, which is the failure `CLAUDE.md`
// records under "Verifying a guard means breaking it".
//
// Pure and dependency-free on purpose: no React, no workspace types beyond what
// the decision reads.

/** A note id, kept structural so this module needs no import from the sidebar. */
type Id = string;

/**
 * Should the focused pane's active tab be mirrored into the sidebar selection?
 *
 * `isLive` is the CACHE membership answer, passed in rather than read here: the
 * effect must take it as a dependency, because reading the cache at fire time
 * with the cache out of the dep array makes the guard LATCH. At boot the
 * workspace blob restores a tab before `refreshAll` has decrypted the note list,
 * so the guard would reject once against an empty cache and never run again,
 * leaving `selectedId` null for the whole session.
 */
export function shouldMirrorSelection(
  activeTabId: Id | null,
  isLive: boolean,
): boolean {
  if (activeTabId === null) return true; // clearing the selection is always fine
  return isLive;
}

/**
 * Should `selectedId` be opened into the focused pane?
 *
 * Three refusals, and each is its own rule rather than a restatement of the
 * others: nothing is selected, the selection names a note that no longer
 * exists, or it is already open somewhere so opening it again would fight the
 * pane that has it.
 */
export function shouldOpenIntoFocusedPane(
  selectedId: Id | null,
  isLive: boolean,
  isOpenSomewhere: boolean,
): boolean {
  if (selectedId === null) return false;
  if (!isLive) return false;
  return !isOpenSomewhere;
}
