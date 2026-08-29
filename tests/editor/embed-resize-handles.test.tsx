// @vitest-environment jsdom
//
// The drag-to-resize handles on a block-drawn image embed (myne-md/myne#604),
// and the `setWidthPx` arm they write through.
//
// # Why this exists when there is an E2E scenario
//
// er1 covers the gesture end to end, and it runs only in the manual pre-release
// lane. Review's deletion test was the argument: replacing
// `appendResizeHandles`' body with `return null` leaves `pnpm test` green, so a
// gesture that WRITES to the note was covered by a claim rather than a check on
// every push. These cases are the check.
//
// jsdom has no layout, so every rect the drag reads is stubbed. That bounds what
// can be asserted here: the arithmetic and the commit shape, not the pixels.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setWidthPx, toggleWidthPx } from "../../src/editor/attachments/embedLayoutActions";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setWidthPx", () => {
  it("states a pixel width and clears the percentage form with it", () => {
    // The two width forms are exclusive: a note carrying both would render one
    // and silently keep the other, so the setter that establishes one has to
    // drop the other in the same object rather than leave it to the caller.
    expect(setWidthPx(320)).toEqual({ widthPx: 320, widthPercent: null });
  });

  it("is the arm `toggleWidthPx` sets with, so the drag and the menu agree", () => {
    // The drag calls `setWidthPx` and the menu calls `toggleWidthPx`. If they
    // disagreed about what "set a width" means, the same 320 would produce two
    // different embeds depending on which affordance the user reached for.
    const applied = toggleWidthPx(320)({ widthPx: null, widthPercent: 50 });
    expect(applied.widthPx).toBe(320);
    expect(applied.widthPercent).toBeNull();
  });

  it("toggling the width that is already set clears BOTH forms", () => {
    // The drag has no such behaviour on purpose: dragging to the width you are
    // already at must not clear the width. Pinned here so the shared arm cannot
    // grow a toggle that the drag would inherit.
    const cleared = toggleWidthPx(320)({ widthPx: 320, widthPercent: null });
    expect(cleared.widthPx).toBeNull();
    expect(cleared.widthPercent).toBeNull();
  });
});
