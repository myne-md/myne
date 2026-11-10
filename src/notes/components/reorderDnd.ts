// Shared drag-to-reorder helpers for the sidebar — geometry + insertion
// indicator — used by both the note rows (`NoteList`) and folder rows
// (`FolderRow`) so the two reorder gestures stay pixel-identical.

import type { CSSProperties, DragEvent } from "react";

/** The MIME a folder drag publishes its source path under, so a drop can resolve
 *  it without the drag's ref (a `dragend` mid-gesture clears that). */
export const FOLDER_DRAG_MIME = "application/x-myne-folder";

/** Which half of the hovered row the cursor is over — the reorder insertion edge. */
export function dragEdge(e: DragEvent<HTMLElement>): "above" | "below" {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? "above" : "below";
}

/**
 * Three-zone hit test for a row that is BOTH a reorder target and a drop-INTO
 * target (folder rows under a note drag, MYND-183): the top/bottom quarters
 * reorder the dragged item as a sibling (`"above"` / `"below"`), the middle half
 * drops it INTO the folder (`"into"`). Pairs with `dragEdge` (2-zone) for rows
 * that have no "into" affordance (note rows).
 */
export function dragZone(e: DragEvent<HTMLElement>): "above" | "into" | "below" {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < rect.height * 0.25) return "above";
  if (y > rect.height * 0.75) return "below";
  return "into";
}

/** Top/bottom 2px accent bar marking a reorder insertion point. */
export function insertionLineStyle(edge: "above" | "below"): CSSProperties {
  return {
    position: "absolute",
    left: 8,
    right: 8,
    top: edge === "above" ? 0 : undefined,
    bottom: edge === "below" ? 0 : undefined,
    height: 2,
    background: "var(--accent)",
    borderRadius: 1,
    pointerEvents: "none",
  };
}

/**
 * Horizontal sibling of {@link dragEdge}: which half of the hovered item the
 * cursor is over along the X axis — the insertion edge for a left/right reorder
 * (the bottom-bar item drag, MYND bottom-bar customization).
 */
export function dragEdgeX(e: DragEvent<HTMLElement>): "before" | "after" {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientX < rect.left + rect.width / 2 ? "before" : "after";
}

/**
 * Horizontal sibling of {@link insertionLineStyle}: a left/right 2px accent bar
 * marking a horizontal reorder insertion point (inset vertically so it reads as
 * a caret between two short bar items).
 */
export function insertionLineStyleX(edge: "before" | "after"): CSSProperties {
  return {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: edge === "before" ? -7 : undefined,
    right: edge === "after" ? -7 : undefined,
    width: 2,
    background: "var(--accent)",
    borderRadius: 1,
    pointerEvents: "none",
  };
}
