// @vitest-environment jsdom
//
// The left rail's ground (myne-md/myne#867).
//
// ── The defect ─────────────────────────────────────────────────────────────
// The rail's fill sat on its SCROLLER, which starts below the 38px
// traffic-light clearance row, so the top of the column was painted by
// nothing at all and the app root's `--bg-1` showed through it. Measured in
// the running app by sampling the rendered pixels: `#fbfbfa` above the
// clearance row against the rail's own `#f4f4f2` below it in the light theme,
// `#121210` against `#1a1a17` in the dark one (invisible on AMOLED, where both
// resolve to black). The title-bar row of every other column in the editor
// stage is painted: the sidebar panes carry `--paper-2` for their whole
// height, the pane tab strips paint it, and `App.tsx` paints `--bg-2` for the
// same 38px strip on the stages that are not the editor. The rail was the one
// occupant of that row with no paint.
//
// ── What is asserted, and why it is not a pixel measurement ────────────────
// jsdom applies no stylesheet and lays nothing out, so "these two pixels
// differ" is not available here. The property that IS checkable is the one
// that makes the paint cover the region by construction: **the element
// carrying the surface must be an ANCESTOR of the clearance row**, i.e. of
// every pixel of the column. Put the fill back on the scroller and that
// containment goes away, which is exactly the regression.
//
// `usePrefs` is mocked at its module boundary (no Tauri IPC), the same shape
// `AiChatTab.test.tsx` uses. The component's `useTranslation` needs no import
// here: the suite's own i18n setup resolves it, which is also why this file
// carries no `@myne/i18n` import to type-check against.

import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { LeftRibbon } from "../../src/notes/components/LeftRibbon";
import { STRIP_HEIGHT } from "../../src/notes/components/TabStrip";

vi.mock("../../src/hooks/usePrefs", () => ({
  // `ribbon_visible` is the rail's own gate (`if (hidden || !prefs.ribbon_visible)
  // return null`), so a mock that omits it renders nothing and the test fails on
  // a missing element rather than on the property it is about.
  usePrefs: () => ({ prefs: { ribbon_visible: true } }),
}));

describe("the rail's region root owns its ground (myne-md/myne#867)", () => {
  it("paints the column's surface on an ancestor of the clearance row", () => {
    const { getByTestId } = render(<LeftRibbon />);
    const scroller = getByTestId("editor.ribbon");

    // The scroller paints nothing: one surface per column, owned by the region.
    expect(scroller.style.background).toBe("");

    // Walk up to whatever carries the fill.
    let painted: HTMLElement | null = scroller.parentElement;
    while (painted !== null && painted.style.background === "") {
      painted = painted.parentElement;
    }
    expect(painted).not.toBeNull();
    expect(painted!.style.background).toBe("var(--bg-2)");

    // **The containment assertion.** The clearance row is the region root's
    // first child, so if the painter is its ancestor the fill covers it; if
    // the fill moves back onto the scroller, that scroller is the clearance
    // row's SIBLING and this fails.
    const clearance = painted!.firstElementChild as HTMLElement | null;
    expect(clearance).not.toBeNull();
    expect(clearance!.style.height).toBe(`${STRIP_HEIGHT}px`);
    expect(clearance!.getAttribute("aria-hidden")).toBe("true");
    expect(painted!.contains(clearance!)).toBe(true);
    expect(scroller.contains(clearance!)).toBe(false);

    // And the clearance row paints no surface of its OWN, which would be a
    // second declaration of the same value, the shape that let the first
    // version of this bug be reintroduced by editing one of the two.
    expect(clearance!.style.background).toBe("");

    // The divider's start is a DIFFERENT question from the surface's extent,
    // and this change deliberately left it where it was: the hairline between
    // the rail and the sidebar still begins where the icons do.
    const divider = painted!.children[1] as HTMLElement;
    expect(divider.style.top).toBe(`${STRIP_HEIGHT}px`);
    cleanup();
  });
});
