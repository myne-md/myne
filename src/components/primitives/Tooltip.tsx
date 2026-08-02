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

import {
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** The visible label. Empty/undefined → the trigger renders with no tooltip. */
  label?: string;
  /** Preferred side; flips to the other if it would leave the viewport. */
  placement?: "top" | "bottom";
  /** Hover dwell before showing (ms). Focus shows immediately. Default 350. */
  delayMs?: number;
  children: ReactElement;
}

const GAP = 6; // px between trigger and bubble

const BUBBLE_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 2000, // above the settings modal (1000) and every in-editor popover
  // Inverted chip — stands clear of the surface it floats over in every theme.
  background: "var(--fg-1)",
  color: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1.3,
  padding: "4px 8px",
  borderRadius: "var(--radius-1)",
  boxShadow: "var(--shadow-2)",
  whiteSpace: "nowrap",
  maxWidth: "min(280px, calc(100vw - 16px))",
  pointerEvents: "none", // never eat the pointer that's aiming at the trigger
};

export function Tooltip({
  label,
  placement = "top",
  delayMs = 350,
  children,
}: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    side: "top" | "bottom";
  } | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  const show = useCallback(() => {
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
    const centerX = r.left + r.width / 2;
    setPos({
      left: centerX,
      top: side === "top" ? r.top - GAP : r.bottom + GAP,
      side,
    });
  }, [placement]);

  const open = useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(show, delayMs);
  }, [show, delayMs]);

  const openNow = useCallback(() => {
    clearTimer();
    show();
  }, [show]);

  const close = useCallback(() => {
    clearTimer();
    setPos(null);
  }, []);

  useEffect(() => () => clearTimer(), []);

  if (!label) return children;

  return (
    <>
      <span
        ref={wrapRef}
        style={{ display: "inline-flex", alignItems: "center" }}
        onMouseEnter={open}
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
            role="tooltip"
            style={{
              ...BUBBLE_STYLE,
              left: pos.left,
              top: pos.top,
              transform:
                pos.side === "top"
                  ? "translate(-50%, -100%)"
                  : "translate(-50%, 0)",
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
