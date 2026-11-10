// `<VirtualList>` — hand-rolled virtualization primitive for the Notes
// sidebar list.
//
// Per `decisions.md` 2026-05-15 "Sidebar virtualization: hand-rolled
// scroll-event windowing + ResizeObserver (deferred from
// `@tanstack/react-virtual`; TB9 audit-anchor disciplined)" — zero
// third-party dependency, ~210 LOC, isolated boundary so a future
// library swap (when dogfood reveals edge cases) is a small follow-up
// PR.
//
// Mechanics:
//
// 1. **Estimated-height windowing.** The container's scroll position +
//    height + a buffer (default ±5 rows) determine which input indices
//    enter the rendered window. Outside that window the rows are not
//    mounted; spacer divs above and below absorb the accumulated
//    estimated height.
//
// 2. **`ResizeObserver` per visible row** measures actual rendered
//    heights; cache misses fall back to `estimatedRowHeight`. The
//    measured heights re-feed the spacer-height accumulator on the
//    next render.
//
// 3. **Scroll-to-selected:** the parent component can pass a
//    `scrollToIndex` ref-like callback (via `ref` from React 19) — if
//    the target index is outside the current window, the component
//    force-mounts that index briefly so `scrollIntoView` can land on
//    a real DOM node. v0.1 ships the simpler `scrollIntoView({ block:
//    'nearest' })` path; smoother variants are a v0.2 polish.
//
// 4. **Stable scroll position under variable row heights.** When a row
//    grows (e.g., inline-rename mode) ResizeObserver updates that row's
//    cached height; the spacer above gets recomputed in the next render
//    pass so the visible window's scroll offset stays anchored.
//
// User stories: PRD 8 (only visible + buffer rendered), 9 (smooth
// scroll, no flicker), 10 (variable row height after rename), 79
// (scroll-event windowing + ResizeObserver mechanics).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type VirtualListProps<T> = {
  /** Input items rendered in order. Pass already-sorted IDs. */
  items: readonly T[];
  /** Render callback for a single item. Must return a node with a
   *  stable height after first paint (variable rename growth handled
   *  via ResizeObserver). */
  renderItem: (item: T, index: number) => ReactNode;
  /** Stable key for each item (defaults to `String(item)` — pass when
   *  items aren't string IDs). */
  keyOf?: (item: T, index: number) => string;
  /** Cold-start height assumption for unmeasured rows (px). Pinned
   *  default 52 matches `<NoteRow>`'s resting design height. */
  estimatedRowHeight?: number;
  /** Render this many extra rows above + below the visible window so
   *  fast scrolls don't flash empty space. Default 5. */
  buffer?: number;
  /** Render every row, ignoring the window. For a drag in progress: removing the
   *  dragged row unmounts the browser's drag source and cancels the gesture, and
   *  an off-screen row cannot be a drop target. Bounded by the gesture. */
  renderAll?: boolean;
  /** Opaque token: when it changes, the measured-height cache is dropped so
   *  every row re-measures from the (current) estimate. Pass a value that
   *  encodes any GLOBAL change to row geometry that ResizeObserver can't catch
   *  for OFF-SCREEN rows — e.g. the sidebar-note-timestamps toggle, which
   *  shrinks every note row 52→30px. Without this, off-screen rows keep their
   *  stale cached height until scrolled back into view, so the cumulative
   *  offsets jump mid-scroll (visible render glitches). */
  heightResetToken?: unknown;
  /** Horizontal overflow of the scroll container. Default `"hidden"` (the
   *  sidebar + cards render byte-unchanged). The saved-view TABLE passes
   *  `"auto"` so a wide column set scrolls horizontally with its Name column
   *  pinned (`position:sticky; left:0`) to this scroll container. */
  overflowX?: "hidden" | "auto";
  /** Optional `data-testid` for the SCROLL element. Off by default so the
   *  sidebar and cards render byte-unchanged. The board passes one per lane
   *  (myne-md/myne#922): a lane's scroll position is that lane's own state, and
   *  asserting it survives a data change needs a handle on the element that
   *  actually scrolls. */
  testId?: string;
  /** Draw the app's own `ScrollArea` indicator instead of the native bar: it
   *  shows on hover, focus and scroll only, where the native bar follows the OS
   *  setting and never hides on a Mac set to always show scroll bars
   *  (myne-md/myne#867, on the user's read for the sidebar tree). Opt-in, so the
   *  saved views keep their native bars, and the table's horizontal scroll in
   *  particular, which the primitive does not draw. Ignored when `overflowX` is
   *  `"auto"`, for that reason. */
  overlayScrollbar?: boolean;
};

