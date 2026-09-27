// Tooltip — a themed, fast, viewport-aware hover/focus label (MYND UX polish).
//
// Replaces the native `title=` attribute on icon-only controls, whose browser
// tooltip appears after a ~1s delay, is unstyled (a white OS chip that ignores
// dark mode), and clips at the window edge. This one uses design tokens, appears
// quickly, flips above↔below to stay on-screen, and shows on keyboard focus too.
//
// Minimally invasive: wrap a single trigger — `<Tooltip label="Graph"><button
// …/></Tooltip>` — and keep the trigger's own `aria-label` for the accessibility
// tree (the tooltip is a visual affordance, not the a11y name). The wrapper is a
// zero-padding `inline-flex` span, transparent to the parent's layout; the
// bubble renders through a portal to `document.body` so no `overflow: hidden`
// ancestor can clip it.
//
// ── Three behaviours that are not polish ───────────────────────────────────
//
// **It tracks the pointer.** The bubble's x follows the cursor while the cursor
// is over the trigger, and its y stays pinned to the trigger's edge. Following
// on both axes would put the label under the pointer, over the thing being
// pointed at. On a 40px rail button the travel is small, but it is what makes
// the label feel attached to the hand rather than parked beside a rectangle.
//
// **A second tooltip opens instantly.** Once one has been shown, any tooltip
// entered within `WARM_MS` of the last one closing skips its dwell entirely —
// the `skipDelayDuration` idiom. The dwell exists to keep labels from flashing
// at a cursor crossing the screen; it has no job once the user is demonstrably
// reading labels, and paying it again per button made scanning the ribbon feel
// like waiting. The warmth is module-scope on purpose: it is a property of the
// USER's state, not of any one trigger, so moving between two of them has to
// carry it across two component instances.
//
// **The bubble is clamped into the viewport.** It used to be centred on the
// trigger with `translateX(-50%)` and nothing else, so a label wider than twice
// its trigger's distance from the window edge hung off the side and was cut —
// which on the left ribbon, a column of 40px buttons at x≈24, was every label
// long enough to need one. `max-width` did not help: it bounded the width and
// never the position.

import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { formatChord } from "../../commands/chord";

interface TooltipProps {
  /** The visible label. Empty/undefined → the trigger renders with no tooltip. */
  label?: string;
  /**
   * A canonical chord string (`Mod-k`) rendered as keycaps after the label.
   *
   * The tooltip is where a keyboard-first app teaches its shortcuts, and an
   * icon-only control is where the user most needs telling — the left ribbon is
   * a column of glyphs whose whole vocabulary is otherwise invisible. Pass the
   * EFFECTIVE binding (`effectiveChords`), never the in-code default: a hint
   * that keeps promising a chord the user has rebound is worse than no hint.
   */
  kbd?: string;
  /** Preferred side; flips to the other if it would leave the viewport. */
  placement?: "top" | "bottom";
  /**
   * Hover dwell before showing (ms). Focus shows immediately, and so does a
   * hover inside the warm window below. Default {@link DEFAULT_DELAY_MS}.
   */
  delayMs?: number;
  children: ReactElement;
}

const GAP = 6; // px between trigger and bubble
/** Keep the bubble this far from the window edge when clamping. */
const EDGE = 8;

/**
 * The dwell before a cold tooltip opens.
 *
 * 350ms was the original and it reads as a hitch: the user has arrived, the
 * cursor has stopped, and nothing happens for a third of a second. This is long
 * enough that a pointer crossing the ribbon on its way elsewhere does not
 * trigger a cascade of labels, and short enough that a deliberate stop is
 * answered while it still feels like an answer.
 */
const DEFAULT_DELAY_MS = 140;

/**
 * How long the "somebody is reading tooltips" state survives the last one
 * closing. Long enough to cover moving down a rail of buttons or across a
 * toolbar; short enough that coming back to the same control minutes later
 * pays the dwell again, which is the case the dwell is actually for.
 */
const WARM_MS = 600;

/**
 * When the last tooltip closed, process-wide. Module scope because warmth
 * belongs to the user rather than to a trigger, and two adjacent buttons are
 * two component instances with no other channel between them.
 */
let lastClosedAt = 0;

/** Test-only: forget that any tooltip has been shown. */
export function resetTooltipWarmth(): void {
  lastClosedAt = 0;
}

const BUBBLE_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 2000, // above the settings modal (1000) and every in-editor popover
  // Inverted chip — stands clear of the surface it floats over in every theme.
  background: "var(--fg-1)",
  color: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  lineHeight: 1.3,
  padding: "4px 8px",
  borderRadius: "var(--radius-1)",
  boxShadow: "var(--shadow-2)",
  whiteSpace: "nowrap",
  maxWidth: `calc(100vw - ${EDGE * 2}px)`,
  pointerEvents: "none", // never eat the pointer that's aiming at the trigger
};

