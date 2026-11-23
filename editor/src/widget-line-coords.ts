// What the caret measures when it stands beside a widget (myne-md/myne#1062).
//
// # The failure this answers
//
// `WidgetTile.coordsInWidget` in CodeMirror ends with
// `flattenRect(this.dom.getBoundingClientRect(), …)`, so a position ON a widget
// is reported at the WIDGET's height. An image embed is a paragraph-sized box on
// a text-height line, so the caret beside it is drawn several hundred pixels
// tall and a selection rect spanning it is a slab. Measured in the web client:
// a 64 px inline image on a 23.8 px line produced a 79 px caret.
//
// # Why this is a hook rather than a fourth shadow
//
// `WidgetType.coordsAt(dom, pos, side)` exists for exactly this, and the same
// source consults it BEFORE the box: `let custom = this.widget.coordsAt(...);
// if (custom) return custom;`. So a widget can say what the caret looks like
// on it without touching the view, the layer, or `coordsAtPos`. It also
// corrects the other readers of that answer at once: `drawSelection`'s
// rectangles, `posAtCoords` round-trips and `moveVertically`'s goal column all
// go through the same call. Nothing is patched, and no probe is re-run.
//
// # Why the line, not the widget, decides the height
//
// The caret is a text-height marker: it belongs to the line the widget sits on,
// not to the widget. `dom.closest(".cm-line")`'s box IS that line, and clamping
// with `Math.min` keeps a SHORT widget honest — a 12 px chip must not stretch
// the caret to the line box if it were somehow taller.

import { WidgetType } from "@codemirror/view";

/** The subset of `DOMRect` CodeMirror reads. Zero-width on purpose: a caret is
 *  a position, and `flattenRect` is what turns it into the drawn bar. */
export interface CaretCoords {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Text-height caret coordinates for a position on `dom`, or `null` when the
 * widget has no box to place them against (hidden, detached, mid-measure).
 *
 * `side` is CodeMirror's: negative for a position that resolves to the LEFT
 * edge of what it sits on, positive for the right. It is the only input that
 * decides where the bar stands, so a caller passes it straight through.
 */
export function lineHeightCoords(dom: HTMLElement, side: number): CaretCoords | null {
  const box = dom.getBoundingClientRect();
  // A widget that has never been laid out answers nothing: reporting a zero
  // rect would draw the caret at the top-left corner of the editor.
  if (box.width === 0 && box.height === 0) return null;
  const line = dom.closest(".cm-line");
  const lineBox = line === null ? null : line.getBoundingClientRect();
  // A BLOCK widget is painted as a sibling of the lines rather than inside one,
  // so it has no line box to borrow; its own computed `line-height` is the same
  // inherited text metric, which is what makes one helper serve both forms.
  const lineHeight = lineBox !== null && lineBox.height > 0 ? lineBox.height : computedLineHeight(dom);
  const height = lineHeight === null ? box.height : Math.min(lineHeight, box.height);
  const inline = lineBox !== null && lineBox.height > 0;
  // Side only decides the edge for an INLINE widget, where text can stand on
  // either side of it. A block widget owns its whole line, so both of its
  // positions are at the line's start: a caret that jumped to the block's right
  // edge would be drawn at the far end of the content column, a thousand pixels
  // from the image it belongs to.
  const x = inline && side > 0 ? box.right : box.left;
  const top = inline ? (lineBox as DOMRect).top : box.top;
  return { left: x, right: x, top, bottom: top + height };
}

function computedLineHeight(dom: HTMLElement): number | null {
  const raw = getComputedStyle(dom).lineHeight;
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Base for the widgets that can be taller than the line they sit on: an image,
 * a PDF reader, a file card, an inline HTML block, an inline formula, a
 * drawing. Extending this instead of `WidgetType` is the whole change at each
 * site, so the answer to "what does the caret look like here" has one
 * implementation rather than seven that can drift apart.
 *
 * A widget shorter than its line box is unaffected: `lineHeightCoords` clamps
 * to the smaller of the two, which is the widget's own height.
 */
export abstract class LineHeightWidget extends WidgetType {
  coordsAt(dom: HTMLElement, _pos: number, side: number): CaretCoords | null {
    return lineHeightCoords(dom, side);
  }
}
