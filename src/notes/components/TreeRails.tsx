// Indent guide rails for the sidebar file-tree (folders + notes). One thin
// vertical line per ancestor depth level, so the children of an open folder
// read as a nested tree — the same tree-line affordance the Outline tab uses.
//
// Drawn as ABSOLUTE overlays inside each row's `position: relative` box so they
// add no layout (the existing depth `paddingLeft` still offsets the content) and
// so a single line can BRIDGE the inter-row gap: each rail extends `ROW_GAP` px
// below its row (`bottom: -ROW_GAP`) to meet the next row's rail, producing a
// continuous line down each sibling group despite the rounded-pill row gap.

import type { CSSProperties } from "react";

/** Horizontal step per depth level — matches `NoteList.NOTE_INDENT_PER_LEVEL`
 *  and `FolderRow.INDENT_PER_LEVEL` (18). */
const RAIL_STEP = 18;
/** X of the FIRST ancestor rail — sits within a top-level folder's icon so the
 *  line reads as descending from that folder. */
const RAIL_X0 = 17;
/** Inter-row gap the rail bridges — matches `rowBaseStyle.marginBottom` (3). */
const ROW_GAP = 3;

const railStyle = (x: number): CSSProperties => ({
  position: "absolute",
  left: x,
  top: 0,
  bottom: -ROW_GAP,
  borderLeft: "1px solid var(--line-1)",
  pointerEvents: "none",
});

/**
 * `depth` ancestor guide rails for a tree row. Renders nothing at the root
 * (`depth <= 0`). Each row that hosts these must be `position: relative` (the
 * note-row wrapper and `FolderRow` root both are).
 */
export function TreeRails({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, k) => (
        <span key={k} aria-hidden style={railStyle(RAIL_X0 + k * RAIL_STEP)} />
      ))}
    </>
  );
}
