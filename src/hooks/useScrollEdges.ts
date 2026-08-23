// Soft edges for a scrolling region: the fade that says "there is more this
// way" instead of a hairline crop (myne-md/myne#565).
//
// # Why the fade is CONDITIONAL rather than a fixed mask on both edges
//
// A static `mask-image` on both ends is one line and looks wrong at rest: the
// first row of a list that is already scrolled to the top renders half-faded
// for no reason, which reads as a rendering fault rather than as an affordance.
// The fade has to mean something, so it appears on the edge you can actually
// scroll TOWARD, and only while you can.
//
// # Why a mask rather than a gradient overlay
//
// An overlay has to be painted in the container's background colour to blend,
// so it is wrong the moment a theme changes one of them, and wrong again over a
// hovered row. A mask removes alpha from the content itself and is
// colour-agnostic by construction, which is the same reason the ornament layer
// is a mask and not a fill.
//
// The gradient itself lives in `tokens.css` (`.myne-scroll-fade`), not in an
// inline style. Its stops are `#000`, which in a mask is full opacity rather
// than a colour, and must stay unreachable to a theme, the opposite of what an
// inline literal is for. This module owns only the MEASUREMENT, which edges are
// currently reachable, and hands that over as two data attributes.

import { type CSSProperties, useCallback, useRef, useState } from "react";

export interface ScrollEdges {
  /** There is content above the viewport. */
  top: boolean;
  /** There is content below it. */
  bottom: boolean;
}

/**
 * What makes an element a scroll region, as one object rather than four
 * declarations each consumer remembers separately.
 *
 * `minHeight: 0` is the one that fails SILENTLY when it is forgotten: a flex
 * item's default `min-height: auto` refuses to shrink below its content, so the
 * container never overflows, `overflowY` has nothing to do, this hook measures
 * `false / false` forever, and no fade appears. Nothing reports it. Exported
 * beside the hook so the contract and its measurement live in one place.
 */
export const scrollRegionStyle: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
  // Stop a flick past the last row from scrolling whatever is behind it.
  overscrollBehavior: "contain",
};

/** Class + attributes for the edges currently reachable. Both attributes absent
 *  means no fade, which is the correct rendering for content that fits. */
function fadePropsFor(edges: ScrollEdges): FadeProps {
  return {
    className: "myne-scroll-fade",
    "data-fade-top": edges.top ? "true" : undefined,
    "data-fade-bottom": edges.bottom ? "true" : undefined,
  };
}

interface FadeProps {
  className: string;
  "data-fade-top"?: "true";
  "data-fade-bottom"?: "true";
}

/**
 * Track whether a scroll container has content past either edge.
 *
 * Re-measures on scroll, on the element's own resize, and on its content's.
 * All three, because each one moves the answer on its own: scrolling changes
 * the position, resizing the window changes how much fits, and a row appearing
 * or leaving changes the total. Watching only `scroll` leaves the fade stale in
 * exactly the case that matters, a list that just grew past the fold without
 * anyone touching it.
 */
export function useScrollEdges<T extends HTMLElement>(): {
  /** Attach to the scrolling element. */
  ref: (node: T | null) => void;
  /** Spread onto the same element, beside `scrollRegionStyle`. */
  fadeProps: FadeProps;
} {
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false });
  const nodeRef = useRef<T | null>(null);

  // Not rAF-throttled, and that is a decision rather than an omission. The three
  // reads below are pure geometry with no pending style change in front of them,
  // so they do not force a layout, and `setEdges` short-circuits when the answer
  // has not moved, so a scroll that changes nothing costs no render. A throttle
  // would buy a coalesce the browser already does for scroll events, at the
  // price of a scheduled callback and a cancel path in the teardown, in a hook
  // that is inside the pre-unlock leak-budget scope. Revisit if a consumer ever
  // measures something more expensive here than three integers.
  const measure = useCallback(() => {
    const el = nodeRef.current;
    if (el === null) return;
    // One pixel of slack: fractional scroll offsets and device pixel ratios
    // otherwise leave `scrollTop` a hair short of the true bottom forever, and
    // the fade never turns off.
    const next = {
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    };
    setEdges((prev) =>
      prev.top === next.top && prev.bottom === next.bottom ? prev : next,
    );
  }, []);

  // React 19 ref cleanup: the callback RETURNS its teardown, so React never calls
  // it with `null` and there is no second teardown path to keep in step. The
  // React-18 shape (a cleanup ref, invalidated at the top of the callback, plus
  // an unmount effect) carried a third path that could never run: the effect's
  // cleanup always found the ref already nulled.
  const ref = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      if (node === null) return;
      node.addEventListener("scroll", measure, { passive: true });

      // Both observers are FEATURE-DETECTED rather than assumed. `ResizeObserver`
      // is absent in jsdom, and an unguarded `new ResizeObserver(...)` here threw
      // during render, which took the whole screen down, in a test and in any
      // host that ships without it. A fade is a nicety; losing the vault picker
      // to it is not a trade worth making. Without them the window `resize`
      // fallback still catches the case that matters most (the window getting
      // shorter), and the scroll listener catches the rest.
      const ro =
        typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
      const observeAll = (): void => {
        if (ro === null) return;
        // `disconnect()` FIRST, then re-observe. The MutationObserver re-runs
        // this on every `childList` change, and `observe()` alone never drops a
        // node that has left the DOM: the observation list grows for the whole
        // life of the mount and each entry keeps a detached element alive.
        // Bounded only by how much the list churns, which is not a bound. This
        // hook is now mounted by every `CenteredCard` screen as well as the
        // vault picker.
        ro.disconnect();
        ro.observe(node);
        for (const child of Array.from(node.children)) ro.observe(child);
      };
      observeAll();
      const mo =
        typeof MutationObserver === "function"
          ? new MutationObserver(() => {
              observeAll();
              measure();
            })
          : null;
      mo?.observe(node, { childList: true });
      if (ro === null && typeof window !== "undefined") {
        window.addEventListener("resize", measure);
      }
      measure();
      return () => {
        node.removeEventListener("scroll", measure);
        ro?.disconnect();
        mo?.disconnect();
        if (ro === null && typeof window !== "undefined") {
          window.removeEventListener("resize", measure);
        }
        nodeRef.current = null;
        setEdges({ top: false, bottom: false });
      };
    },
    [measure],
  );

  return { ref, fadeProps: fadePropsFor(edges) };
}
