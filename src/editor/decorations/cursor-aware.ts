// Cursor-aware reveal helper shared by all line-scoped Decoration.mark
// extensions in `src/editor/decorations/`.
//
// Per `editor-mvp-baseline` PRD (agent-tooling/features/editor-mvp-baseline/prd.md):
// when the cursor's line equals the decoration's line, the decoration must
// LIFT so the user can see + edit the raw markdown syntax. When the cursor
// moves off the line, the decoration reapplies.
//
// `isCursorLine(view, from, to)` is the single source of truth. Pass the
// decoration's range; returns true if any selection range overlaps with the
// decoration's enclosing line(s).

import {
  type EditorState,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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

// --- Editor focus, threaded into state -----------------------------------
//
// `StateField`-backed decorations (block / line-break-crossing replaces, which
// CM6 forbids from a `ViewPlugin`) have no `view`, so they can't read
// `view.hasFocus`. This effect + field carries DOM focus into state so those
// fields can gate cursor-aware reveal on focus the same way `isCursorLine` /
// `isInsideRange` do for ViewPlugins. Originally local to `table.ts`; lifted
// here as shared infra when setext-heading + reference-link definition hiding
// became the second/third StateField decorations needing it.

const setEditorFocus = StateEffect.define<boolean>();

export const editorFocusField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorFocus)) return effect.value;
    }
    return value;
  },
});

export const editorFocusTracker = EditorView.focusChangeEffect.of(
  (_state, focusing) => setEditorFocus.of(focusing),
);

/** True if this transaction carried an editor focus/blur change — for a
 *  StateField's `update` recompute gate (mirrors `treeChanged` / `docChanged`). */
export function editorFocusChanged(tr: Transaction): boolean {
  return tr.effects.some((e) => e.is(setEditorFocus));
}

/**
 * Byte range that collapses the logical lines `[fromLine, toLine]` out of the
 * rendered flow without leaving a blank gap, for a line-break-crossing
 * `Decoration.replace` (StateField only). Eats the newline PRECEDING the range
 * (so the lines merge upward); at document start there is none, so it eats the
 * trailing newline instead. Shared by setext (underline collapse) and
 * reference-definition-line hiding.
 */
export function collapseLineRange(
  state: EditorState,
  fromLine: number,
  toLine: number,
): { from: number; to: number } {
  const first = state.doc.line(fromLine);
  const last = state.doc.line(toLine);
  if (first.from > 0) return { from: first.from - 1, to: last.to };
  return { from: first.from, to: Math.min(last.to + 1, state.doc.length) };
}

/**
 * State-only reveal predicate for StateField decorations: true when the editor
 * is focused AND a selection touches the inclusive line range `[fromLine,
 * toLine]`. Focus gate matches `isCursorLine` so a construct the cursor happens
 * to sit in does not stay raw once the editor is unfocused. Requires
 * `editorFocusField` to be installed (it is, via the decorator's extension
 * array — declared before the decoration field so its value is current).
 */
export function linesRevealed(
  state: EditorState,
  fromLine: number,
  toLine: number,
): boolean {
  return (
    state.field(editorFocusField) && selectionTouchesLines(state, fromLine, toLine)
  );
}
