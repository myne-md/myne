// Draggable + keyboard-operable sidebar resize handle (MYND-137).
//
// A thin hit-target on a sidebar's inner edge. Pointer-drag resizes the
// sidebar live; arrow keys resize from the keyboard; Enter/Space toggles
// the sidebar's collapsed state. Exposes `role="separator"` +
// `aria-orientation="vertical"` + `aria-valuenow/min/max` + an accessible
// label so it satisfies the MYND-93 a11y gate.
//
// The element is positioned absolutely on the inner edge of its sidebar
// wrapper (which must be `position: relative`), straddling the 1px border
// so the border is the rest-state visual and the highlight bar centers on
// it. Drag uses Pointer Capture — all move/up events route to the element
// itself, so there are no window-level listeners to leak and the effect
// model stays StrictMode-idempotent (React attaches/detaches the handlers
// with the element; a double-invoked render cannot double-bind a global).
//
// Styling is token-only (no hex, no Tailwind):
//   rest    → transparent (the sidebar's `--line-1` border shows through)
//   hover   → 2px `--line-2` bar
//   focus   → 2px `--accent` bar (the keyboard focus indicator)
//   active  → 2px `--accent` bar (dragging)

import { useRef, useState, type CSSProperties, type RefObject } from "react";

export interface ResizeHandleProps {
  /** Which sidebar this handle resizes — determines drag-direction sign
   *  and edge placement (`"left"` sits on the left sidebar's right edge,
   *  `"right"` on the right sidebar's left edge). */
  side: "left" | "right";
  /** Current sidebar width (px) — the drag base and `aria-valuenow`. */
  width: number;
  /** Lower width bound (px) — `aria-valuemin`. */
  min: number;
  /** Upper width bound (px) — `aria-valuemax`. */
  max: number;
  /** The three-pane row element, measured live so the center-pane minimum
   *  can be honored during a drag/keyboard resize. */
  containerRef: RefObject<HTMLElement | null>;
  /** Called with the raw requested width + the live container width; the
   *  parent clamps (per-side range + center minimum) and commits state. */
  onResize: (rawWidth: number, containerWidth: number) => void;
  /** Called on Enter/Space — toggles the sidebar's collapsed state. */
  onToggleCollapse: () => void;
  /** Accessible label, e.g. "Resize notes sidebar". */
  label: string;
  /** Arrow-key step (px). Default 8. */
  keyboardStep?: number;
  /** Shift+Arrow step (px). Default 32. */
  keyboardBigStep?: number;
}

const HIT_ZONE = 8;

export function ResizeHandle({
  side,
  width,
  min,
  max,
  containerRef,
  onResize,
  onToggleCollapse,
  label,
  keyboardStep = 8,
  keyboardBigStep = 32,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dragStart = useRef<{
    x: number;
    width: number;
    containerWidth: number;
  } | null>(null);

  const containerWidth = (): number =>
    containerRef.current?.getBoundingClientRect().width ?? NaN;

  // A drag delta to the right is +dx; for the left sidebar that widens it,
  // for the right sidebar (whose handle is on its left edge) it narrows it.
  const widthFromDelta = (startWidth: number, dx: number): number =>
    side === "left" ? startWidth + dx : startWidth - dx;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only.
    if (e.button !== 0) return;
    e.preventDefault();
    // Cache the container width once at drag-start — the three-pane row
    // can't change width mid-drag, so re-reading getBoundingClientRect on
    // every pointermove (60+/s) would be a needless layout read.
    dragStart.current = { x: e.clientX, width, containerWidth: containerWidth() };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    const dx = e.clientX - dragStart.current.x;
    onResize(
      widthFromDelta(dragStart.current.width, dx),
      dragStart.current.containerWidth,
    );
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggleCollapse();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? keyboardBigStep : keyboardStep;
      // ArrowRight widens the left sidebar / narrows the right; ArrowLeft
      // the inverse — matching the on-screen drag direction.
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const signed = side === "left" ? dir * step : -dir * step;
      onResize(width + signed, containerWidth());
    }
  };

  const accent = dragging || focused;
  const barColor = accent
    ? "var(--accent)"
    : hovered
      ? "var(--line-2)"
      : "transparent";
  const barWidth = accent || hovered ? 2 : 0;

  const wrapStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: HIT_ZONE,
    // Straddle the sidebar's inner-edge border so the highlight centers on it.
    ...(side === "left"
      ? { right: 0, transform: "translateX(50%)" }
      : { left: 0, transform: "translateX(-50%)" }),
    cursor: "col-resize",
    display: "flex",
    justifyContent: "center",
    alignItems: "stretch",
    touchAction: "none",
    zIndex: 2,
    // Keep the handle out of the default focus outline box; the bar is the
    // focus indicator (token-only, per the design canon).
    outline: "none",
  };

  const barStyle: CSSProperties = {
    width: barWidth,
    background: barColor,
    borderRadius: "var(--radius-1)",
    transition: "background var(--duration-fast) var(--ease-standard), width var(--duration-fast) var(--ease-standard)",
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      style={wrapStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        dragStart.current = null;
        setDragging(false);
      }}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={barStyle} />
    </div>
  );
}
