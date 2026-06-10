// `<PaneTree>` — recursive renderer for the editor's split-pane workspace
// (MYND-166, Task 4). A leaf renders a `<PaneView>`; a split node lays its
// children out along its direction (row = side-by-side with vertical
// dividers; column = stacked with horizontal dividers) and draws a
// draggable `<PaneDivider>` between each pair.
//
// Pane sizes are EPHEMERAL renderer state (flex-grow ratios), reset to
// equal whenever a split's child set changes. Persisting them into the
// encrypted workspace blob is Tasks 13/14. The min-size floor reuses
// `CENTER_MIN_WIDTH` (the same governor the sidebars honor), so a pane can
// never be dragged below a usable width — and, with auto-layout, this is
// also what implicitly bounds how deep the tree can nest.

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CENTER_MIN_WIDTH } from "../../screens/layoutClamp";
import type { WorkspaceNode } from "../workspaceState";
import { PaneView, type PaneReadout } from "./PaneView";

/** Minimum pane height (px) for a column split — looser than the width floor. */
const PANE_MIN_HEIGHT = 140;

type PaneTreeProps = {
  node: WorkspaceNode;
  focusedPaneId: string;
  onReadout: (r: PaneReadout) => void;
  /** Window-control clearance (px) handed to the top-LEFT-most leaf of this
   *  subtree, and to the top-RIGHT-most leaf, respectively — so the corner
   *  panes' tab strips clear the traffic lights / sidebar toggles when their
   *  side has no sidebar. Everything else gets 0. */
  leftInset?: number;
  rightInset?: number;
};

export function PaneTree({
  node,
  focusedPaneId,
  onReadout,
  leftInset = 0,
  rightInset = 0,
}: PaneTreeProps) {
  if (node.kind === "leaf") {
    return (
      <PaneView
        leaf={node}
        focused={node.id === focusedPaneId}
        onReadout={onReadout}
        insetLeft={leftInset}
        insetRight={rightInset}
      />
    );
  }
  return (
    <SplitView
      node={node}
      focusedPaneId={focusedPaneId}
      onReadout={onReadout}
      leftInset={leftInset}
      rightInset={rightInset}
    />
  );
}

function SplitView({
  node,
  focusedPaneId,
  onReadout,
  leftInset,
  rightInset,
}: {
  node: Extract<WorkspaceNode, { kind: "split" }>;
  focusedPaneId: string;
  onReadout: (r: PaneReadout) => void;
  leftInset: number;
  rightInset: number;
}) {
  const isRow = node.direction === "row";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [sizes, setSizes] = useState<number[]>(() =>
    node.children.map(() => 1),
  );

  // Reset to equal sizes whenever the child set changes (split / close).
  const count = node.children.length;
  useEffect(() => {
    setSizes(node.children.map(() => 1));
  }, [count]);

  const resize = (i: number, deltaPx: number) => {
    const el = containerRef.current;
    if (el === null) return;
    const total = isRow ? el.clientWidth : el.clientHeight;
    if (total <= 0) return;
    const minPx = isRow ? CENTER_MIN_WIDTH : PANE_MIN_HEIGHT;
    setSizes((prev) => {
      if (prev.length !== node.children.length) return prev;
      const sum = prev.reduce((a, b) => a + b, 0);
      const minGrow = (minPx / total) * sum;
      const dGrow = (deltaPx / total) * sum;
      let a = (prev[i] ?? 1) + dGrow;
      let b = (prev[i + 1] ?? 1) - dGrow;
      if (a < minGrow) {
        b -= minGrow - a;
        a = minGrow;
      }
      if (b < minGrow) {
        a -= minGrow - b;
        b = minGrow;
      }
      if (a < minGrow || b < minGrow) return prev; // can't satisfy both
      const next = [...prev];
      next[i] = a;
      next[i + 1] = b;
      return next;
    });
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isRow ? "row" : "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {node.children.map((child, i) => {
        // The top-left-most leaf is always child[0] (row OR column). The
        // top-right-most leaf is the last child of a row, but child[0] of a
        // column (its top child spans the full width). Hand the insets down
        // that path only; siblings off it get 0.
        const last = node.children.length - 1;
        const childLeft = i === 0 ? leftInset : 0;
        const childRight = isRow
          ? i === last
            ? rightInset
            : 0
          : i === 0
            ? rightInset
            : 0;
        return (
        <Fragment key={child.id}>
          <div
            style={{
              flexGrow: sizes[i] ?? 1,
              flexBasis: 0,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
            }}
          >
            <PaneTree
              node={child}
              focusedPaneId={focusedPaneId}
              onReadout={onReadout}
              leftInset={childLeft}
              rightInset={childRight}
            />
          </div>
          {i < node.children.length - 1 && (
            <PaneDivider isRow={isRow} onResize={(d) => resize(i, d)} />
          )}
        </Fragment>
        );
      })}
    </div>
  );
}

function PaneDivider({
  isRow,
  onResize,
}: {
  isRow: boolean;
  onResize: (deltaPx: number) => void;
}) {
  const dragging = useRef(false);
  const last = useRef(0);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    last.current = isRow ? e.clientX : e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const cur = isRow ? e.clientX : e.clientY;
    onResize(cur - last.current);
    last.current = cur;
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // A single 1px hairline between panes (no thick gap). The wider grab
  // affordance is a transparent overlay straddling the line (±3px), so the
  // visible seam stays 1px while staying easy to grab.
  const lineStyle: CSSProperties = {
    position: "relative",
    flexShrink: 0,
    background: "var(--line-1)",
    ...(isRow ? { width: 1 } : { height: 1 }),
  };
  const hitStyle: CSSProperties = {
    position: "absolute",
    ...(isRow
      ? { top: 0, bottom: 0, left: -3, right: -3, cursor: "col-resize" }
      : { left: 0, right: 0, top: -3, bottom: -3, cursor: "row-resize" }),
    touchAction: "none",
  };

  return (
    <div style={lineStyle}>
      <div
        role="separator"
        aria-orientation={isRow ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        style={hitStyle}
      />
    </div>
  );
}
