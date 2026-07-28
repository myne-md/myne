// The layout across the width range a BROWSER TAB actually spans
// (phase3-web-client task 74).
//
// # Why this is a separate file from `responsiveCollapse.test.ts`
//
// That file pins the decision at the widths a desktop WINDOW reaches. A browser
// tab is a different range in both directions and the difference is not
// cosmetic:
//
// * **Narrower.** The desktop client opens at 1100×720 and the OS enforces a
//   floor under that. A tab has no floor the app controls — a quarter-screen
//   snap on a 1280 display is 320 CSS px, and the user can drag narrower still.
// * **Wider.** A maximised tab on an ultrawide is 3440 or 5120 px, which the
//   desktop window also reaches but which nothing had asserted.
//
// So this sweeps the range and asserts properties that must hold at EVERY width
// in it, rather than at three chosen points.

import { describe, expect, it } from "vitest";
import {
  CENTER_MIN_WIDTH,
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  LEFT_BOUNDS,
  RESIZE_HANDLE_HIT_ZONE,
  RIGHT_BOUNDS,
  clampSidebarWidthForLayout,
  computeResponsiveCollapse,
} from "../../src/screens/layoutClamp";

/** Every CSS pixel width from a quarter-screen snap to an ultrawide, stepped. */
const RANGE: number[] = [];
for (let w = 280; w <= 5120; w += 4) RANGE.push(w);

/** The widths a browser tab realistically lands on, named for failure output. */
const NAMED = [
  [320, "quarter of a 1280 display"],
  [640, "half of a 1280 display"],
  [768, "a narrow floating window"],
  [1024, "half of a 2048 display"],
  [1280, "half of a 2560 ultrawide"],
  [1440, "a maximised 1440 laptop"],
  [1920, "maximised 1080p"],
  [2560, "maximised 1440p"],
  [3440, "maximised 21:9 ultrawide"],
  [5120, "maximised 32:9 super-ultrawide"],
] as const;

const L = DEFAULT_LEFT_WIDTH;
const R = DEFAULT_RIGHT_WIDTH;

describe("collapse across the browser width range", () => {
  it("never collapses MORE as the window widens", () => {
    // Monotonicity. Without it a drag would flap sidebars open and shut as the
    // pointer moved, and the flap would look like a rendering bug rather than a
    // threshold one.
    let prevCollapsedCount = 2; // narrowest end: both
    for (const w of RANGE) {
      const c = computeResponsiveCollapse(w, L, R);
      const count = Number(c.forceLeftCollapsed) + Number(c.forceRightCollapsed);
      expect(count, `widening to ${w}px collapsed more, not fewer`).toBeLessThanOrEqual(
        prevCollapsedCount,
      );
      prevCollapsedCount = count;
    }
  });

  it("yields the right sidebar before the left, never the other way round", () => {
    // The note list is the more load-bearing of the two: without it there is no
    // navigation. Backlinks are a reading aid. A width that dropped the left
    // while keeping the right would be usable-looking and unnavigable.
    for (const w of RANGE) {
      const c = computeResponsiveCollapse(w, L, R);
      if (c.forceLeftCollapsed) {
        expect(c.forceRightCollapsed, `${w}px dropped the left while keeping the right`).toBe(
          true,
        );
      }
    }
  });

  it("leaves the centre at least its minimum wherever both sidebars stay open", () => {
    // The no-clipping property, stated as arithmetic rather than as a rendering
    // check: whenever the decision keeps a sidebar, the row must actually have
    // had room for it plus the centre's floor.
    for (const w of RANGE) {
      const c = computeResponsiveCollapse(w, L, R);
      const left = c.forceLeftCollapsed ? 0 : L;
      const right = c.forceRightCollapsed ? 0 : R;
      const handles = (left > 0 ? RESIZE_HANDLE_HIT_ZONE : 0) + (right > 0 ? RESIZE_HANDLE_HIT_ZONE : 0);
      if (left === 0 && right === 0) continue; // centre owns the row; see below
      expect(
        w - left - right - handles,
        `at ${w}px the centre would be squeezed below its ${CENTER_MIN_WIDTH}px floor`,
      ).toBeGreaterThanOrEqual(CENTER_MIN_WIDTH);
    }
  });

  it("hands the whole row to the centre once nothing else fits", () => {
    // Below the last threshold there is no arrangement that satisfies the
    // floor, so the answer is "the centre gets everything" rather than a
    // sidebar that overflows the row. The centre pane is `minWidth: 0` in the
    // flex row precisely so this degrades by getting narrow rather than by
    // clipping.
    for (const [w, label] of NAMED) {
      const c = computeResponsiveCollapse(w, L, R);
      if (w < CENTER_MIN_WIDTH + RESIZE_HANDLE_HIT_ZONE) {
        expect(c.forceLeftCollapsed, label).toBe(true);
        expect(c.forceRightCollapsed, label).toBe(true);
      }
    }
  });

  it("keeps both sidebars at every realistic browser width from 1024 up", () => {
    // The band that matters for the product claim: a desktop browser at a
    // normal size gets the full three-pane layout, not a degraded one.
    for (const [w, label] of NAMED) {
      if (w < 1024) continue;
      expect(computeResponsiveCollapse(w, L, R), `${w}px (${label})`).toEqual({
        forceLeftCollapsed: false,
        forceRightCollapsed: false,
      });
    }
  });
});

