// Responsive restack for the Settings dialog (#391).
//
// Every Settings row is `label · control` laid out by `SettingRow`, and the
// control cell is `flex-shrink: 0` (a Segmented / Select must not be squeezed).
// The label is the flexible cell (`min-width: 0`), so as the dialog narrows the
// label box shrinks toward zero and its text paints OVER the control instead of
// beside it — every panel has the same failure, the Editor panel worst because
// its live-preview column eats another 264 px.
//
// Inline styles cannot carry a media query, so the "is this narrow?" decision
// is JS — the same split the editor sidebars use (`screens/layoutClamp.ts` +
// `screens/responsiveCollapse.ts`): a pure width→boolean function here, a thin
// `ResizeObserver` hook over it, the decision unit-tested in Vitest (the trigger
// is a window resize, which the tauri-driver harness cannot drive — the
// `e2e/CLAUDE.md` "states unreachable through real UI" downgrade). Below the
// threshold `SettingRow` restacks (control under label) and the Editor panel
// drops its preview column, so label and control never share pixels.

import { createContext, useContext, useEffect, useState, type RefObject } from "react";

/**
 * Content-area width (px) at or below which the Settings rows restack. Measured
 * on the scrolling content region (the rail is excluded). Chosen above the
 * overlap onset (~667 px content, the Editor panel at a ~935 px window) and
 * comfortably below the default window's content width (~832 px at 1100 px), so
 * the default dialog keeps side-by-side rows and only a genuinely narrow one
 * restacks. The desktop window's own `minWidth` (tauri.conf.json) is the hard
 * floor that additionally guarantees the restacked control always has room.
 */
export const SETTINGS_COMPACT_WIDTH = 720;

/**
 * Pure decision: is the Settings content area narrow enough to restack? A
 * non-finite / non-positive width (first paint, before measurement) is NOT
 * compact — the normal layout shows until the first real measure, matching
 * `computeResponsiveCollapse`'s pre-measure behaviour.
 */
export function isSettingsCompact(contentWidth: number): boolean {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return false;
  return contentWidth <= SETTINGS_COMPACT_WIDTH;
}

/** Provided by `SettingsModal`; `false` when a panel renders outside the modal
 *  (e.g. a future embed) so those degrade to the normal side-by-side layout. */
export const SettingsCompactContext = createContext(false);

/** Read the ambient compact flag inside any Settings panel / row. */
export function useSettingsCompact(): boolean {
  return useContext(SettingsCompactContext);
}

/**
 * Watch `contentRef`'s width and return whether the dialog is compact. Thin
 * `ResizeObserver` glue over {@link isSettingsCompact}; re-renders only when the
 * boolean actually flips (the observer fires per resize tick). Mirrors
 * `useResponsiveCollapse`.
 */
export function useSettingsCompactObserver(
  contentRef: RefObject<HTMLElement | null>,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = isSettingsCompact(el.getBoundingClientRect().width);
      setCompact((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef]);

  return compact;
}
