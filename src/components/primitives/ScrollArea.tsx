// A scroll region with its own scrollbar (myne-md/myne#727).
//
// # Why this exists rather than the app-wide `::-webkit-scrollbar` rules
//
// `src/styles/tokens.css` already slims the scrollbar app-wide, and on most
// surfaces that is the whole job. It stops working inside a WebKit scrollbar
// PSEUDO-ELEMENT: a `var()` in `::-webkit-scrollbar-thumb` does not resolve
// against the scrolled element's cascade, so the thumb takes the root's BASE
// value. In this app that is the LIGHT theme's `--line-2` (#c8c7c1), which is
// why the graph settings panel drew a pale bar down a dark panel while every
// other scroller looked right. The rule was correct and the resolution was not,
// and no amount of re-writing the rule fixes that.
//
// So the scrollbar is a real element here. The native one is hidden, and the
// thumb is a `<div>` styled by an ordinary stylesheet rule, which means the
// tokens resolve the way every other rule in the app does.
//
// # What it costs, stated
//
// A custom scrollbar is machinery the platform was giving away: the thumb's
// geometry, the drag, the track paging, and the decision to show it at all. All
// four are below, and the one that is easy to get wrong is the MEASUREMENT, a
// scroll region whose content grows without anyone scrolling needs an observer,
// not a scroll listener.
//
// # What it deliberately does not do
//
// No horizontal bar: every consumer here scrolls one axis, and a second thumb
// that never appears is a code path nothing exercises. No momentum, no
// rubber-banding, no overlay-on-mobile: the platform still owns the SCROLLING,
// which is the hard part; this owns only the indicator.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** The thumb never shrinks below this, in px, so a very long list still shows
 *  something grabbable rather than a hairline. */
const MIN_THUMB_PX = 24;
/** How long the bar stays visible after the last scroll, in ms. */
const IDLE_HIDE_MS = 900;

interface Geometry {
  /** Whether there is anything to scroll. */
  overflowing: boolean;
  /** Thumb height and its offset from the top of the track, in px. */
  thumbHeight: number;
  thumbTop: number;
}

const EMPTY_GEOMETRY: Geometry = {
  overflowing: false,
  thumbHeight: 0,
  thumbTop: 0,
};

/** Measure a scroller into {@link Geometry}. Pure over the element's box. */
function measureGeometry(el: HTMLElement): Geometry {
  const track = el.clientHeight;
  const content = el.scrollHeight;
  // One pixel of slack, the same reason `useScrollEdges` carries it: fractional
  // offsets and device pixel ratios leave a scrollable box a hair under.
  if (track === 0 || content <= track + 1) return EMPTY_GEOMETRY;
  const thumbHeight = Math.max(MIN_THUMB_PX, (track / content) * track);
  const travel = content - track;
  const thumbTop = (el.scrollTop / travel) * (track - thumbHeight);
  return { overflowing: true, thumbHeight, thumbTop };
}

/**
 * A vertically scrollable box with a themed scrollbar.
 *
 * `style` lands on the OUTER wrapper (size it, flex it, give it a border);
 * `contentStyle` lands on the scroller, which is where padding belongs.
 */
export function ScrollArea({
  children,
  style,
  contentStyle,
  testId,
  ariaLabel,
}: {
  children: ReactNode;
  style?: CSSProperties;
  contentStyle?: CSSProperties;
  testId?: string;
  ariaLabel?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(EMPTY_GEOMETRY);
  // Two independent reasons to show the bar, because they end differently: a
  // pointer leaves when it leaves, and a scroll goes quiet after a moment. One
  // boolean driven by both would need the timeout to know which one it was.
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const next = measureGeometry(el);
    setGeometry((prev) =>
      prev.overflowing === next.overflowing &&
      prev.thumbHeight === next.thumbHeight &&
      prev.thumbTop === next.thumbTop
        ? prev
        : next,
    );
  }, []);

  const onScroll = useCallback(() => {
    measure();
    setScrolling(true);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setScrolling(false), IDLE_HIDE_MS);
  }, [measure]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    // The element's own resize AND its content's, because each moves the answer
    // on its own: the window changing height changes how much fits, and a group
    // collapsing changes the total. Watching only `scroll` leaves the bar stale
    // in exactly the case that matters, content that grew past the fold with
    // nobody touching it, which is what an expand/collapse is.
    //
    // Feature-detected rather than assumed: `ResizeObserver` is absent in jsdom,
    // and an unguarded `new ResizeObserver(...)` here would throw during render
    // and take the whole screen down. A scrollbar is a nicety.
    const ro =
      typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    const observeAll = (): void => {
      if (ro === null) return;
      // `disconnect()` first: the MutationObserver re-runs this on every
      // childList change, and `observe()` alone never drops a node that left.
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observeAll();
    const mo =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            observeAll();
            measure();
          })
        : null;
    mo?.observe(el, { childList: true, subtree: true });
    if (ro === null && typeof window !== "undefined") {
      window.addEventListener("resize", measure);
    }
    measure();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      mo?.disconnect();
      if (ro === null && typeof window !== "undefined") {
        window.removeEventListener("resize", measure);
      }
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    };
  }, [measure, onScroll]);

  // Drag. The pointer capture is what keeps the thumb following a fast gesture
  // that leaves the six-pixel-wide element, which it always does.
  const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
  const onThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (el === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startTop: el.scrollTop };
  };
  const onThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    const drag = dragRef.current;
    if (el === null || drag === null) return;
    const track = el.clientHeight;
    const thumb = Math.max(MIN_THUMB_PX, (track / el.scrollHeight) * track);
    const travel = track - thumb;
    if (travel <= 0) return;
    // Map the pointer's travel onto the content's, so a drag is 1:1 with what
    // the user sees rather than with the scroll offset.
    const contentPerPx = (el.scrollHeight - track) / travel;
    el.scrollTop = drag.startTop + (e.clientY - drag.startY) * contentPerPx;
  };
  const onThumbPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      data-testid={testId}
      style={{ position: "relative", display: "flex", minHeight: 0, ...style }}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      // Focus counts as interest: a keyboard user tabbing into the panel has no
      // pointer to reveal the bar with, and the bar is how they see that there
      // is more below.
      onFocusCapture={() => setHovering(true)}
      onBlurCapture={() => setHovering(false)}
    >
      <div
        ref={scrollerRef}
        className="myne-scrollarea"
        aria-label={ariaLabel}
        tabIndex={ariaLabel === undefined ? undefined : 0}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          // Stop a flick past the last row from scrolling whatever is behind it.
          overscrollBehavior: "contain",
          ...contentStyle,
        }}
      >
        {children}
      </div>
      {geometry.overflowing && (
        <div
          className="myne-scrollarea-thumb"
          data-testid={testId === undefined ? undefined : `${testId}-thumb`}
          data-visible={hovering || scrolling ? "true" : "false"}
          role="presentation"
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={onThumbPointerUp}
          onPointerCancel={onThumbPointerUp}
          style={{
            height: geometry.thumbHeight,
            transform: `translateY(${geometry.thumbTop}px)`,
          }}
        />
      )}
    </div>
  );
}
