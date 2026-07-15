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
/** X of the FIRST ancestor rail — centered under a top-level folder's icon so
 *  the line reads as descending from that folder. A folder row's icon spans
 *  `[BASE_PADDING_LEFT, +iconSize]` = `[8, 25]` (FolderRow), so its center is
 *  `8 + 17/2 = 16.5`; a 1px rail at `left:16` renders its own center at 16.5,
 *  landing on the icon center. The folder icon was moved left (padding 12→8) to
 *  meet the rail rather than pushing the rail right into the note area. */
const RAIL_X0 = 16;
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
