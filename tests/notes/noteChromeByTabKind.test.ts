// Note-scoped chrome follows the FOCUSED TAB's kind (myne-md/myne#773).
//
// Replaces `tests/attachments/centerViewExclusive.test.tsx`, which drove the
// `CenterView` mechanism this change deleted. The invariant it protected is
// kept and widened here, because the old one was narrower than it looked:
//
//   old: exactly one of {a note row, the Attachments entry} is highlighted
//   now: note-scoped chrome shows only while the focused tab IS a note
//
// The old rule asked whether the attachment library owned the center pane,
// because that was the only non-note surface that could. It was therefore
// correct for the library and WRONG for the graph and the task list — both
// could be focused while a sidebar row still claimed to be the active note.
// Making the library a tab is what let the question be asked properly.
//
// Two consumers read this one declaration: the top-right floats (backlinks,
// outline, "…") and the notes sidebar's selected-row highlight. Each compared
// against the literal `"note"` in its own file before this, which is how they
// came to disagree.

import { describe, expect, it } from "vitest";
import { TAB_KINDS, tabKindSpec } from "../../src/notes/tabKinds";
import { topRightFloatsShown } from "../../src/notes/topRightFloats";

describe("only a note tab shows note-scoped chrome", () => {
  it("answers yes for `note` and no for every other registered kind", () => {
    expect(tabKindSpec("note").showsFocusedNote).toBe(true);
    for (const spec of TAB_KINDS.filter((s) => s.kind !== "note")) {
      expect(
        spec.showsFocusedNote,
        `${spec.kind} must not claim the focused note`,
      ).toBe(false);
    }
  });

  it("covers the attachment library, which used to need its own rule", () => {
    // The regression this file exists for. When the library was a CenterView,
    // every consumer needed a SECOND question beside the tab kind, and the
    // graph and the task list were never added to it.
    expect(tabKindSpec("attachments").showsFocusedNote).toBe(false);
    expect(topRightFloatsShown({
      focusedTabKind: "attachments",
      pendingNewTabPaneId: null,
      focusedPaneId: "p1",
    })).toBe(false);
  });

  it("is a declaration, so a NEW kind cannot inherit note's answer", () => {
    // Every registered kind carries the field explicitly. A kind added without
    // it fails to compile; a kind added with the wrong value fails the first
    // case above. Neither is possible to get wrong silently, which is what a
    // literal comparison in each consumer allowed.
    for (const spec of TAB_KINDS) {
      expect(typeof spec.showsFocusedNote, `${spec.kind}`).toBe("boolean");
    }
  });
});
