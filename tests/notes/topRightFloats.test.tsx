// The title bar's top-right corner: whether anything is floated there
// (myne-md/myne#727).
//
// The failure this pins is a pair of duplicated conditions that disagreed. The
// tab strip's right clearance asked "is the attachments view showing?", while
// the two controls it was reserving room for asked "is a NOTE tab focused?" as
// well. On the graph tab nothing was rendered and the room was reserved anyway,
// so the strip's overflow caret floated a control's width off the right edge.
//
// Driving the predicate directly is the point: the bug was never in the strip
// or in a control, it was in the QUESTION, and a test that mounts either one
// would be testing a consumer of the answer rather than the answer.

import { describe, expect, it } from "vitest";
import { topRightFloatsShown } from "../../src/notes/topRightFloats";

const base = {
  focusedTabKind: "note",
  pendingNewTabPaneId: null,
  focusedPaneId: "pane-1",
} as const;

describe("topRightFloatsShown", () => {
  it("is true for an open note tab, which is what the controls act on", () => {
    expect(topRightFloatsShown({ ...base })).toBe(true);
  });

  it("is FALSE on a non-note tab, the graph, the task list, a saved view", () => {
    // THE reported bug. Neither the "…" menu nor the right-sidebar toggle is
    // rendered on a non-note tab, so the tab strip must not reserve their room:
    // reserving it left the caret off the right edge with nothing beside it.
    // Every non-note kind, ATTACHMENTS INCLUDED since myne-md/myne#773 made
    // the library a tab. It used to need a separate case below, because it was
    // a `CenterView` — a parallel mechanism this predicate had to ask about
    // separately — and that separate question is exactly what went stale when a
    // fourth surface arrived.
    for (const kind of ["graph", "tasks", "view", "attachments"] as const) {
      expect(
        topRightFloatsShown({ ...base, focusedTabKind: kind }),
        `focusedTabKind=${kind}`,
      ).toBe(false);
    }
  });

  it("is false on the new-tab chooser, where there is no active tab at all", () => {
    expect(topRightFloatsShown({ ...base, focusedTabKind: undefined })).toBe(
      false,
    );
  });

  it("is false while a new-tab chip is open over existing tabs", () => {
    // The chooser is not a note, even though the tab under it is.
    expect(
      topRightFloatsShown({
        ...base,
        pendingNewTabPaneId: base.focusedPaneId,
      }),
    ).toBe(false);
  });

  it("asks the tab-kind REGISTRY rather than comparing to a literal", () => {
    // The predicate reads `showsFocusedNote` off the registry, so a new tab kind
    // has to answer the question in its own declaration. Comparing to the
    // literal `"note"` would give a new kind note's answer by omission, and the
    // failure is a backlinks panel floating over a surface with no note behind
    // it — which nothing type-checks and no existing scenario covers.
    for (const kind of ["graph", "tasks", "view", "attachments"] as const) {
      expect(topRightFloatsShown({ ...base, focusedTabKind: kind })).toBe(false);
    }
    expect(topRightFloatsShown({ ...base, focusedTabKind: "note" })).toBe(true);
  });

  it("is false when a pending chip is open in ANOTHER pane", () => {
    // Only the focused pane's chip matters: the controls follow the focus.
    expect(
      topRightFloatsShown({ ...base, pendingNewTabPaneId: "pane-2" }),
    ).toBe(true);
  });
});
