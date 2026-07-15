import { type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Icon, MyneMark, type IconName } from "./Icon";

/** Pill chip / tag. */
export function Chip({
  children,
  active = false,
  style,
}: {
  children: ReactNode;
  active?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        padding: "7px 14px",
        fontSize: 13,
        fontWeight: 500,
        background: active ? "var(--accent-soft)" : "var(--bg-2)",
        border: `1px solid ${active ? "var(--accent)" : "var(--line-1)"}`,
        color: active ? "var(--accent)" : "var(--fg-2)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The account-number specimen chip (mark + monospace identifier). */
export function AccountNumber({
  value = "MY‑4F2A‑9C17‑8E2D‑1B5F‑K",
  style,
}: {
  value?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        padding: "12px 14px",
        ...style,
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 5,
          overflow: "hidden",
          display: "flex",
          flexShrink: 0,
        }}
      >
        <MyneMark size={24} radius={5} />
      </div>
      <span className="t-account-number" style={{ fontSize: 16 }}>
        {value}
      </span>
    </div>
  );
}

/** Floating action button (compose). */
export function Fab({ icon = "plus", style }: { icon?: IconName; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 18,
        background: "var(--accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "var(--shadow-3)",
        ...style,
      }}
    >
      <Icon name={icon} size={26} color="var(--accent-on)" strokeWidth={2} />
    </div>
  );
}

/**
 * Bottom sheet — a **floating rounded card** that slides up over a scrim.
 * Absolutely positioned inside the screen (`.m-screen` is the positioning
 * context). Unlike a flush edge-to-edge sheet, the card is inset on all sides
 * (12px sides + a safe-area bottom gap) and fully rounded, so its 1px border is
 * visible all the way around — the card reads as a distinct object on EVERY
 * theme (AMOLED where card + scrim are both near-black, and Light where a flush
 * sheet blended into a grey scrim band).
 *
 * Animated: the card slides up + the scrim fades in on mount, and reverses on
 * dismiss. Pass `onClose` to make it dismissible — tapping the scrim (anywhere
 * *outside* the card) runs the exit animation then calls `onClose`. To animate
 * the exit for an in-sheet button too (Done/Cancel), use the render-prop form:
 * `<Sheet onClose={fn}>{(close) => …onClick={close}…}</Sheet>`.
 */
const SHEET_MS = 260;

/**
 * Mount-time enter choreography for overlays that slide/fade in: returns a
 * `shown` flag that starts false (the hidden endpoint renders first) and flips
 * true before the first paint. The flip happens in a layout effect AFTER a
 * forced synchronous style+layout pass (`getBoundingClientRect` on the animated
 * element), so the hidden transform/opacity is an established computed value
 * and the CSS transition is guaranteed a "before" state to interpolate from.
 * The old double-`requestAnimationFrame` idiom was a timing heuristic: under
 * main-thread load WebKit can run both callbacks without a style recalc in
 * between, and the overlay pops in with no animation. Exit stays caller-owned —
 * flip `shown` back off via the returned setter, then unmount after the
 * transition (see `Sheet`/`SidePanel`).
 */
export function useEnterTransition(ref: RefObject<HTMLElement | null>): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    ref.current?.getBoundingClientRect();
    setShown(true);
  }, []);
  return [shown, setShown];
}

