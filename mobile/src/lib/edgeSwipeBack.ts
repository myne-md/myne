// Edge-swipe back: the gesture both phone platforms teach, on the surfaces that
// have somewhere to go back to (myne-md/myne#970 item 24).
//
// ── The failure it closes ──────────────────────────────────────────────────
// Every pushed surface on this client had exactly one way out: a small "‹ Notes"
// control at the top left. On a phone held one-handed, that corner is the
// hardest pixel on the screen to reach, and the gesture every user already
// performs — drag in from the left edge — did nothing at all. iOS ships the
// gesture at the OS level for a navigation controller and Android has its own
// system back gesture; a WebView app gets neither for free, which is why this is
// the client's own code rather than a platform behaviour.
//
// ── Why an EDGE zone rather than a distance threshold ──────────────────────
// A horizontal drag anywhere on the surface would fight the note list's own
// horizontal gestures (a row's swipe actions) and the tag chip row's scroll. The
// edge band is what makes the two unambiguous: a touch that STARTS in the first
// `EDGE_ZONE_PX` cannot be a list swipe, because a list does not begin its
// content under the bezel.
//
// ── Why the vertical budget ────────────────────────────────────────────────
// A diagonal flick is a scroll that started near the edge. Requiring the
// horizontal travel to dominate (`|dy| < |dx|`) is the smallest rule that
// rejects one, and it is checked on every move rather than only at the end so a
// gesture that turns into a scroll stops being tracked.
//
// ── It never PREVENTS anything ─────────────────────────────────────────────
// No `preventDefault`, no `touch-action` change: this hook observes a gesture and
// answers it. The platform's own scrolling keeps working, and a device whose
// back gesture is intercepted by the OS (Android 10+) simply never delivers the
// touches, which leaves the visible back control as the route it always was.

import { useMemo, useRef } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";

/** How far from the left edge a touch must start to count as an edge swipe. */
export const EDGE_ZONE_PX = 28;

/** How far right it must travel before the gesture is a back rather than a tap. */
export const COMMIT_DISTANCE_PX = 64;

/** The vertical budget, as a fraction of the horizontal travel. */
const DOMINANCE = 1;

export interface EdgeSwipeHandlers {
  onTouchStart: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchMove: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchEnd: (e: ReactTouchEvent<HTMLElement>) => void;
  onTouchCancel: (e: ReactTouchEvent<HTMLElement>) => void;
}

/**
 * Wire an edge swipe to `onBack`. Spread the result on the surface the gesture
 * belongs to — the pane, not the document, so a swipe inside a sheet or a modal
 * cannot close the screen behind it.
 *
 * `onBack` may change between renders (it closes over the current view); the
 * handlers read it from a ref so the spread object stays referentially stable
 * and a re-render mid-gesture does not drop the touch it is tracking.
 */
export function useEdgeSwipeBack(onBack: (() => void) | null): EdgeSwipeHandlers {
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const start = useRef<{ x: number; y: number } | null>(null);
  // Set once a gesture has been committed, so a long drag fires the callback
  // exactly once: `touchend` follows the commit, and so can a `touchmove`.
  const fired = useRef(false);

  return useMemo<EdgeSwipeHandlers>(
    () => ({
      onTouchStart: (e) => {
        if (backRef.current === null) return;
        const touch = e.touches[0];
        if (touch === undefined) return;
        start.current =
          touch.clientX <= EDGE_ZONE_PX ? { x: touch.clientX, y: touch.clientY } : null;
        fired.current = false;
      },
      onTouchMove: (e) => {
        const from = start.current;
        if (from === null || fired.current) return;
        const touch = e.touches[0];
        if (touch === undefined) return;
        const dx = touch.clientX - from.x;
        const dy = Math.abs(touch.clientY - from.y);
        if (dy > Math.abs(dx) * DOMINANCE) {
          // It became a scroll. Stop tracking rather than waiting for a
          // vertical travel that might come back.
          start.current = null;
          return;
        }
        if (dx >= COMMIT_DISTANCE_PX) {
          fired.current = true;
          start.current = null;
          backRef.current?.();
        }
      },
      onTouchEnd: () => {
        start.current = null;
      },
      onTouchCancel: () => {
        start.current = null;
      },
    }),
    [],
  );
}
