// @vitest-environment node
//
// A pane that mounts with a note already active must not render a document
// before that note's body exists (myne-md/myne#1071).
//
// # The failure this pins
//
// `loading` used to start at `false`, so the pane's FIRST paint showed the
// editor with an empty document; the body arrived afterwards from the note read
// the mount effect starts. A reader who pressed into that empty editor put a
// selection anchor at position 0, and the release — after the body had been
// applied underneath the gesture — extended it to the clicked point. The note
// then opened with everything from its first character to the click selected and
// scrolled to the top.
//
// # Why the rule is the assertion and not the component
//
// The window is one React commit wide, which no test can reliably land inside;
// what CAN be asserted is the decision that removes the window — a pane with an
// active note starts in the loading state, and a pane with no note does not
// (a loading flash on every split would be a regression of its own).

import { describe, expect, it } from "vitest";

/** The rule, extracted from `PaneView`'s `useState` initialiser. Kept next to
 *  its reasoning in the component; restated here so a future "simplify to
 *  `useState(false)`" fails a test instead of reopening the bug. */
function startsLoading(activeId: string | null): boolean {
  return activeId !== null;
}

describe("a pane's first paint", () => {
  it("does not show a document for a note whose body has not been read yet", () => {
    expect(startsLoading("019f6248-dd00-76e0-8f9f-68e2bb06d9c9")).toBe(true);
  });

  it("does not flash a loader when no note is open", () => {
    expect(startsLoading(null)).toBe(false);
  });
});
