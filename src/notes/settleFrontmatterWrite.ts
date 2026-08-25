// Settle an out-of-band frontmatter write, the sibling of
// `flushBeforeFrontmatterWrite` and the other half of the same bug class.
//
// The flush runs BEFORE the write, so the disk the writer reads matches the
// buffer. This runs AFTER it, so the buffer matches the disk the writer left.
// Skip either and the open pane holds bytes that disagree with the file: skip
// the flush and the write clobbers unsaved text, skip the settle and the pane's
// next autosave writes the pre-write frontmatter back and silently reverts the
// field that was just set.
//
// # Why it is a module and not a closure
//
// It was a closure in `Editor.tsx`, whose own comment said the recipe "belongs
// to the BUG CLASS, so if it ever gains a step, one edit covers all of them".
// The third caller then arrived in another file and hand-copied the two lines
// with a comment saying it was copying them (`PaneView.tsx`'s saved-view cover
// apply). That is the same shape `flushBeforeFrontmatterWrite`'s own header
// argues against for the flush half: a recipe a caller has to remember is a
// recipe a caller can forget, and nothing sees the omission. It type-checks, no
// guard in `scripts/` looks at it, and the symptom is a field the user set
// disappearing one keystroke later in a pane they were not looking at.
//
// The sidebar accessors are passed in rather than imported, because the two
// callers reach them through different contexts (`ctx` in `Editor.tsx`, the
// `sidebar` object in `PaneView.tsx`) and the shape below is the whole overlap.

import type { NoteId } from "./sidebarState";

/** The two sidebar accessors this recipe needs, and nothing else. */
export interface FrontmatterSettleTarget {
  /** Re-read the OPEN note's bytes into its pane buffer. A dirty buffer is
   *  guarded inside this call, not here. */
  readonly reloadOpenNote: () => void;
  /** Re-read one record so the tree settles on the new field. */
  readonly refreshOne: (id: NoteId) => Promise<void>;
}

/**
 * Re-read the open note and the record for `id` after a frontmatter field was
 * written straight to disk.
 *
 * Awaiting the returned promise is the caller's choice: the reload is
 * synchronous and is what stops the revert, while the record refresh only
 * settles the tree.
 */
export function settleFrontmatterWrite(
  sidebar: FrontmatterSettleTarget,
  id: NoteId,
): Promise<void> {
  sidebar.reloadOpenNote();
  return sidebar.refreshOne(id);
}
