// MYND-192 — transient responsive auto-collapse of the editor sidebars.
//
// Observes the three-pane row width and decides (via the pure
// `computeResponsiveCollapse` in `layoutClamp.ts`) which sidebars must
// collapse to keep the center editor usable on a narrow window. The
// override is TRANSIENT: it never persists and never touches the user's
// manual collapse preference in vault.prefs — widening restores exactly
// what the user last chose. The effective collapse the editor renders is
// `manualCollapsed || forced` (Editor.tsx).
//
// E2E note: the load-bearing DECISION is covered by
// `tests/screens/responsiveCollapse.test.ts` (Vitest), and the wiring — this
// hook plus the two panes it collapses — by `e2e/window-resize-collapse.e2e.ts`.
//
// This paragraph used to say the trigger "is a window resize, which the
// tauri-driver harness has no primitive to drive", citing the e2e/AGENTS.md
// "states unreachable through real UI" downgrade (MYND-192). That was wrong,
// and wrong in a way that costs features rather than coverage: W3C WebDriver
// has had `POST /window/rect` all along, nothing in this suite had happened to
// need it, and the sentence was then read as a fact about the harness. The
// identical belief in `src/components/settings/settingsCompact.ts` is why the
// Settings responsive restack shipped with its `ResizeObserver` never attached
// and nobody noticed (myne-md/myne#555). A hook is "thin glue" only for as long
// as something checks that the glue is stuck.

import { useEffect, useState, type RefObject } from "react";
import { computeResponsiveCollapse, type ResponsiveCollapse } from "./layoutClamp";

const NONE: ResponsiveCollapse = {
  forceLeftCollapsed: false,
  forceRightCollapsed: false,
};

/**
 * Watch `rowRef`'s width and return which sidebars a narrow window forces
 * collapsed. `openLeftWidth` / `openRightWidth` are the side's RENDERED
 * width — pass `0` for a side the user has manually collapsed, so a
 * collapsed side frees room for the other. Re-subscribes when those widths
 * change (a manual collapse/resize re-evaluates the fit).
 */
export function useResponsiveCollapse(
  rowRef: RefObject<HTMLDivElement | null>,
  openLeftWidth: number,
  openRightWidth: number,
): ResponsiveCollapse {
  const [forced, setForced] = useState<ResponsiveCollapse>(NONE);

  useEffect(() => {
    const el = rowRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = computeResponsiveCollapse(
        el.getBoundingClientRect().width,
        openLeftWidth,
        openRightWidth,
      );
      // Re-render only on a real change — ResizeObserver fires per drag tick.
      setForced((prev) =>
        prev.forceLeftCollapsed === next.forceLeftCollapsed &&
        prev.forceRightCollapsed === next.forceRightCollapsed
          ? prev
          : next,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowRef, openLeftWidth, openRightWidth]);

  return forced;
}
