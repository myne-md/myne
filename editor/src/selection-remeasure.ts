// Re-measure the selection layer after a selection change that also moved the
// line's DOM (myne-md/myne#660).
//
// # The failure
//
// `drawSelection` paints a range by probing its visual row twice, once from
// each end (`rectanglesForRange` -> `wrappedLine`). When those two probes
// disagree it takes the two-rectangle branch: `range.from` to the RIGHT edge,
// plus the LEFT edge to `range.to`. Over a single visual row those overlap
// across the whole row, and `--selection-bg` is translucent, so the overlap
// paints twice. That is the "double highlight".
//
// The probes disagree when a DOM change lands in the SAME update as the
// selection change, because one of them reads a geometry that is already stale.
// On a task row two such changes ride along with any selection:
//
//   - the `+` affordance leaves the line, since `isCaretLine` is caret-only;
//   - the `- [ ] ` run stops being a checkbox widget and becomes source, since
//     `revealsRange` fires once the selection overlaps it.
//
// The first is now geometry-neutral (`task-add-affordance.ts`'s zero-size
// slot). The second cannot be: showing the markup is a real width change, and
// it is the CORRECT behaviour, it is what keeps a translucent band off the
// checkbox's opaque fill. So the fix cannot be to stop the geometry moving.
//
// # Why a re-measure, and why this is not a workaround
//
// `cursor-aware.ts` records the missing step exactly: "Nothing recomputes it
// afterwards, so the wrong pair of rectangles stays until the next selection
// change." The layer is perfectly capable of painting this correctly, it just
// measured one frame too early, and never looks again.
//
// There is precedent for this recovery in this editor, on the same gesture.
// `toolbar/plugin.ts` re-attempts its positioning on `update.geometryChanged`
// because "a double-click right after a re-focus can fire selectionSet before
// the layout is measured, so the first `coordsAtPos` is null; the following
// geometry update recovers it". Same race, same window, same answer.
//
// # What it costs, measured rather than asserted
//
// `decorations/embedded-html.ts` carries an explicit "do NOT call
// `view.requestMeasure()` here", because there it would run mid-scroll on every
// open block, so the cost of this one is owed an honest answer.
//
// The predicate fires on **every keystroke**, not only on the task-row gesture:
// `geometryChanged` is defined to include `docChanged`. An earlier version of
// this comment claimed otherwise and was wrong.
//
// It is still close to free, for a reason worth writing down so nobody
// "optimises" it later. `EditorView.update` runs plugin updates (where the rAF
// below is registered) and then calls `this.requestMeasure()` itself whenever
// the view redrew. rAF callbacks run in registration order, so this one runs
// first and finds CM's own measure already scheduled, `requestMeasure` is
// `if (this.measureScheduled < 0)`, so the call is a no-op. In the case this
// exists for, a decoration change riding a selection change, the view HAS
// redrawn, so what is added per keystroke is one rAF registration and one
// no-op. A genuinely extra measure cycle happens only on the rare update that
// changed geometry without redrawing.

import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * True when this update is the shape that can leave `drawSelection` holding a
 * stale rectangle pair: the selection moved, AND the line's DOM moved with it.
 *
 * Exported for `tests/editor/selectionRemeasure.test.ts`. The predicate is the
 * decision; the plugin around it is plumbing, and asserting the plumbing would
 * be asserting a `requestMeasure` spy rather than the rule that calls it.
 */
export function needsSelectionRemeasure(update: {
  selectionSet: boolean;
  viewportChanged: boolean;
  geometryChanged: boolean;
}): boolean {
  // A selection change is necessary: with no selection there is no rectangle
  // pair to get wrong, and this must not fire on scrolling or on typing that
  // leaves the selection alone.
  if (!update.selectionSet) return false;
  // A plain caret move within an already-settled line needs nothing; a
  // selection change that arrived WITH a layout change is the case.
  //
  // No `|| update.docChanged` here: `ViewUpdate.geometryChanged` is defined as
  // `docChanged || (flags & (Geometry|Height))`, so the disjunct could never
  // change the answer. Which also means this DOES return true on every
  // keystroke, not only on the task-row gesture, see the cost note below.
  return update.geometryChanged || update.viewportChanged;
}

/** A stable key so a burst of updates coalesces to ONE measure per frame, the
 *  `scroll-slack.ts` idiom, for the same reason it gives there. */
const remeasureKey = {};

class SelectionRemeasurePlugin implements PluginValue {
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    if (!needsSelectionRemeasure(update)) return;
    // Next FRAME, not this measure cycle, and the hop is the whole point: a
    // request queued inside this cycle runs against the same transient layout
    // the first probe read, which is the state being recovered from. The keyed
    // request coalesces the measure; the frame is what makes it a later one.
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      // Empty read/write: asking for a cycle is enough. `LayerView`'s
      // `docViewUpdate` re-queues the selection layer's own `measureReq`
      // whenever one runs, so the layer looks again on its own.
      this.view.requestMeasure({ key: remeasureKey, read: () => null });
    });
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

/** The extension. Composed once, next to `drawSelection()`. */
export function selectionRemeasure(): Extension {
  return ViewPlugin.fromClass(SelectionRemeasurePlugin);
}
