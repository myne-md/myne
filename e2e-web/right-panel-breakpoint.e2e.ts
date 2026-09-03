// Narrowing the window collapses the right panel without stranding its tab
// strip, and re-widening restores the tab that was open. myne-md/myne#556, the
// `workspace.right-panel` bullet:
//
//   > the right-panel collapse is a container-width breakpoint: assert the
//   > strip is not stranded and the active tab is restored on re-widen.
//
// # Why the browser and not the desktop lane
//
// The decision itself is shared code and `e2e/window-resize-collapse.e2e.ts`
// brackets both of its thresholds against the desktop client. What that
// scenario cannot reach is the state a WEB user routinely sits in: the desktop
// window is floored at `minWidth: 880` by its own configuration, comfortably
// above the 628px both-collapse threshold, so a desktop user never sees the
// narrow end at all. A browser window has no such floor — every width is
// reachable, including the ones nobody designed for.
//
// # "Stranded" is the failure, and it is specific
//
// A collapsed panel that leaves its TAB STRIP rendered is worse than either
// state on its own: the strip is a row of controls for a surface that is not
// there, so clicking one does nothing visible and the user concludes the app is
// broken rather than that the window is narrow.
//
// The obvious assertion — the strip's box is zero — is WRONG here, and the
// first run of this scenario failed on a correctly collapsed panel because of
// it. `SidebarPane` collapses by setting `width: 0` with `overflow: hidden`,
// and a child of that pane still reports its own rect: 279x38, measured, while
// being clipped entirely out of sight. So the measurement is REACHABILITY —
// `document.elementFromPoint` at the strip's own centre must not land on the
// strip — plus the structural half, that the strip is a descendant of the pane
// that collapses. A strip living outside its pane survives every collapse by
// construction, and no geometry check would notice.
//
// # And the restore has to be the SAME tab
//
// The panel remembers which tab was open (`right_panel_active_tab` in
// vault.prefs). Coming back to a DIFFERENT one is the kind of thing that reads
// as a preference the user set — they opened Backlinks, the window got narrow
// on a laptop undock, and they are looking at Outline with no idea why. So the
// tab id is captured before and compared after, rather than asserting merely
// that some tab is active.

import { expect, it } from "vitest";
import { describeE2E } from "./support/scenario";
import { openFixtureVault } from "./support/fixture-session";
import type { Session } from "./support/session";

/** Above the 916px both-fit threshold (260 + 280 + 2*8 + 360). */
const WIDE_PX = 1200;
/** Below it, above the 628px left-collapse one: right goes, left stays. */
const NARROW_PX = 760;
const HEIGHT_PX = 900;

interface PanelState {
  /** Rendered width of the right pane. */
  readonly paneWidth: number;
  /** Is the tab strip a descendant of the pane that collapses? */
  readonly stripInsidePane: boolean;
  /** `elementFromPoint` at the strip's centre: `strip`, `other`, or `null`
   *  when the strip has no box at all. */
  readonly stripHit: string | null;
  /** `data-panel-tab-id` of the active tab, or `null`. */
  readonly activeTab: string | null;
}

async function readPanel(session: Session): Promise<PanelState> {
  const raw = await session.execute<string>(
    "var pane = document.querySelector('[data-testid=\"editor.sidebar-right\"]');" +
      "var strip = document.querySelector('[data-testid=\"editor.right-panel-tabs\"]');" +
      "var active = document.querySelector('[data-testid=\"editor.right-panel-tab\"][data-active=\"true\"]');" +
      "var pr = pane ? pane.getBoundingClientRect() : null;" +
      "var sr = strip ? strip.getBoundingClientRect() : null;" +
      // Reachability, not layout width. A child of a 0-width `overflow: hidden`
      // pane still REPORTS its own 279x38 box — measured — while being clipped
      // out of sight, so a width assertion here fails on a correctly collapsed
      // panel. What "stranded" actually means is that the strip is still THERE
      // for the user: hit-testable, or living outside the pane that collapsed.
      "var hit = null;" +
      "if (sr && sr.width > 0 && sr.height > 0) {" +
      "  var el = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);" +
      "  hit = el && strip.contains(el) ? 'strip' : 'other';" +
      "}" +
      "return JSON.stringify({" +
      "  paneWidth: pr ? pr.width : -1," +
      "  stripInsidePane: !!(pane && strip && pane.contains(strip))," +
      "  stripHit: hit," +
      "  activeTab: active ? active.getAttribute('data-panel-tab-id') : null" +
      "});",
  );
  return JSON.parse(raw) as PanelState;
}

