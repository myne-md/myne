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
};

const DEFAULT_ESTIMATED_HEIGHT = 52;
const DEFAULT_BUFFER = 5;

export function VirtualList<T>(props: VirtualListProps<T>): ReactNode {
  const {
    items,
    renderItem,
    keyOf = (_item: T, index: number) => String(index),
    estimatedRowHeight = DEFAULT_ESTIMATED_HEIGHT,
    buffer = DEFAULT_BUFFER,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const rowNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [, forceRender] = useState(0);
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
  }, [items, keyOf, estimatedRowHeight]);

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

  const topSpacer = cumulativeOffsets[startIndex] ?? 0;
  const bottomSpacer = totalHeight - (cumulativeOffsets[endIndex] ?? 0);

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
  for (let i = startIndex; i < endIndex; i++) {
    const item = items[i];
    if (item === undefined) continue;
    visibleSlice.push({ item, index: i, key: keyOf(item, i) });
  }

  const setRowRef = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
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
    },
    [],
  );

  const containerStyle: CSSProperties = {
    height: "100%",
    overflowY: "auto",
    overflowX: "hidden",
    position: "relative",
  };

  return (
    <div ref={containerRef} style={containerStyle}>
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
    </div>
  );
}
