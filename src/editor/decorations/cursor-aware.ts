// Cursor-aware reveal helper shared by all line-scoped Decoration.mark
// extensions in `src/editor/decorations/`.
//
// Per `editor-mvp-baseline` PRD (myne-agents/features/editor-mvp-baseline/prd.md):
// when the cursor's line equals the decoration's line, the decoration must
// LIFT so the user can see + edit the raw markdown syntax. When the cursor
// moves off the line, the decoration reapplies.
//
// `isCursorLine(view, from, to)` is the single source of truth. Pass the
// decoration's range; returns true if any selection range overlaps with the
// decoration's enclosing line(s).

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * True if any selection head or anchor sits on a line in the inclusive range
 * `[fromLine, toLine]` (1-based line numbers). Focus-agnostic and view-free so
 * it can be used from a `StateField` (e.g. block-replace decorations that have
 * no `view`), as well as from `isCursorLine` below.
 */
export function selectionTouchesLines(
  state: EditorState,
  fromLine: number,
  toLine: number,
): boolean {
  for (const range of state.selection.ranges) {
    const head = state.doc.lineAt(range.head).number;
    if (head >= fromLine && head <= toLine) return true;
    const anchor = state.doc.lineAt(range.anchor).number;
    if (anchor >= fromLine && anchor <= toLine) return true;
  }
  return false;
}

export function isCursorLine(view: EditorView, from: number, to: number): boolean {
  // When the editor loses focus (sidebar click, settings modal, OS focus
  // change), the cursor-aware reveal must lift — the decorations should
  // re-apply so the markdown reads as a rendered document. Selection state
  // persists across focus loss in CM6, so `view.hasFocus` is the discriminator.
  if (!view.hasFocus) return false;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  return selectionTouchesLines(view.state, startLine, endLine);
}

/**
 * Per-inline cursor-aware check — lift a decoration ONLY when the cursor
 * (or selection anchor/head) is inside the decoration's byte range, not
 * the entire line. Used by inline-mark decorations (emphasis, link,
 * inline-code) so two formatted spans on the same line don't both reveal
 * their syntax when the cursor is on only one of them.
 *
 * Boundary positions (`range.head === from` or `range.head === to`) are
 * considered inside so the user can backspace into the decoration or step
 * into it from the right edge to edit.
 *
 * Like `isCursorLine`, this returns `false` when the editor isn't focused
 * so the rendered view is restored as soon as focus leaves the editor.
 */
export function isInsideRange(view: EditorView, from: number, to: number): boolean {
  if (!view.hasFocus) return false;
  for (const range of view.state.selection.ranges) {
    if (range.head >= from && range.head <= to) return true;
    if (range.anchor >= from && range.anchor <= to) return true;
  }
  return false;
}
