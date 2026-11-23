// The selection band, painted as DECORATIONS rather than left to CodeMirror's
// own selection layer (myne-md/myne#1062, symptom 3; #990's residue).
//
// # What the built-in layer does
//
// `drawSelection` paints each range as one or more rectangles derived from
// `coordsAtPos` probes (`rectanglesForRange`). Two shapes come out of it that a
// reader reads as "everything is selected":
//
//   - every row whose line break is inside the range is stretched from the text
//     to the RIGHT EDGE OF THE CONTENT COLUMN (`horizontal.push(…, rightSide)`),
//     so selecting three list items paints a bar reaching a thousand pixels past
//     the last word;
//   - the rows in between collapse into ONE rectangle
//     (`between.push(piece(leftSide, top.bottom, rightSide, bottom.top))`), so
//     the middle of a multi-line selection is a single full-width slab whose
//     height grows with the selection.
//
// Measured in the web client while dragging across three checkboxes: rects at
// `left 436→right 974` (the stretch) and one slab `h 29.6 → 53.4 → 77.2 → 101`
// (the collapse). The owner's words: "saçma sapan her yeri select etmişçesine
// boyuyor".
//
// # Why decorations, and not a rectangle post-process
//
// A `Decoration.mark` over the selected characters paints exactly those
// characters, in the CONTENT layer. That gets four properties for free, each of
// which the rectangle approach has to be taught:
//
//   - the band ENDS AT THE LAST CHARACTER of each line, which is the whole
//     complaint;
//   - wrapped and bidi text is painted by the browser's own layout of the span,
//     so a wrapped line highlights each visual row's text without a probe that
//     can go stale — which is #990's failure mode, and the reason
//     `selection-remeasure.ts` exists at all;
//   - there is never an overlap, so a translucent `--selection-bg` cannot
//     double up into a darker patch;
//   - it paints ABOVE an opaque line background (a fenced-code card), where the
//     layer below the content could not be seen at all.
//
// The layer's own rectangles are hidden by `theme.ts`, which leaves the caret
// and the iOS drag handles (also drawn by `drawSelection`) untouched.
//
// # What it deliberately does not do
//
// A line holding only a widget (an image embed alone on its line) contains no
// text to mark, so it gets no band from here. That needs the widget to render
// its own selected state, which is the second plugin below — the two symptoms
// share this seam and not the code.

import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { EditorSelection, EditorState, Range } from "@codemirror/state";

/** One painted span, in document coordinates. */
export interface BandRange {
  readonly from: number;
  readonly to: number;
}

/** The class `theme.ts` gives its `--selection-bg` wash. */
export const BAND_CLASS = "cm-selband";

function isWanted(update: ViewUpdate): boolean {
  return (
    update.selectionSet ||
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.focusChanged
  );
}

/**
 * The spans to paint, clipped to what is on screen.
 *
 * Clipped per LINE, not per visible window: a span that carries the line break
 * paints to the end of its row in some engines, which is the behaviour this
 * exists to remove. An empty line therefore contributes nothing, and a line
 * whose only content is a widget contributes nothing — both deliberate.
 */
export function bandRanges(
  state: EditorState,
  visibleFrom: number,
  visibleTo: number,
): BandRange[] {
  const out: BandRange[] = [];
  const doc = state.doc;
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const from = Math.max(range.from, visibleFrom);
    const to = Math.min(range.to, visibleTo);
    if (from >= to) continue;
    for (let line = doc.lineAt(from); line.number <= doc.lines; line = doc.line(line.number + 1)) {
      const a = Math.max(from, line.from);
      const z = Math.min(to, line.to);
      if (z > a) out.push({ from: a, to: z });
      if (line.to >= to) break;
    }
  }
  return out;
}

function buildBands(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const mark = Decoration.mark({ class: BAND_CLASS });
  for (const { from: visibleFrom, to: visibleTo } of view.visibleRanges) {
    for (const band of bandRanges(view.state, visibleFrom, visibleTo)) {
      decorations.push(mark.range(band.from, band.to));
    }
  }
  // Sorted: `visibleRanges` and multiple selection ranges each arrive in their
  // own order, and a `RangeSet` refuses an unsorted batch.
  return Decoration.set(decorations, true);
}

class SelectionBandPlugin {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = buildBands(view);
  }
  update(update: ViewUpdate): void {
    if (isWanted(update)) this.decorations = buildBands(update.view);
  }
}

/** The extension. Composed once, next to `drawSelection()`. */
export function selectionBand() {
  return ViewPlugin.fromClass(SelectionBandPlugin, {
    decorations: (plugin: SelectionBandPlugin) => plugin.decorations,
  });
}

/**
 * The class the widget-selection marker puts on a block widget's own element.
 *
 * A block widget is a SIBLING of the lines, not a child of one, so a line
 * decoration cannot reach it and neither can the band: without this, a selected
 * image would look exactly like an unselected one and the reader could not tell
 * whether a cut carries it (myne-md/myne#1063's first half, reached by the same
 * seam).
 */
export const WIDGET_SELECTED_CLASS = "cm-widget-selected";

/** Whether a non-empty selection covers any of `[from, to)`. */
export function coversRange(
  selection: EditorSelection,
  from: number,
  to: number,
): boolean {
  return selection.ranges.some((range) => !range.empty && range.from < to && range.to > from);
}

type Measurable = Pick<EditorView, "contentDOM" | "posAtDOM" | "state" | "requestMeasure">;

class WidgetSelectionPlugin {
  constructor(private readonly view: EditorView) {
    this.sync();
  }

  update(update: ViewUpdate): void {
    if (isWanted(update)) this.sync();
  }

  private sync(): void {
    // In the WRITE phase: the widget elements are replaced on every rebuild, so
    // marking them from `update()` would write onto the DOM that is about to be
    // thrown away.
    this.view.requestMeasure({
      read: () => null,
      write: () => markCoveredWidgets(this.view),
    });
  }
}

/**
 * Mark (or unmark) every block widget the selection covers.
 *
 * Walked from the content element rather than from a registry, because a block
 * widget is a direct CHILD of `.cm-content` — the same place CodeMirror puts the
 * lines — and that is the only list that is complete by construction. Anything
 * that is a line, a gap or a measurement probe is skipped.
 */
function markCoveredWidgets(view: Measurable): void {
  const docLength = view.state.doc.length;
  for (const node of Array.from(view.contentDOM.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const { classList } = node;
    if (classList.contains("cm-line") || classList.contains("cm-gap")) continue;
    let start: number | null;
    try {
      start = view.posAtDOM(node);
    } catch {
      // A node CodeMirror does not own (a measurement probe, a gap): not a
      // widget, and nothing to say about it.
      start = null;
    }
    if (start === null) continue;
    const line = view.state.doc.lineAt(Math.min(Math.max(start, 0), docLength));
    classList.toggle(WIDGET_SELECTED_CLASS, coversRange(view.state.selection, line.from, line.to));
  }
}

/** The widget half of the extension. */
export function selectionMarksWidgets() {
  return ViewPlugin.fromClass(WidgetSelectionPlugin);
}
