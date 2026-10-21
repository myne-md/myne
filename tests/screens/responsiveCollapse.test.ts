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
import { shouldCollapseForAgentTab } from "../../src/screens/editorLayout";

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

describe("shouldCollapseForAgentTab", () => {
  const base = {
    agentTabFocused: true,
    paneCount: 1,
    hydrated: true,
    leftCollapsed: false,
    handledForEntry: false,
  };

  it("closes the sidebar on a single-pane agent tab", () => {
    expect(shouldCollapseForAgentTab(base)).toBe(true);
  });

  it("does nothing while the persisted layout is still loading", () => {
    // The read REPLACES the state, so a collapse written before it lands is
    // undone silently. This is the case that shipped as "it stays open".
    expect(shouldCollapseForAgentTab({ ...base, hydrated: false })).toBe(false);
  });

  it("leaves a split workspace alone", () => {
    // There the note tree is the other pane's context.
    expect(shouldCollapseForAgentTab({ ...base, paneCount: 2 })).toBe(false);
  });

  it("does not fight a sidebar the user reopened, or a note tab", () => {
    expect(shouldCollapseForAgentTab({ ...base, handledForEntry: true })).toBe(false);
    expect(shouldCollapseForAgentTab({ ...base, leftCollapsed: true })).toBe(false);
    expect(shouldCollapseForAgentTab({ ...base, agentTabFocused: false })).toBe(false);
  });
});
