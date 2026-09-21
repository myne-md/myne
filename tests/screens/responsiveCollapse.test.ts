// MYND-192 — pure responsive auto-collapse decision.
//
// The window-resize trigger is unreachable through the tauri-driver E2E
// harness (no window-rect primitive), so per e2e/AGENTS.md the load-bearing
// logic is covered here as a Vitest unit (E2E downgrade recorded on
// MYND-192). The hook in `responsiveCollapse.ts` is thin ResizeObserver
// glue over this function. Cases pin: both-fit, right-first yield,
// both-collapse, the exact fit boundary, the manual-collapse interplay (a
// collapsed side frees room for the other), and the pre-measure no-op.

import { describe, it, expect } from "vitest";
import { computeResponsiveCollapse } from "../../src/screens/layoutClamp";

// Default sidebar widths. need-both = 260+280+16+360 = 916;
// need-left = 260+8+360 = 628.
const L = 260;
const R = 280;

describe("computeResponsiveCollapse (MYND-192)", () => {
  it("keeps both sidebars on a wide row", () => {
    expect(computeResponsiveCollapse(1400, L, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
  });

  it("collapses the right sidebar first when both no longer fit", () => {
    expect(computeResponsiveCollapse(700, L, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: true,
    });
  });

  it("collapses both when even center + left no longer fit", () => {
    expect(computeResponsiveCollapse(500, L, R)).toEqual({
      forceLeftCollapsed: true,
      forceRightCollapsed: true,
    });
  });

  it("honors the exact both-fit boundary (>= keeps both)", () => {
    expect(computeResponsiveCollapse(916, L, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
    expect(computeResponsiveCollapse(915, L, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: true,
    });
  });

  it("honors the exact left-only boundary (>= keeps the left)", () => {
    expect(computeResponsiveCollapse(628, L, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: true,
    });
    expect(computeResponsiveCollapse(627, L, R)).toEqual({
      forceLeftCollapsed: true,
      forceRightCollapsed: true,
    });
  });

  it("frees room for the right when the left is manually collapsed (width 0)", () => {
    // left=0 → need-both = 0+280+16+360 = 656; a 700px row keeps the right.
    expect(computeResponsiveCollapse(700, 0, R)).toEqual({
      forceLeftCollapsed: false,
      forceRightCollapsed: false,
    });
  });

  it("forces nothing before the first measurement (non-positive / non-finite)", () => {
    for (const w of [0, -10, NaN, Infinity]) {
      expect(computeResponsiveCollapse(w, L, R)).toEqual({
        forceLeftCollapsed: false,
        forceRightCollapsed: false,
      });
    }
  });
});