const DEFAULT_ESTIMATED_HEIGHT = 52;
const DEFAULT_BUFFER = 5;

import { useDragAutoScroll } from "./useDragAutoScroll";
import { ScrollArea } from "../../components/primitives/ScrollArea";

export function VirtualList<T>(props: VirtualListProps<T>): ReactNode {
  const {
    items,
    renderItem,
    keyOf = (item: T, _index: number) => String(item),
    estimatedRowHeight = DEFAULT_ESTIMATED_HEIGHT,
    buffer = DEFAULT_BUFFER,
    renderAll = false,
    heightResetToken,
    overflowX = "hidden",
    overlayScrollbar = false,
    testId,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const rowNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Drop the measured-height cache when the geometry token flips. Done during
  // render (before the cumulativeOffsets memo reads the map) so off-screen rows
  // fall back to the current estimate instead of a stale measurement — the
  // visible rows then re-measure via ResizeObserver. Mutating a ref-held cache
  // during render is the sanctioned "derived cache reset on prop change" shape.
  const prevResetTokenRef = useRef(heightResetToken);
  if (prevResetTokenRef.current !== heightResetToken) {
    prevResetTokenRef.current = heightResetToken;
    heightsRef.current.clear();
  }

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Capture the render counter's VALUE (not just the setter): the cumulativeOffsets
  // memo depends on it so a ResizeObserver measurement (which bumps it via
  // triggerRender) actually re-runs the memo and feeds real heights into the
  // offset table. Discarding the value left the memo pinned to estimated heights.
  const [heightVersion, forceRender] = useState(0);
  const triggerRender = useCallback(() => {
    forceRender((n) => (n + 1) % 1_000_000);
  }, []);

  // Track viewport size — ResizeObserver on the scroll container.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    setViewportHeight(node.clientHeight);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === node) {
          setViewportHeight(node.clientHeight);
        }
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Track scroll position — raf-coalesced via requestAnimationFrame so
  // fast scroll bursts don't trigger re-renders per event.
  useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        setScrollTop(node.scrollTop);
        frame = 0;
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  // Resolve estimated and measured heights into a cumulative offset
  // array so we can binary-search for the visible window start index.
  const cumulativeOffsets = useMemo(() => {
    const offsets: number[] = new Array(items.length + 1).fill(0) as number[];
    const heights = heightsRef.current;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as T;
      const key = keyOf(item, i);
      const h = heights.get(key) ?? estimatedRowHeight;
      offsets[i + 1] = (offsets[i] ?? 0) + h;
    }
    return offsets;
  }, [items, keyOf, estimatedRowHeight, heightResetToken, heightVersion]);

  const totalHeight = cumulativeOffsets[cumulativeOffsets.length - 1] ?? 0;

  // Binary-search the first index whose cumulative offset >= scrollTop.
  const startIndex = useMemo(() => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((cumulativeOffsets[mid + 1] ?? 0) <= scrollTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return Math.max(0, lo - buffer);
  }, [cumulativeOffsets, scrollTop, items.length, buffer]);

  // End-index search: first index whose offset >= scrollTop + viewport.
  const endIndex = useMemo(() => {
    const end = scrollTop + viewportHeight;
    let lo = startIndex;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((cumulativeOffsets[mid] ?? 0) < end) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return Math.min(items.length, lo + buffer);
  }, [cumulativeOffsets, scrollTop, viewportHeight, items.length, startIndex, buffer]);

  const winStart = renderAll ? 0 : startIndex;
  const winEnd = renderAll ? items.length : endIndex;
  const topSpacer = renderAll ? 0 : (cumulativeOffsets[startIndex] ?? 0);
  const bottomSpacer = renderAll ? 0 : totalHeight - (cumulativeOffsets[endIndex] ?? 0);

  // Single ResizeObserver for the entire list's lifetime. Per-row
  // observe / unobserve happens in the ref callback below — this
  // avoids destroying + recreating the observer on every scroll
  // boundary cross.
  const observerRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const heights = heightsRef.current;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLDivElement).dataset["vrowKey"];
        if (key === undefined) continue;
        const measured = entry.contentRect.height;
        const cached = heights.get(key);
        if (cached === undefined || Math.abs(cached - measured) > 0.5) {
          heights.set(key, measured);
          changed = true;
        }
      }
      if (changed) triggerRender();
    });
    observerRef.current = ro;
    return () => {
      ro.disconnect();
      observerRef.current = null;
    };
  }, [triggerRender]);

  const visibleSlice: Array<{ item: T; index: number; key: string }> = [];
  for (let i = winStart; i < winEnd; i++) {
    const item = items[i];
    if (item === undefined) continue;
    visibleSlice.push({ item, index: i, key: keyOf(item, i) });
  }

  // Cache one ref-callback per key so `ref={setRowRef(key)}` keeps a STABLE
  // identity across renders — otherwise React ran the cleanup (unobserve+delete)
  // and re-observe on every render for every visible row.
  const refCbCacheRef = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
  const setRowRef = useCallback((key: string) => {
    const cache = refCbCacheRef.current;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const cb = (node: HTMLDivElement | null) => {
      const map = rowNodesRef.current;
      const prev = map.get(key);
      const ro = observerRef.current;
      if (node === null) {
        if (prev !== undefined && ro !== null) ro.unobserve(prev);
        map.delete(key);
      } else {
        if (prev !== node && ro !== null) {
          if (prev !== undefined) ro.unobserve(prev);
          ro.observe(node);
        }
        map.set(key, node);
      }
    };
    cache.set(key, cb);
    return cb;
  }, []);

  const autoScroll = useDragAutoScroll(containerRef);

  const containerStyle: CSSProperties = {
    height: "100%",
    overflowY: "auto",
    overflowX,
    position: "relative",
  };

  const content = (
    <>
      <div style={{ height: topSpacer }} aria-hidden="true" />
      {visibleSlice.map(({ item, index, key }) => (
        <div
          key={key}
          ref={setRowRef(key)}
          data-vrow-key={key}
        >
          {renderItem(item, index)}
        </div>
      ))}
      <div style={{ height: bottomSpacer }} aria-hidden="true" />
    </>
  );

  if (overlayScrollbar && overflowX === "hidden") {
    // The primitive's scroller IS the virtualizer's container: `containerRef`
    // is handed in, so the scroll listener, the viewport ResizeObserver and the
    // drag auto-scroll all read the element that actually scrolls. The drag
    // handlers sit on a wrapper because drag events bubble from the scroller.
    return (
      <div
        style={{ height: "100%", display: "flex", minHeight: 0 }}
        onDragOver={autoScroll.onDragOver}
        onDragLeave={autoScroll.stop}
        onDrop={autoScroll.stop}
      >
        {/* ONE wrapper around the rows, with `watchSubtree={false}`: the
            visible slice changes on every scroll frame, and a subtree observer
            re-observed every row each frame. The wrapper's height IS the list's
            total (the two spacers plus the slice), so the indicator still
            hears every change in it through the wrapper's ResizeObserver
            (myne-md/myne#867 review, D7). */}
        <ScrollArea
          scrollerRef={containerRef}
          style={{ flex: "1 1 auto", minWidth: 0 }}
          contentStyle={{ position: "relative" }}
          watchSubtree={false}
          testId={testId}
        >
          <div data-vlist-content="">{content}</div>
        </ScrollArea>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      data-testid={testId}
      // MYND-622: scroll the list while a drag hovers its top/bottom edge, so a
      // note can be moved somewhere off-screen in one gesture. Additive — no
      // preventDefault, no dataTransfer access, so the rows' own drop handling
      // is untouched.
      onDragOver={autoScroll.onDragOver}
      onDragLeave={autoScroll.stop}
      onDrop={autoScroll.stop}
    >
      {content}
    </div>
  );
}