interface Pos {
  /** The x the bubble WANTS to centre on — the pointer, or the trigger's middle. */
  centerX: number;
  top: number;
  side: "top" | "bottom";
}

export function Tooltip({
  label,
  kbd,
  placement = "top",
  delayMs = DEFAULT_DELAY_MS,
  children,
}: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<Pos | null>(null);
  // The clamped left, measured after the bubble exists. Null until then, and
  // the bubble stays hidden for that one frame rather than painting off-screen
  // and jumping — a tooltip that arrives in the wrong place first is worse
  // than one that arrives a frame later.
  const [left, setLeft] = useState<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  /** Place the bubble against the trigger, centred on `pointerX` if given. */
  const show = useCallback(
    (pointerX?: number) => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Flip to the other side if the preferred one would run off-screen.
      const side: "top" | "bottom" =
        placement === "top" && r.top < 48
          ? "bottom"
          : placement === "bottom" && window.innerHeight - r.bottom < 48
            ? "top"
            : placement;
      setPos({
        centerX: pointerX ?? r.left + r.width / 2,
        top: side === "top" ? r.top - GAP : r.bottom + GAP,
        side,
      });
    },
    [placement],
  );

  // Clamp once the bubble has a measurable width. `useLayoutEffect` so the
  // correction lands in the same paint as the bubble's first appearance.
  useLayoutEffect(() => {
    if (pos === null) return;
    const w = bubbleRef.current?.offsetWidth ?? 0;
    const half = w / 2;
    const max = window.innerWidth - EDGE - half;
    const min = EDGE + half;
    // `max < min` means the bubble is wider than the window; centring it is
    // then the least-bad answer and `max-width` has already bounded it.
    setLeft(max < min ? window.innerWidth / 2 : Math.min(Math.max(pos.centerX, min), max));
  }, [pos]);

  const open = useCallback(
    (pointerX: number) => {
      clearTimer();
      // Warm: somebody is reading labels, so do not make them wait again.
      if (Date.now() - lastClosedAt < WARM_MS) {
        show(pointerX);
        return;
      }
      timerRef.current = window.setTimeout(() => show(pointerX), delayMs);
    },
    [show, delayMs],
  );

  const openNow = useCallback(() => {
    clearTimer();
    show();
  }, [show]);

  const close = useCallback(() => {
    clearTimer();
    setPos((p) => {
      // Only start the warm window if something was actually showing. A
      // pointer that crossed a trigger without dwelling long enough must not
      // buy the NEXT trigger an instant open, or the dwell would be defeated
      // by the very traffic it exists to ignore.
      if (p !== null) lastClosedAt = Date.now();
      return null;
    });
    setLeft(null);
  }, []);

  useEffect(() => () => clearTimer(), []);

  if (!label) return children;

  return (
    <>
      <span
        ref={wrapRef}
        style={{ display: "inline-flex", alignItems: "center" }}
        onMouseEnter={(e) => open(e.clientX)}
        // While open the bubble rides the pointer; while still dwelling this
        // keeps the pending open aimed at where the cursor actually is, so the
        // label does not appear at the spot the pointer entered from.
        onMouseMove={(e) => {
          if (pos !== null) setPos((p) => (p === null ? p : { ...p, centerX: e.clientX }));
          else if (timerRef.current !== undefined) open(e.clientX);
        }}
        onMouseLeave={close}
        onFocusCapture={openNow}
        onBlurCapture={close}
        // A press dismisses immediately — the label has done its job and the
        // click is about to change the view underneath it.
        onMouseDownCapture={close}
      >
        {cloneElement(children)}
      </span>
      {pos !== null &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            style={{
              ...BUBBLE_STYLE,
              left: left ?? pos.centerX,
              top: pos.top,
              // Hidden for the single frame before the clamp has measured.
              visibility: left === null ? "hidden" : "visible",
              transform:
                pos.side === "top"
                  ? "translate(-50%, -100%)"
                  : "translate(-50%, 0)",
            }}
          >
            {label}
            {kbd !== undefined && (
              // Inverted chip: the keycaps' own `--paper-3`/`--line-2` would
              // vanish against `--fg-1`, so they are re-tinted here rather than
              // in `Keycaps`, which is correct on every OTHER surface.
              <span
                aria-hidden="true"
                style={{
                  marginInlineStart: 8,
                  opacity: 0.75,
                  fontFeatureSettings: '"tnum"',
                }}
              >
                {formatChord(kbd)}
              </span>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