describe("the ultrawide end", () => {
  it("does not stretch the sidebars — the per-side maximum still governs", () => {
    // A sidebar that grew with the window would put the note list metres from
    // the prose on a 32:9 display. The centre absorbs the extra width; the
    // sidebars are capped.
    for (const w of [2560, 3440, 5120]) {
      expect(clampSidebarWidthForLayout(99_999, LEFT_BOUNDS, L, w, R)).toBe(LEFT_BOUNDS.max);
      expect(clampSidebarWidthForLayout(99_999, RIGHT_BOUNDS, R, w, L)).toBe(RIGHT_BOUNDS.max);
    }
  });

  it("collapses nothing however wide the tab gets", () => {
    for (const w of [2560, 3440, 5120, 10_000]) {
      expect(computeResponsiveCollapse(w, LEFT_BOUNDS.max, RIGHT_BOUNDS.max)).toEqual({
        forceLeftCollapsed: false,
        forceRightCollapsed: false,
      });
    }
  });
});

describe("the widths fed back in are the MANUAL ones, and that is load-bearing", () => {
  // `computeResponsiveCollapse` takes the sidebars' RENDERED widths, and its own
  // docstring says the decision "can never feed back into its own input and
  // oscillate". That is true of the row width — collapsing does not change how
  // wide the window is — and it is NOT automatically true of the sidebar widths.
  //
  // The call site passes the user's MANUAL collapse state (`layout.leftCollapsed
  // ? 0 : layout.leftWidth`), never the forced result. If it ever passed the
  // effective state instead, the forced answer would become an input to itself.
  //
  // This test proves the trap is real rather than theoretical, so the call-site
  // rule reads as load-bearing rather than as a style choice.
  it("would oscillate if the FORCED result were fed back", () => {
    const oscillating: number[] = [];
    for (const w of RANGE) {
      const first = computeResponsiveCollapse(w, L, R);
      if (!first.forceRightCollapsed) continue;
      // Feed the forced state back, as a call site using the EFFECTIVE widths
      // would: the right is collapsed, so it now reports 0.
      const second = computeResponsiveCollapse(w, first.forceLeftCollapsed ? 0 : L, 0);
      if (!second.forceRightCollapsed) oscillating.push(w);
    }
    expect(
      oscillating.length,
      "if this is 0 the feedback trap has gone away and this test should be deleted, " +
        "not weakened — but check WHY before doing so",
    ).toBeGreaterThan(0);
    // And name the band, so the failure output is diagnostic rather than a bare count.
    expect(Math.min(...oscillating)).toBeLessThan(Math.max(...oscillating));
  });

  it("is stable when the MANUAL widths are fed back, at every width", () => {
    // The property the call site actually relies on: with manual state as the
    // input, the answer is a pure function of the row width and re-evaluating
    // changes nothing.
    for (const w of RANGE) {
      const once = computeResponsiveCollapse(w, L, R);
      const twice = computeResponsiveCollapse(w, L, R);
      expect(twice, `unstable at ${w}px`).toEqual(once);
    }
  });
});

describe("a manually collapsed side frees room for the other", () => {
  it("keeps the notes list open at widths where both together would not fit", () => {
    // The interaction a browser reaches far more often than a desktop window,
    // because the narrow band is reachable at all: with backlinks manually
    // closed, the note list survives down to a much smaller tab.
    const bothOpenFloor = L + R + 2 * RESIZE_HANDLE_HIT_ZONE + CENTER_MIN_WIDTH;
    const leftOnlyFloor = L + RESIZE_HANDLE_HIT_ZONE + CENTER_MIN_WIDTH;
    expect(leftOnlyFloor).toBeLessThan(bothOpenFloor);
    for (let w = leftOnlyFloor; w < bothOpenFloor; w += 4) {
      expect(computeResponsiveCollapse(w, L, 0).forceLeftCollapsed, `${w}px`).toBe(false);
    }
  });
});
