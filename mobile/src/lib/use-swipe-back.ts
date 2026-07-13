import { useEffect, useRef, type RefObject } from "react";

/**
 * Left-edge swipe-back gesture for the compact (phone) editor screen — the
 * iOS interactive-pop feel: a touch that starts near the left screen edge and
 * moves right drags the screen with the finger; past a distance threshold (or
 * on a quick flick) it triggers `onBack`, otherwise it springs back.
 *
 * Touch events (not pointer events) on purpose: once the horizontal intent is
 * recognized we must `preventDefault()` the moves to keep the page from
 * scrolling and CodeMirror from selecting — pointer events can't veto the
 * browser's native pan, which would land us a `pointercancel` mid-drag.
 * Listeners are capture-phase so an engaged gesture is swallowed before the
 * editor's own handlers see it; until recognition every touch passes through
 * untouched (taps and vertical scrolls behave exactly as before).
 */

/** Width of the left-edge strip that can start the gesture. Wide enough to be
 *  forgiving on device, narrow enough to stay out of the editor's text column
 *  (compact editor content starts at 22px). */
const EDGE_PX = 32;
/** Movement before we commit to horizontal-back vs vertical-scroll. */
const SLOP_PX = 12;
/** Release past this fraction of the screen width always triggers back. */
const COMMIT_FRACTION = 0.32;
/** A flick: at least this distance AND this overall speed (px/ms) triggers. */
const FLICK_MIN_PX = 48;
const FLICK_MIN_VELOCITY = 0.35;

/** True when `target` sits inside a floating overlay (sheet / panel / popover)
 *  layered over the screen. Overlays are absolutely-positioned descendants of
 *  `.m-screen` with their own close affordances — a swipe starting on one must
 *  not drag the page out from under it. */
function insideOverlay(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== root) {
    const pos = getComputedStyle(node).position;
    if (pos === "absolute" || pos === "fixed") return true;
    node = node.parentElement;
  }
  return false;
}

export function useSwipeBack(
  ref: RefObject<HTMLDivElement | null>,
  onBack: () => void,
  enabled: boolean,
) {
  // Latest-callback ref so the gesture always fires the current render's
  // handler (busy guards included) without re-binding listeners every render.
  const backRef = useRef(onBack);
  useEffect(() => {
    backRef.current = onBack;
  });

  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let lastDx = 0;
    let tracking = false; // touch began in the edge strip, intent still open
    let engaged = false; // horizontal intent recognized — we own this touch

    const setDx = (dx: number) => {
      lastDx = dx;
      el.style.transform = dx > 0 ? `translateX(${dx}px)` : "";
    };

    /** Spring back to rest (cancelled / under-threshold release). */
    const settle = () => {
      const from = lastDx;
      setDx(0);
      if (from > 0 && typeof el.animate === "function") {
        el.animate(
          [{ transform: `translateX(${from}px)` }, { transform: "translateX(0)" }],
          { duration: 200, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
        );
      }
    };

    const onStart = (e: TouchEvent) => {
      tracking = engaged = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE_PX || insideOverlay(e.target, el)) return;
      startX = t.clientX;
      startY = t.clientY;
      startT = performance.now();
      lastDx = 0;
      tracking = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      if (e.touches.length !== 1) {
        tracking = false;
        if (engaged) settle();
        engaged = false;
        return;
      }
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!engaged) {
        // Vertical wins → hand the touch back to native scrolling for good.
        if (Math.abs(dy) > SLOP_PX && Math.abs(dy) > dx) {
          tracking = false;
          return;
        }
        if (!(dx > SLOP_PX && dx > Math.abs(dy) * 1.4)) return;
        engaged = true;
      }
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      setDx(Math.max(0, dx));
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      if (!engaged) return;
      engaged = false;
      // No synthetic click out of a completed drag (it would tap the editor).
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const dx = Math.max(0, e.changedTouches[0].clientX - startX);
      const velocity = dx / Math.max(1, performance.now() - startT);
      if (dx > el.clientWidth * COMMIT_FRACTION || (dx > FLICK_MIN_PX && velocity > FLICK_MIN_VELOCITY)) {
        // Clear the drag transform before navigating — the screen element is
        // reused by the list view, and the existing pop animation takes over.
        setDx(0);
        backRef.current();
      } else {
        settle();
      }
    };

    const onCancel = () => {
      if (!tracking) return;
      tracking = false;
      if (engaged) settle();
      engaged = false;
    };

    el.addEventListener("touchstart", onStart, { capture: true, passive: true });
    el.addEventListener("touchmove", onMove, { capture: true, passive: false });
    el.addEventListener("touchend", onEnd, { capture: true });
    el.addEventListener("touchcancel", onCancel, { capture: true });
    return () => {
      el.removeEventListener("touchstart", onStart, { capture: true });
      el.removeEventListener("touchmove", onMove, { capture: true });
      el.removeEventListener("touchend", onEnd, { capture: true });
      el.removeEventListener("touchcancel", onCancel, { capture: true });
      el.style.transform = "";
    };
  }, [ref, enabled]);
}
