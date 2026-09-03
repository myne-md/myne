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
  Facet,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { searchPanelOpen } from "@codemirror/search";

/**
 * Reading-view reveal suppressor (reading-source-modes, MYND-299). When `true`,
 * cursor-aware reveal is hard-OFF regardless of focus/selection — so the
 * read-only Reading view ALWAYS renders fully and never lifts markdown source
 * under a click (a non-editable CM6 view can still take a selection, so gating on
 * `view.hasFocus` alone is not enough to honor the "Reading view never lifts
 * source" contract). Provided as `true` by `view-mode.ts` in reading mode.
 */
export const readingModeFacet = Facet.define<boolean, boolean>({
  combine: (vals) => vals.some(Boolean),
});

/** Code-construct node names (fenced / indented / inline). */
const CODE_NODE_RE = /Code|FencedCode|InlineCode|CodeBlock|CodeText/;

/**
 * True if `pos` sits inside a code construct (fenced / indented / inline).
 * Shared by the embedded-HTML and math decorations: `<kbd>` / `$…$` inside a
 * code span or fence are literal source, not constructs to render.
 */
export function isInCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1);
  for (; node.parent !== null; node = node.parent) {
    if (CODE_NODE_RE.test(node.name)) return true;
  }
  return CODE_NODE_RE.test(node.name);
}

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

/**
 * The two suppressors EVERY view-based reveal predicate in this file honours,
 * before it looks at the selection at all.
 *
 *  - Reading view (MYND-299) never reveals, whatever the focus or selection. A
 *    non-editable CM6 view can still take a selection, so gating on
 *    `view.hasFocus` alone does not honour "Reading view never lifts source".
 *  - When the editor loses focus (a sidebar click, a settings modal, an OS focus
 *    change) the reveal must lift, so the markdown reads as a rendered document
 *    again. Selection state persists across focus loss in CM6, which is why
 *    `view.hasFocus` is the discriminator and the selection is not.
 *
 * One function rather than the same two lines at the top of four predicates: a
 * third suppressor is one edit here instead of four, and the four names then
 * differ only in what they actually differ in (line versus range, caret-only
 * versus any selection). `revealActive` below is the STATE-only analogue for
 * StateField decorations, which have no `view` and answer the focus question
 * differently (the threaded field, plus an open find panel).
 */
function revealSuppressed(view: EditorView): boolean {
  return view.state.facet(readingModeFacet) || !view.hasFocus;
}

export function isCursorLine(view: EditorView, from: number, to: number): boolean {
  if (revealSuppressed(view)) return false;
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
 * Like `isCursorLine`, it is suppressed in reading view and when the editor
 * isn't focused (`revealSuppressed`), so the rendered view is restored as soon
 * as focus leaves the editor.
 */
export function isInsideRange(view: EditorView, from: number, to: number): boolean {
  if (revealSuppressed(view)) return false;
  for (const range of view.state.selection.ranges) {
    if (range.head >= from && range.head <= to) return true;
    if (range.anchor >= from && range.anchor <= to) return true;
  }
  return false;
}

/**
 * Reveal predicate for a decoration that REPLACES its range with a widget: true
 * when a caret sits inside `[from, to]`, or when a selection overlaps it.
 *
 * Two clauses because they answer two different questions, and a widget needs
 * both:
 *
 *   - a caret inside the range means "I am editing this markup", which is the
 *     ordinary live-preview reveal every construct here does.
 *   - a selection OVERLAPPING the range means the user has taken the markup into
 *     a selection, and a widget is the wrong thing to show them. The rendered
 *     checkbox paints an opaque accent fill; a translucent selection band across
 *     it, next to the same band over plain text, is two tones in one selection,
 *     the "double highlight" of myne-md/myne#560. Showing the source instead
 *     removes the opaque surface rather than working around it, and it is also
 *     the honest answer: what is selected is `- [x] `, so that is what should be
 *     on screen and on the clipboard.
 *
 * Overlap is strict at both ends (`range.from < to && range.to > from`), so a
 * selection that merely ENDS where the run begins leaves the widget alone.
 *
 * `isInsideRange` is the looser sibling kept for restyling decorations
 * (emphasis, link, inline code): those change how text looks, so revealing on a
 * boundary touch is harmless where a widget vanishing is not.
 */
export function revealsRange(view: EditorView, from: number, to: number): boolean {
  if (revealSuppressed(view)) return false;
  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      if (range.head >= from && range.head <= to) return true;
    } else if (range.from < to && range.to > from) {
      return true;
    }
  }
  return false;
}

