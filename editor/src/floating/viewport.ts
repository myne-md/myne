// The VISIBLE viewport, for surfaces that have to stay above the software
// keyboard (myne-md/myne#884).
//
// `position: fixed; bottom: 0` is the bottom of the LAYOUT viewport, and on iOS
// WKWebView the layout viewport does NOT shrink when the keyboard opens: the
// visible area does. A sheet pinned with `bottom: 0` therefore sits behind the
// keyboard, and its Save button goes with it. `visualViewport` reports both
// numbers (`height` and `offsetTop`), and this module turns them into the two
// values a docked surface needs: how tall it may be, and how far its bottom edge
// must sit above the layout viewport's bottom.
//
// **A module rather than a call site**, because more than one surface needs the
// same two numbers and the arithmetic is the part that is easy to get subtly
// wrong. The mobile client already tracks the same source for its own root
// (`mobile/src/App.tsx`'s `useViewport`); that is the React spelling of it and
// this is the imperative one, and both read `visualViewport` rather than
// re-deriving a rule from `innerHeight` alone.

/** One reading of the visible viewport, in CSS pixels. */
export type VisibleViewport = {
  /** Height of the visible area. A docked surface caps its own height to this. */
  height: number;
  /** How far the visible area's top sits below the layout viewport's top. iOS
   *  moves this when it scrolls the page to reveal a caret. */
  offsetTop: number;
  /** The layout viewport's height, which is the zero point `offsetTop` is
   *  measured from and the reference `position: fixed` uses. */
  layoutHeight: number;
};

/** Read the visible viewport once. Falls back to the layout viewport on a
 *  platform without `visualViewport`, which is the honest degradation: the
 *  surface then behaves the way it did before this module existed. */
export function visibleViewport(): VisibleViewport {
  if (typeof window === "undefined") {
    // A node-environment test that never mounts a DOM still resolves a sane
    // shape rather than throwing, so a caller needs no environment guard.
    return { height: 800, offsetTop: 0, layoutHeight: 800 };
  }
  const layoutHeight = window.innerHeight;
  const vv = window.visualViewport;
  if (vv === null || vv === undefined) return { height: layoutHeight, offsetTop: 0, layoutHeight };
  return { height: vv.height, offsetTop: vv.offsetTop, layoutHeight };
}

/**
 * The two numbers a docked surface writes into its own inline style.
 *
 * `bottom` is the distance from the layout viewport's bottom edge to the visible
 * area's bottom edge, which is what puts the surface above the keyboard on a
 * platform whose layout viewport does not shrink. Where it DOES shrink
 * (Android's `adjustResize`), `offsetTop` is 0 and `height` equals the layout
 * height, so `bottom` is exactly 0 and the surface sits on the real bottom edge.
 * One expression, both platforms.
 *
 * `maxHeight` is the visible height, so a surface whose content is taller than
 * the space left scrolls internally instead of running off the screen.
 */
export function dockGeometry(vp: VisibleViewport): { maxHeight: number; bottom: number } {
  return {
    maxHeight: vp.height,
    bottom: Math.max(0, vp.layoutHeight - (vp.offsetTop + vp.height)),
  };
}

/**
 * Subscribe to visible-viewport changes. Returns the unsubscribe.
 *
 * `scroll` matters as much as `resize` on iOS: scrolling the page to reveal a
 * caret changes `offsetTop` without changing `height`, and a surface that only
 * listened for `resize` would keep the stale offset. `window`'s own `resize` is
 * kept as well, so the fallback path (no `visualViewport`) still re-measures
 * when the window changes size.
 */
export function subscribeVisibleViewport(cb: (vp: VisibleViewport) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const update = (): void => cb(visibleViewport());
  const vv = window.visualViewport;
  vv?.addEventListener("resize", update);
  vv?.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  return () => {
    vv?.removeEventListener("resize", update);
    vv?.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
  };
}
