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
// A context menu is the same panel with a cursor for an anchor: `point` feeds
// a zero-size box into the same placement, so a right-click menu flips up and
// clamps at the window edges without a second copy of that arithmetic.
//
// ── What it does NOT own ───────────────────────────────────────────────────
// The panel's own look. Background, border, radius and padding stay with the
// caller, because a menu and a path disclosure do not want the same chrome.
// This owns placement, the portal and dismissal, and nothing else.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  /**
   * Open at a CURSOR POINT instead of off the anchor (a context menu). The
   * anchor is still the element an outside press must not dismiss, so
   * `anchorRef` stays required; only the placement moves. The point is treated
   * as a zero-size trigger, so it gets the same flip-up and edge clamp.
   */
  point?: { x: number; y: number } | null;
  children: ReactNode;
  /** Minimum width in px. Default 160. */
  minWidth?: number;
  /**
   * Ceiling on the panel's width in px. Passed as a prop rather than through
   * `style`, because the placement writes its own `maxWidth` and would
   * otherwise drop the caller's. Always additionally capped at the window's
   * width. Default: no ceiling beyond the window.
   */
  maxWidth?: number;
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
  point = null,
  children,
  minWidth = 160,
  maxWidth,
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
    // The box the panel hangs off. A cursor point is a zero-size box, so the
    // context-menu shape reuses the whole path below rather than deriving a
    // second arithmetic of its own.
    let r: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
    };
    if (point !== null) {
      r = {
        left: point.x,
        top: point.y,
        right: point.x,
        bottom: point.y,
        width: 0,
      };
    } else {
      const el = anchorRef.current;
      if (el === null) return;
      const box = el.getBoundingClientRect();
      r = {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
      };
    }
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
      // A hard ceiling as well as a clamp: whatever the content does, the panel
      // cannot be wider than the window it has to live in, or than the cap the
      // caller named.
      maxWidth: Math.min(
        maxWidth ?? Number.POSITIVE_INFINITY,
        window.innerWidth - EDGE * 2,
      ),
    });
  }, [open, anchorRef, minWidth, maxWidth, align, point?.x, point?.y]);

  // **The second pass, and it is here because the first cannot know the width.**
  // (myne-md/myne#867.) `left` above is clamped against `max(minWidth,
  // anchor.width)`, which is the ANCHOR's box. The panel's own box can be wider
  // than that (it is the content that decides), and when it is, the panel
  // overhangs the window edge the clamp was measured against, which is how a
  // model's location panel rendered partly off screen. So once the panel exists,
  // measure IT and pull it back.
  //
  // Runs after every render rather than on a dependency list, because "how wide
  // is this panel" has no dependency that can be named: a font loading, a
  // wrapped line or a longer path all change it. It costs one measurement, and
  // `setCoords` returns `prev` unchanged when the number does not move, so
  // React bails out of the re-render and there is no loop.
  useLayoutEffect(() => {
    if (!open) return;
    const el = panelRef.current;
    if (el === null) return;
    const width = el.getBoundingClientRect().width;
    // 0 in jsdom, and 0 for any box that has not been laid out yet: there is
    // nothing to clamp against, and clamping to it would park the panel at the
    // left edge.
    if (width === 0) return;
    setCoords((prev) => {
      if (prev === null) return prev;
      const left = typeof prev.left === "number" ? prev.left : EDGE;
      const overhang = left + width - (window.innerWidth - EDGE);
      if (overhang <= 0) return prev;
      return { ...prev, left: Math.max(EDGE, left - overhang) };
    });
  });

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
