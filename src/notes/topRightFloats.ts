// Is anything FLOATED in the title bar's top-right corner? (myne-md/myne#727)
//
// Three things need the same answer and none of them owns it:
//
//   1. the tab strip's right CLEARANCE, how much padding it reserves so its
//      content never slides under the floated controls;
//   2. the right-sidebar toggle's own render condition;
//   3. the note-actions "…" menu's render condition.
//
// Two of the three had their own copy of the condition and they did not agree:
// the clearance's copy knew only about the attachments view, while both
// controls' copies also knew that a non-note tab has no note to act on. So on
// the graph tab, or the task list, or a saved view, the strip reserved room
// for two controls that were not rendered, and its overflow caret sat a
// control's width off the right edge with empty space beside it.
//
// It is a function rather than an inline expression because a predicate with
// three consumers is a thing to test, and because the inline version is exactly
// what got copied. `tests/notes/topRightFloats.test.tsx` drives it directly.

import type { WorkspaceItem } from "./workspaceState";
import { tabKindSpec } from "./tabKinds";

/** The focused pane's active tab kind, or `undefined` for the new-tab chooser
 *  (`activeTab === null`). */
export type FocusedTabKind = WorkspaceItem["kind"] | undefined;

export function topRightFloatsShown(input: {
  focusedTabKind: FocusedTabKind;
  /** The pane whose "+ New tab" chip is open, if any. An open chip over
   *  existing tabs still hides the controls: they act on the focused note, and
   *  the chooser is not one. */
  pendingNewTabPaneId: string | null;
  focusedPaneId: string;
}): boolean {
  return (
    // The attachment-library clause that used to open this expression is gone
    // (myne-md/myne#773): the library is a TAB now, so "is it showing?" is
    // answered by the focused tab's kind like every other surface, and the
    // registry lookup below already covers it.
    //
    // Both controls act on the OPEN note: backlinks and the outline describe
    // it, and the "…" menu edits it. A non-note tab has none.
    //
    // Asked of the tab-kind registry rather than compared to the literal
    // `"note"` (myne-md/myne#773): the registry makes every kind ANSWER the
    // question in its own declaration, where a literal silently gives a new
    // kind `note`'s answer by omission — and the failure is a backlinks panel
    // over a surface that has no note, which nothing type-checks.
    input.focusedTabKind !== undefined &&
    tabKindSpec(input.focusedTabKind).showsFocusedNote &&
    input.pendingNewTabPaneId !== input.focusedPaneId
  );
}
