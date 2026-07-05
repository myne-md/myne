// Selection → text projection for the document-statistics selection seam
// (MYND-339). Pure over an `EditorState` (no view, no DOM) so it unit-tests
// without mounting the editor: the concatenated non-empty selection ranges
// joined by `\n`, or `""` when nothing is selected.

import type { EditorState } from "@codemirror/state";

export function selectedRangesText(state: EditorState): string {
  const sel = state.selection;
  if (!sel.ranges.some((r) => !r.empty)) return "";
  return sel.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to))
    .join("\n");
}
