// Shared presentational chrome + the open-intent click matrix for the desktop
// saved-view TABLE + LIST renderers. Split out because the three-way row click
// matrix and the group-heading / empty-state markup were byte-identical across
// the renderers — one edit here instead of three. (The cards renderer keeps its
// own copies: its heading spacing differs and its handlers predate this.)

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { VIEW_TESTID } from "./viewLayout";
import type { CardContextMenuHandler, OpenNoteHandler } from "./cardsView";

/**
 * The note-open click matrix shared by the table + list rows — identical to the
 * cards matrix: click → focused tab (mod → new tab, alt → split), middle-click →
 * new tab, right-click → context menu. Returns the three per-noteId event
 * factories; a renderer wires them only when the matching handler is present.
 */
export function makeViewRowHandlers(
  onOpenNote?: OpenNoteHandler,
  onContextMenu?: CardContextMenuHandler,
) {
  return {
    click: (noteId: string) => (e: ReactMouseEvent) =>
      onOpenNote?.(noteId, { newTab: e.metaKey || e.ctrlKey, toSide: e.altKey }),
    aux: (noteId: string) => (e: ReactMouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        onOpenNote?.(noteId, { newTab: true, toSide: false });
      }
    },
    contextMenu: (noteId: string) => (e: ReactMouseEvent) => {
      if (onContextMenu === undefined) return;
      e.preventDefault();
      onContextMenu(noteId, { x: e.clientX, y: e.clientY });
    },
  };
}

const GROUP_HEADING_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  margin: "var(--space-5) 0 var(--space-2)",
  padding: "0 var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg-2)",
};

const GROUP_COUNT_STYLE: CSSProperties = {
  fontWeight: 400,
  fontSize: 12,
  color: "var(--fg-3)",
};

const EMPTY_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-3)",
  lineHeight: 1.6,
};

/** A group section heading ("<value> · <count>"), reusing the shared testid. */
export function ViewGroupHeading({
  label,
  count,
}: {
  label: string;
  count: number;
}): ReactNode {
  return (
    <div data-testid={VIEW_TESTID.groupHeading} style={GROUP_HEADING_STYLE}>
      <span>{label}</span>
      <span style={GROUP_COUNT_STYLE}>· {count}</span>
    </div>
  );
}

/** The calm centered empty state ("No notes match this view"). */
export function ViewEmpty({ message }: { message: string }): ReactNode {
  return (
    <div data-testid={VIEW_TESTID.empty} style={EMPTY_STYLE}>
      {message}
    </div>
  );
}
