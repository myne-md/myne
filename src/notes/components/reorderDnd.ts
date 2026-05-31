// Shared drag-to-reorder helpers for the sidebar — geometry + insertion
// indicator — used by both the note rows (`NoteList`) and folder rows
// (`FolderRow`) so the two reorder gestures stay pixel-identical.

import type { CSSProperties, DragEvent } from "react";

/** Which half of the hovered row the cursor is over — the reorder insertion edge. */
export function dragEdge(e: DragEvent<HTMLElement>): "above" | "below" {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? "above" : "below";
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
