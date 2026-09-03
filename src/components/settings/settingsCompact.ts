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
// `ResizeObserver` hook over it. Below the threshold `SettingRow` restacks
// (control under label) and the Editor panel drops its preview column, so label
// and control never share pixels.
//
// # The trigger IS drivable, and the belief that it was not cost the feature
//
// This header used to end "the decision unit-tested in Vitest (the trigger is a
// window resize, which the tauri-driver harness cannot drive — the
// `e2e/CLAUDE.md` 'states unreachable through real UI' downgrade)". The first
// clause is true of the DESKTOP harness and was read as true of the feature, so
// the pure function was tested and the wiring was not — and the wiring was
// broken from the start: the observer was never attached, so the restack never
// fired, at any width, on any client (myne-md/myne#556; see the `attached`
// parameter for the mechanism).
//
// The browser lane resizes a real window. `e2e-web/settings-restack.e2e.ts`
// drives 1600 -> 560 -> 1600 and asserts the flip in both directions plus the
// absence of label/control overlap; `tests/components/settingsCompactObserver.test.tsx`
// asserts the observer attaches at all, which is the fact the browser scenario
// can only infer from the outcome. "The harness cannot drive it" was a
// statement about one harness.

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
  /**
   * Whether the observed element is on screen right now — i.e. the dialog's
   * `open`.
   *
   * REQUIRED, with no default, and that is the whole fix (myne-md/myne#556).
   * A `RefObject` changing from `null` to an element does not re-render, so an
   * effect keyed only on the ref runs ONCE — and `SettingsModal` calls this
   * hook on every render including the closed ones, where it returns `null`
   * before the content div exists. The first run therefore found `null`,
   * returned early, and no `ResizeObserver` was ever attached: the responsive
   * restack never fired, at any width, on any client.
   *
   * Measured, not reasoned: a width sweep of the real browser
   * (`e2e-web/settings-restack.e2e.ts`) found the content area at 630 px on a
   * 900 px window and 230 px on a 500 px one, against a 720 px threshold, with
   * zero rows compact throughout and the label cell crushed to 0 px wide —
   * which is exactly the overlap this module's header describes.
   *
   * Nothing caught it because the trigger is a window resize: this module's own
   * header records that the desktop harness cannot drive one, so the decision
   * was unit-tested as a pure function and its WIRING was never exercised. The
   * pure half was correct the whole time.
   *
   * No default value, deliberately — root `CLAUDE.md`: "a guard parameter with
   * a default value is an opt-in guard, and the default is the arm that never
   * fires". A second caller must say when its element exists rather than
   * inheriting the answer that hid this for as long as it did.
   */
  attached: boolean,
): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!attached || el === null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = isSettingsCompact(el.getBoundingClientRect().width);
      setCompact((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, attached]);

  return compact;
}