export function Sheet({
  children,
  grabber = true,
  padded = true,
  onClose,
  style,
}: {
  children: ReactNode | ((close: () => void) => ReactNode);
  grabber?: boolean;
  padded?: boolean;
  onClose?: () => void;
  style?: CSSProperties;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useEnterTransition(cardRef);
  const closingRef = useRef(false);
  // Drag-to-dismiss: the grabber can be pulled down; past a threshold (or a
  // quick flick) it closes, otherwise it springs back.
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ y: number; t: number } | null>(null);

  const close = useCallback(() => {
    if (!onClose || closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, SHEET_MS);
  }, [onClose]);

  const onGrabberDown = useCallback((e: ReactPointerEvent) => {
    if (!onClose) return;
    dragStartRef.current = { y: e.clientY, t: Date.now() };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [onClose]);
  const onGrabberMove = useCallback((e: ReactPointerEvent) => {
    if (!dragStartRef.current) return;
    setDragY(Math.max(0, e.clientY - dragStartRef.current.y));
  }, []);
  const onGrabberUp = useCallback((e: ReactPointerEvent) => {
    const start = dragStartRef.current;
    if (!start) return;
    dragStartRef.current = null;
    setDragging(false);
    const dy = Math.max(0, e.clientY - start.y);
    const velocity = dy / Math.max(1, Date.now() - start.t); // px/ms
    // Dismiss on a long pull (>110px) OR a quick downward flick.
    if (onClose && (dy > 110 || velocity > 0.5)) close();
    setDragY(0);
  }, [onClose, close]);

  const body = typeof children === "function" ? children(close) : children;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div
        onClick={onClose ? close : undefined}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          opacity: shown ? Math.max(0, 1 - dragY / 400) : 0,
          transition: dragging ? "none" : `opacity ${SHEET_MS}ms ease`,
        }}
      />
      <div
        ref={cardRef}
        data-testid="sheet.card"
        style={{
          position: "relative",
          // Phone-identical below 584px (12px side margins); on tablets the
          // card clamps to 560 and centers instead of stretching edge to edge.
          width: "min(560px, calc(100% - 24px))",
          margin: "0 auto",
          marginBottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: 24,
          padding: padded ? "10px 18px 20px" : "10px 0 20px",
          boxShadow: "var(--shadow-3)",
          transform: shown ? `translateY(${dragY}px)` : "translateY(calc(100% + 24px))",
          transition: dragging ? "none" : `transform ${SHEET_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          willChange: "transform",
          ...style,
        }}
      >
        {grabber && (
          <div
            onPointerDown={onGrabberDown}
            onPointerMove={onGrabberMove}
            onPointerUp={onGrabberUp}
            onPointerCancel={onGrabberUp}
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "8px 0 12px",
              margin: "-6px 0 0",
              touchAction: "none",
              cursor: onClose ? "grab" : "default",
            }}
          >
            <div style={{ width: 36, height: 5, borderRadius: 999, background: "var(--line-2)" }} />
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

/**
 * A full-height drawer that slides in from the right edge — the mobile
 * stand-in for the desktop editor's note-context side panel. Same enter/exit
 * choreography as `Sheet` but on the X axis; tapping the scrim runs the exit
 * animation then calls `onClose`. `header` renders a fixed row (it receives the
 * animated `close` so an in-header control can run the exit animation);
 * `children` scroll beneath it.
 */
export function SidePanel({
  header,
  onClose,
  children,
  padBody = true,
}: {
  header: (close: () => void) => ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Pad the scroll body (default). Off for panels that manage their own padding. */
  padBody?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useEnterTransition(panelRef);
  const closingRef = useRef(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, SHEET_MS);
  }, [onClose, setShown]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 45 }}>
      <div
        onClick={close}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          opacity: shown ? 1 : 0,
          transition: `opacity ${SHEET_MS}ms ease`,
        }}
      />
      <div
        ref={panelRef}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: "86%",
          maxWidth: 360,
          display: "flex",
          flexDirection: "column",
          // A clean full-height right drawer separated from the dimmed backdrop by
          // its DROP SHADOW only — no border. A left/top border ran a hard line up
          // into the status-bar (clock) zone, which read as chrome intruding the
          // notch; the shadow gives the edge without any line near the top.
          background: "var(--bg-1)",
          boxShadow: "var(--shadow-3)",
          transform: shown ? "translateX(0)" : "translateX(100%)",
          transition: `transform ${SHEET_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
          willChange: "transform",
        }}
      >
        {/* Safe-area spacer — reserves the status-bar (clock/battery) zone so the
            tabs header never rides up into it. At least 60px because the WebView
            often reports `env(safe-area-inset-top)` as 0; the panel bg fills it,
            so it reads as clean safe space, not a floating border. */}
        <div style={{ height: "max(60px, env(safe-area-inset-top))", flexShrink: 0 }} />
        <div style={{ flex: "none" }}>{header(close)}</div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: padBody ? "8px 12px calc(16px + env(safe-area-inset-bottom, 0px))" : "0 0 calc(env(safe-area-inset-bottom, 0px))" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
