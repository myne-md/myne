// Edge auto-scroll while dragging inside a scrollable list (MYND-622).
//
// Moving a note or folder to somewhere off-screen was impossible: the sidebar
// does not scroll during a drag, so the only reachable drop targets were the
// ones already visible. The user had to drop the item somewhere intermediate,
// scroll, and drag again — or give up and use a menu.
//
// HTML5 drag-and-drop gives us nothing here. `dragover` fires only while the
// pointer MOVES, so scrolling straight off it stalls the moment the user holds
// still at the edge — which is exactly what someone waiting for the list to
// come to them does. The scroll therefore runs on its own animation frame loop,
// seeded and re-aimed by `dragover` and torn down on every way a drag can end.
//
// Speed ramps with depth into the edge zone so a shallow hover creeps and a
// deep one moves quickly, which is what makes it feel steerable rather than
// binary.

import { useCallback, useEffect, useRef, type RefObject } from "react";

/** Height of the hot zone at each end of the container, in px. */
const EDGE_PX = 48;
/** Pixels per frame at the very edge (~60fps → ~840px/s at full tilt). */
const MAX_SPEED_PX = 14;

export interface DragAutoScrollHandlers {
  onDragOver: (e: { clientY: number }) => void;
  /** Stop scrolling. Wire to dragleave, drop, and dragend. */
  stop: () => void;
}

/**
 * Auto-scroll `ref`'s element while a drag hovers near its top or bottom edge.
 *
 * The returned `onDragOver` is additive — call it from an existing handler; it
 * never calls `preventDefault` and never touches the drag payload, so it cannot
 * change which drops the list accepts.
 */
export function useDragAutoScroll(
  ref: RefObject<HTMLElement | null>,
): DragAutoScrollHandlers {
  const frameRef = useRef<number | null>(null);
  const pointerYRef = useRef(0);

  const stop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const el = ref.current;
    if (el === null) {
      frameRef.current = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const y = pointerYRef.current;
    let delta = 0;
    if (y < rect.top + EDGE_PX) {
      // Depth into the zone, 0..1 — clamped so a pointer dragged ABOVE the
      // container (y < rect.top) does not exceed full speed.
      const depth = Math.min(1, (rect.top + EDGE_PX - y) / EDGE_PX);
      delta = -depth * MAX_SPEED_PX;
    } else if (y > rect.bottom - EDGE_PX) {
      const depth = Math.min(1, (y - (rect.bottom - EDGE_PX)) / EDGE_PX);
      delta = depth * MAX_SPEED_PX;
    }
    if (delta !== 0) el.scrollTop += delta;
    frameRef.current = requestAnimationFrame(tick);
  }, [ref]);

  const onDragOver = useCallback(
    (e: { clientY: number }) => {
      pointerYRef.current = e.clientY;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(tick);
    },
    [tick],
  );

  // A drag can end without the list seeing `dragleave` or `drop` — dropped on
  // another surface, or cancelled with Escape. `dragend` always fires on the
  // source, and it bubbles to the window, so this is the reliable teardown.
  // Without it the loop would keep running (and keep scrolling) after the drag.
  useEffect(() => {
    window.addEventListener("dragend", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragend", stop);
      window.removeEventListener("drop", stop);
      stop();
    };
  }, [stop]);

  return { onDragOver, stop };
}
