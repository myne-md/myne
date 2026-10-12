// `<AnchoredPanel>`, a small panel that hangs off a trigger and is drawn in the
// BODY, not inside its trigger's ancestors (myne-md/myne#848).
//
// ── The failure it closes ──────────────────────────────────────────────────
// Two panels were written by hand, both `position: absolute` inside their
// trigger, and both were clipped by an ancestor's `overflow`. The agent hub's
// row menu lost its lower half on the last visible card, because the rail
// scrolls; the model-path panel in Settings would have lost a side, because the
// panel column clips too. Nothing reported either: the panel and every item in
// it are in the DOM, and a test that finds one by testid passes on a panel the
// user cannot read.
//
// The second hand-written copy is why this is a primitive rather than two
// fixes. Both need the same four things, measure the anchor, pick a side with
// room, escape the clipping ancestor, and dismiss on an outside press, and
// four things re-derived per call site is four things that drift.
//
// ── What it does NOT own ───────────────────────────────────────────────────
// The panel's own look. Background, border, radius and padding stay with the
// caller, because a menu and a path disclosure do not want the same chrome.
// This owns placement, the portal and dismissal, and nothing else.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { placeMenu } from "./menuPlacement";

interface AnchoredPanelProps {
  open: boolean;
  /** Called for every dismissal this owns: outside press, Escape, reflow. */
  onClose: () => void;
  /**
   * The element the panel hangs off. A ref rather than a child, so the trigger
   * keeps its own place in the tree and the panel can be rendered from anywhere
   * in the same component.
   */
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Minimum width in px. Default 160. */
  minWidth?: number;
  /** Which edge of the anchor to align to. Default `end` (the right edge). */
  align?: "start" | "end";
  /** The caller's chrome. Merged OVER the placement, so a caller can never
   *  accidentally unset `position`. */
  style?: CSSProperties;
  testId?: string;
}

/** How far the panel is kept from the window's edges. */
const EDGE = 8;

export function AnchoredPanel({
  open,
  onClose,
  anchorRef,
  children,
  minWidth = 160,
  align = "end",
  style,
  testId,
}: AnchoredPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<CSSProperties | null>(null);

  // Measure once the panel exists. `placeMenu` owns the vertical half, which
  // side has room, and how tall the panel may be, because these hang off rows
  // near the bottom of a window as often as the middle of one.
  //
  // **A PASSIVE effect, and that is load-bearing.** React commits layout
  // effects bottom-up, so a child's `useLayoutEffect` runs BEFORE its parent's
  // ref is attached, and the panel is usually rendered INSIDE the element it
  // anchors to (the hub's menu lives in the row's actions cluster). Measured in
  // a layout effect, the anchor was still `null`, the panel never got coords,
  // and the menu simply did not open. A passive effect runs after the whole
  // commit, so the ref is attached by then. Nothing flashes in the meantime:
  // until coords exist the panel renders nothing at all.
  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const el = anchorRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const width = Math.max(minWidth, r.width);
    // Right-aligned to the anchor, or left-aligned to it, and clamped at BOTH
    // window edges either way. The clamp is not decoration: a panel wider than
    // the room beside its anchor would otherwise run off the screen with no way
    // to scroll to it, which is the same "the panel is in the DOM and the user
    // cannot read it" failure the portal exists to close.
    const wanted = align === "end" ? r.right - width : r.left;
    const left = Math.max(
      EDGE,
      Math.min(wanted, window.innerWidth - width - EDGE),
    );
    setCoords({
      ...placeMenu(r, window.innerHeight, { cap: 280 }),
      left,
      minWidth: width,
    });
  }, [open, anchorRef, minWidth, align]);

  // Dismissal. A fixed panel would otherwise drift away from its anchor on
  // scroll, so scroll CLOSES it rather than repositioning it: these panels hold
  // a handful of items and re-opening is one click, where chasing the anchor
  // would be a second positioning path to keep correct.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onReflow = () => onClose();
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, onClose, anchorRef]);

  // `children` are captured in a callback so the portal's identity does not
  // change on every render of the parent.
  const render = useCallback(
    () =>
      createPortal(
        <div
          ref={panelRef}
          data-testid={testId}
          style={{
            position: "fixed",
            // **A role, not a number** (review finding): this panel is one
            // primitive serving three call sites, one of which renders inside
            // `SettingsModal`, whose own backdrop is `--z-overlay`-class. A
            // literal 60 put the panel UNDER that backdrop, where its items were
            // visible in the DOM and unclickable, which no test could see. The
            // panel only exists while it is open and any outside press closes
            // it, so the higher role is the safe one for both shapes.
            zIndex: "var(--z-overlay)",
            overflowY: "auto",
            // The caller's chrome last, so it can restyle but not unplace.
            ...style,
            ...coords,
          }}
        >
          {children}
        </div>,
        document.body,
      ),
    [children, testId, style, coords],
  );

  if (!open || coords === null) return null;
  return render();
}
