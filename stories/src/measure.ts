// The measure overlay (myne-md/myne#847 task 10).
//
// "The padding is too tight" is a sentence a reviewer writes and nobody can act
// on. This turns it into numbers: click an element and its box plus the gaps to
// its parent and its nearest siblings are pinned on screen.
//
// The arithmetic is PURE and takes rectangles rather than elements, because jsdom
// reports every box as zero by zero: a function that took an element could only
// be tested in a browser, and the part worth testing is the arithmetic.
//
// While measuring, the stage is inert. That is the honest reading of "a mode
// changes what a click means": the alternative leaves the story interactive and
// intercepts in the capture phase, which makes the winner depend on the
// component, and a button that opens a dialog would fight the measurement.
//
// The measurement is NOT part of the view contract: it is transient, and a
// shared link to a measurement is a link to nothing.

/** The four gaps around an element, in CSS pixels. */
export interface Gaps {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The subset of a rectangle the arithmetic needs. */
export interface RectLike {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The box size, rounded to whole pixels. */
export function boxOf(rect: RectLike): { width: number; height: number } {
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** The label the overlay shows for a box, in the form a reviewer would quote. */
export function formatBox(rect: RectLike): string {
  const box = boxOf(rect);
  return `${box.width} x ${box.height}`;
}

/**
 * The gap between an inner rectangle and the outer one that contains it.
 *
 * Negative values are kept rather than clamped: an element that overflows its
 * parent is a finding, and clamping it to zero would report the one case a
 * reviewer most needs to see as the case where everything is fine.
 */
export function gaps(inner: RectLike, outer: RectLike): Gaps {
  return {
    top: Math.round(inner.top - outer.top),
    right: Math.round(outer.right - inner.right),
    bottom: Math.round(outer.bottom - inner.bottom),
    left: Math.round(inner.left - outer.left),
  };
}

/** The gaps as the overlay labels them, omitting any that is zero. */
export function formatGaps(gap: Gaps): string {
  const parts: string[] = [];
  if (gap.top !== 0) parts.push(`top ${gap.top}`);
  if (gap.right !== 0) parts.push(`right ${gap.right}`);
  if (gap.bottom !== 0) parts.push(`bottom ${gap.bottom}`);
  if (gap.left !== 0) parts.push(`left ${gap.left}`);
  return parts.length === 0 ? "no gap" : parts.join(", ");
}
