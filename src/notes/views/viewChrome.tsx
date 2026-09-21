// Shared presentational chrome + the open-intent click matrix for the desktop
// saved-view TABLE + LIST renderers. Split out because the three-way row click
// matrix and the group-heading / empty-state markup were byte-identical across
// the renderers — one edit here instead of three. (The cards renderer keeps its
// own copies: its heading spacing differs and its handlers predate this.)

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { VIEW_TESTID } from "./viewLayout";
import type { CardContextMenuHandler, OpenNoteHandler } from "./cardsView";

/**
 * The note-open click matrix shared by the table + list rows — identical to the
 * cards matrix: click → focused tab (mod → new tab, alt → split), middle-click →
 * new tab, right-click → context menu. Returns the per-noteId event
 * factories; a renderer wires them only when the matching handler is present.
 *
 * `key` is the keyboard half of that matrix (myne-md/myne#728). The rows were
 * `role="button"` with `tabIndex={-1}` and no key handler, so every centre-column
 * view mode could be operated by the mouse and by nothing else: no Tab reached a
 * row and no key opened one. It carries the same modifier matrix as `click`, so
 * the keyboard is not a lesser path than the mouse.
 *
 * Each row is its own Tab stop rather than one roving stop for the group, and
 * that is the ARIA answer rather than a shortcut. The sidebar is a `tree`, a
 * composite widget whose pattern REQUIRES exactly one stop with arrow keys
 * inside it; these rows carry no composite role at all, they are a run of
 * buttons in document flow, and a button's natural place is the Tab order.
 * Virtualization decides it a second time: the shared `useRovingFocus` moves
 * focus by DOM POSITION inside the container, and `VirtualList` mounts only the
 * scrolled window, so position N is the Nth RENDERED row rather than the Nth
 * row. Plain Tab stops have no such mismatch, and they walk the whole list
 * without a `scrollToIndex` the virtualizer does not have: focusing a buffered
 * off-screen row scrolls it into view, which mounts the next buffer.
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
    key: (noteId: string) => (e: ReactKeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Space on a focused row would otherwise page the scroll container, so
      // the row would open AND the list would jump.
      e.preventDefault();
      onOpenNote?.(noteId, { newTab: e.metaKey || e.ctrlKey, toSide: e.altKey });
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
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-2)",
};

const GROUP_COUNT_STYLE: CSSProperties = {
  fontWeight: "var(--weight-regular)",
  fontSize: 12,
  color: "var(--fg-3)",
};

const EMPTY_STYLE: CSSProperties = {
  margin: "12vh auto 0",
  maxWidth: 420,
  textAlign: "center",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
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
