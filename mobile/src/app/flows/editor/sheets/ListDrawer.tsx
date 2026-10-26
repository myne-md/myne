import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { motionDurationMs, motionEasing } from "@myne/client-core/motion";
import { isRtl } from "../../../../lib/util";

/**
 * The folded band's list surface (myne-md/myne#918).
 *
 * The band is ONE column: the note owns the full width the device unfolds to, so
 * the list cannot be a persistent pane and must not replace the note either,
 * which is what the phone layout does. It arrives over the note instead, on the
 * inline-start edge, leaving the page underneath at its own width: an overlay,
 * not a push, so nothing reflows while it is open.
 *
 * It is a modal surface for assistive technology (`aria-modal`) because the note
 * behind it is not reachable while it is open, it TRAPS focus for the same
 * reason (the note is `inert`, so tabbing past the last control would land on
 * browser chrome), and it restores focus to whatever held it. Escape, the scrim,
 * a swipe toward its own edge and the note's own back affordance all close it.
 *
 * Not desktop-twin material: desktop has no band and no drawer, and mobile is
 * the only client with a window this shape.
 */

/** Wide enough for a title and a snippet, narrow enough to leave the page. */
const DRAWER_WIDTH = 320;
const DISMISS_DISTANCE = 80;
/** A flick short of DISMISS_DISTANCE still counts, but not a jitter. */
const MIN_FLICK_DISTANCE = 24;
const DISMISS_VELOCITY = 0.5;
/** Horizontal travel before a press becomes a drag. Below it, the press belongs
 *  to whatever is under the pointer: the list's own rows and buttons. */
const DRAG_THRESHOLD = 8;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ListDrawer({
  label,
  onClose,
  children,
  returnFocusTo,
}: {
  /** Accessible name for the surface. Translated by the caller. */
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Where focus goes on close. The caller knows the note behind the drawer is
   *  the surface the user came from; `document.activeElement` at mount time is
   *  often already the body, which would strand a keyboard user there. */
  returnFocusTo?: HTMLElement | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; t: number; captured: boolean } | null>(null);
  const closingRef = useRef(false);
  const rtl = isRtl();
  const duration = motionDurationMs("--duration-slow");
  const easing = motionEasing("--ease-standard");

  // Paint one frame closed, then flip, so the slide actually runs. Under Reduce
  // Motion `motionDurationMs` answers 0, which makes it instant rather than
  // merely faster.
  useLayoutEffect(() => {
    panelRef.current?.getBoundingClientRect();
    setShown(true);
  }, []);

  // Exit the way the sheets do: start the slide, then hand the parent the
  // unmount after it, so the drawer leaves instead of vanishing.
  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, duration);
  }, [duration, onClose]);

  // Focus moves in on open and back to whatever held it on close. Losing that
  // second half is how a drawer strands a keyboard user at the document root.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      const target = returnFocusTo?.isConnected ? returnFocusTo : previous;
      if (target && target.isConnected && target !== document.body) target.focus();
    };
    // `returnFocusTo` is read once, on the close that this effect's cleanup
    // performs; re-running it would move focus back into the drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Tab-cycle trap, the same shape `MemorySheet` uses: the surface claims
  // `aria-modal`, so focus must not leave it while it is open. Wraps
  // last-to-first and first-to-last, and pulls back a focus that starts outside.
  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const root = panelRef.current;
    if (root === null) return;
    const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === null || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === null || !root.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  // A press only becomes a drag after real horizontal travel, and the capture
  // is taken THEN rather than on pointerdown. Capturing on down retargets the
  // pointer's compatibility mouse events to the panel, so a tap on a note row
  // inside the drawer would be delivered to the drawer instead of the row
  // (myne-md/myne#918 review, D7; `Sheet` captures on its grabber for the same
  // reason).
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { x: event.clientX, t: Date.now(), captured: false };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      // Only the closing direction moves it; dragging inward is not a gesture.
      const travel = rtl ? Math.max(0, dx) : Math.max(0, -dx);
      if (!start.captured) {
        if (travel < DRAG_THRESHOLD) return;
        start.captured = true;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
      setDragX(rtl ? Math.max(0, dx) : Math.min(0, dx));
    },
    [rtl],
  );

  const endDrag = useCallback(() => {
    dragStartRef.current = null;
    setDragging(false);
    setDragX(0);
  }, []);

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (!start) return;
      if (!start.captured) {
        // A press that never became a drag belongs to the row under it.
        endDrag();
        return;
      }
      const dx = event.clientX - start.x;
      const travelled = rtl ? Math.max(0, dx) : Math.max(0, -dx);
      const velocity = travelled / Math.max(1, Date.now() - start.t);
      endDrag();
      const flick = travelled > MIN_FLICK_DISTANCE && velocity > DISMISS_VELOCITY;
      if (travelled > DISMISS_DISTANCE || flick) close();
    },
    [close, endDrag, rtl],
  );

  // A cancelled gesture (a scroll the OS decides is a pan, a call arriving) must
  // not leave the drawer half-dragged with its transition off.
  const onPointerCancel = useCallback(() => {
    endDrag();
  }, [endDrag]);

  const closedOffset = rtl ? "100%" : "-100%";

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: "var(--z-floating)", pointerEvents: "none" }}>
      <div
        // The scrim is a touch convenience, not a control (the same call the
        // sheets make): the drawer's own list and the Escape key are the
        // reachable ways out, and an unnamed full-screen button in front of the
        // page would be announced by nothing useful.
        role="presentation"
        data-testid="notes.list-drawer-scrim"
        onClick={close}
        style={{
          position: "absolute",
          inset: 0,
          background: "var(--scrim)",
          opacity: shown ? 1 : 0,
          pointerEvents: "auto",
          transition: `opacity ${duration}ms ${easing}`,
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        data-testid="notes.list-drawer"
        onKeyDown={onPanelKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        style={{
          position: "absolute",
          insetBlock: 0,
          insetInlineStart: 0,
          width: DRAWER_WIDTH,
          maxWidth: "85%",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--paper-2)",
          borderInlineEnd: "1px solid var(--line-1)",
          boxShadow: "var(--shadow-3)",
          outline: "none",
          pointerEvents: "auto",
          transform: shown ? `translateX(${dragX}px)` : `translateX(${closedOffset})`,
          transition: dragging ? "none" : `transform ${duration}ms ${easing}`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