/**
 * Line-scoped check like {@link isCursorLine}, but satisfied only by a CARET (an
 * empty range) on one of the lines in `[from, to]`.
 *
 * For an affordance that ADDS A NODE to the line, not merely restyles it. Two
 * reasons, and the second is the one that is hard to find:
 *
 *  - an edit affordance belongs to a caret. While text is selected the user is
 *    doing something else, and a button appearing inside their selection band is
 *    noise.
 *  - a widget inserted in the SAME update as a selection change makes the line's
 *    DOM move while `drawSelection` is measuring it. Its `wrappedLine()` probe
 *    then reads a transient geometry, decides the selection's two ends are on
 *    different visual rows, and paints the two-rectangle form: one band from the
 *    selection start to the right edge, another from the left edge to the
 *    selection end. Over a single row those overlap, and a translucent
 *    `--selection-bg` doubles where they do. Nothing recomputes it afterwards,
 *    so the wrong pair of rectangles stays until the next selection change.
 *    Measured, not reasoned: `myne-md/myne#560`.
 *
 * **On which of the two #560 fixes is load-bearing.** The other one is in
 * `editor/src/task-surfaces.css`, which rebuilt `.cm-task-add`'s metrics so its
 * block margins cancel its own height. That removed the VERTICAL line-box growth
 * and is the root-cause fix; this is the reason the first clause above is the one
 * that carries the rule now. Keeping both is deliberate: the widget still
 * contributes inline WIDTH conditionally, so on a row already near the wrap width
 * the caret can still force a wrap and the same branch. Closing that last case
 * means taking the widget out of flow entirely, which is a bigger change than
 * either of these and is not in this diff.
 */
export function isCaretLine(view: EditorView, from: number, to: number): boolean {
  if (revealSuppressed(view)) return false;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  for (const range of view.state.selection.ranges) {
    if (!range.empty) continue;
    const line = view.state.doc.lineAt(range.head).number;
    if (line >= startLine && line <= endLine) return true;
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
 * Whether the editor selection should drive cursor-aware reveal of StateField
 * (block-replace) decorations: true when the editor content is focused, OR the
 * in-note find panel is open (MYND-175). The find clause is load-bearing: when
 * you navigate find onto a match inside a folded table, the find input — not the
 * editor content — holds DOM focus, so a focus-only gate would leave the table
 * folded and the match hidden behind the widget. A find session is navigating
 * the editor, so it counts as "active" for reveal. `searchPanelOpen` flips with
 * a focus change on open/close, which the StateField recompute gate already
 * tracks via `editorFocusChanged`.
 */
export function revealActive(state: EditorState): boolean {
  // Reading view (MYND-299): never reveal, whatever the focus / find state.
  if (state.facet(readingModeFacet)) return false;
  return state.field(editorFocusField) || searchPanelOpen(state);
}

/**
 * State-only reveal predicate for StateField decorations: true when reveal is
 * active (editor focused or find open) AND a selection touches the inclusive
 * line range `[fromLine, toLine]`. Focus gate matches `isCursorLine` so a
 * construct the cursor happens to sit in does not stay raw once the editor is
 * unfocused (and find is closed). Requires `editorFocusField` to be installed
 * (it is, via the decorator's extension array — declared before the decoration
 * field so its value is current).
 */
export function linesRevealed(
  state: EditorState,
  fromLine: number,
  toLine: number,
): boolean {
  return revealActive(state) && selectionTouchesLines(state, fromLine, toLine);
}