/** Resize and let the layout settle, reading back what the page actually got. */
async function resize(session: Session, width: number): Promise<number> {
  await session.send("POST", "/window/rect", { width, height: HEIGHT_PX, x: 0, y: 0 });
  let inner = -1;
  await session.waitUntil(
    async () => {
      const next = (await session.execute<number>("return window.innerWidth;")) ?? -1;
      const held = next > 0 && next === inner;
      inner = next;
      return held ? true : null;
    },
    { label: () => `the window to settle at ${width}px — innerWidth is ${inner}`, timeoutMs: 15_000 },
  );
  return inner;
}

/** Poll until the panel state holds still, so nothing is read mid-transition. */
async function settled(session: Session, what: string): Promise<PanelState> {
  let prev: PanelState | null = null;
  let seen: PanelState | null = null;
  return await session.waitUntil(
    async () => {
      prev = seen;
      seen = await readPanel(session);
      return prev !== null && Math.round(prev.paneWidth) === Math.round(seen.paneWidth)
        ? seen
        : null;
    },
    {
      label: () =>
        `${what}: the right panel to stop moving — last read ${JSON.stringify(seen)}. ` +
        `The pane's width is transitioned, so a single sample can land mid-animation.`,
      timeoutMs: 20_000,
    },
  );
}

describeE2E("the right panel collapses without stranding its tab strip", () => {
  it("restores the same tab when the window widens again", async () => {
    const ctx = await openFixtureVault();
    try {
      const { session } = ctx;

      const wideWidth = await resize(session, WIDE_PX);
      expect(
        Math.abs(wideWidth - WIDE_PX),
        `the window is ${wideWidth}px having been asked for ${WIDE_PX}px, so the ` +
          `sweep never starts from the wide state`,
      ).toBeLessThanOrEqual(8);
      const wide = await settled(session, `at ${WIDE_PX}px`);

      // NON-VACUITY. Everything below is about a panel that was OPEN with a tab
      // selected; against a build where the right panel never renders, the
      // collapse assertions would all hold trivially.
      expect(
        wide.paneWidth,
        `the right pane is ${wide.paneWidth}px wide at ${WIDE_PX}px, so there is ` +
          `nothing to collapse and the assertions below hold for the wrong reason`,
      ).toBeGreaterThan(100);
      expect(
        wide.activeTab,
        `no right-panel tab is active at ${WIDE_PX}px, so "the same tab comes back" ` +
          `has nothing to compare against`,
      ).not.toBeNull();

      // Narrow: the pane goes, and the strip goes WITH it.
      const narrowWidth = await resize(session, NARROW_PX);
      expect(Math.abs(narrowWidth - NARROW_PX)).toBeLessThanOrEqual(8);
      const narrow = await settled(session, `at ${NARROW_PX}px`);

      expect(
        narrow.paneWidth,
        `the right pane is still ${narrow.paneWidth}px wide in a ${NARROW_PX}px ` +
          `window. Below the 916px threshold it is supposed to collapse so the ` +
          `editor keeps a usable width — this is the breakpoint not firing.`,
      ).toBeLessThanOrEqual(4);

      // NOT STRANDED, asserted two ways because the layout box lies here. A
      // child of a 0-width `overflow: hidden` pane still reports its own
      // 279x38 rect — measured on the first run of this scenario, which failed
      // on a correctly collapsed panel.
      expect(
        narrow.stripInsidePane,
        `the tab strip is not inside the pane that collapses, so nothing makes it ` +
          `go away with the panel. That is the structural half of "stranded": a ` +
          `strip that lives outside its pane survives every collapse by ` +
          `construction.`,
      ).toBe(true);
      expect(
        narrow.stripHit,
        `the tab strip is still hit-testable at its own centre while the panel is ` +
          `collapsed, so it is a row of controls for a surface that is not there. ` +
          `Clicking one does nothing visible, and the user concludes the app is ` +
          `broken rather than that the window is narrow.`,
      ).not.toBe("strip");

      // …and back.
      const backWidth = await resize(session, WIDE_PX);
      expect(Math.abs(backWidth - WIDE_PX)).toBeLessThanOrEqual(8);
      const back = await settled(session, `back at ${WIDE_PX}px`);

      expect(
        back.paneWidth,
        `the right pane did not come back when the window widened again ` +
          `(${back.paneWidth}px). The collapse is a transient response to width, ` +
          `not a setting.`,
      ).toBeGreaterThan(100);
      expect(
        back.activeTab,
        `the right panel came back on the "${back.activeTab}" tab, having been on ` +
          `"${wide.activeTab}" before the window narrowed. That reads as a ` +
          `preference the user set: they opened one panel, the window got narrow on ` +
          `an undock, and they are looking at another with no idea why.`,
      ).toBe(wide.activeTab);
    } finally {
      await ctx.browser.teardown().catch(() => {});
      await ctx.server.close();
    }
  });
});
