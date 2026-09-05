// Give `drawSelection` a second look after a selection change that also moved
// the line's DOM (myne-md/myne#660).
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
// The first is now geometry-neutral (`task-surfaces.css`'s out-of-flow button).
// The second cannot be: showing the markup is a real width change, and it is
// the CORRECT behaviour, it is what keeps a translucent band off the checkbox's
// opaque fill. So the fix cannot be to stop the geometry moving.
//
// # Why a re-measure, and why the FIRST version of this file did nothing
//
// `cursor-aware.ts` records the missing step exactly: "Nothing recomputes it
// afterwards, so the wrong pair of rectangles stays until the next selection
// change." The layer is perfectly capable of painting this correctly, it just
// measured one frame too early, and never looks again.
//
// The first version asked for that second look with an empty
// `view.requestMeasure({ read: () => null })`, on the strength of a claim in
// this comment that `LayerView.docViewUpdate` re-queues the selection layer's
// own `measureReq` "whenever one runs". **That claim is false**, and the source
// is unambiguous about it: `EditorView` calls `this.docViewUpdate()` only under
// `if (redrawn)`, at both of its two call sites, where `redrawn` is the return
// of `this.docView.update(update)`. An empty measure request produces no
// update, so nothing redraws, so `docViewUpdate` never runs and the selection
// layer is never re-queued. The plugin ran on every keystroke and achieved
// nothing, while its own comment explained why it worked.
//
// What actually re-queues that layer is visible in the same file, and there are
// exactly two doors:
//
//     LayerView.update(update) {
//       if (this.layer.update(update, this.dom) || update.geometryChanged) {
//         this.scale();
//         update.view.requestMeasure(this.measureReq);
//       }
//     }
//
// and `selectionLayer`'s own `update` is
// `docChanged || selectionSet || viewportChanged || configChanged`. So the one
// supported way to make this layer look again is an update that sets one of
// those. This plugin dispatches the cheapest of them: a transaction whose
// selection is the CURRENT selection, on the next frame. It changes no document
// and no selection value, and it is a genuine second measure against settled
// geometry rather than a no-op wearing a comment.
//
// # Why the trigger is a non-empty selection rather than `geometryChanged`
//
// The predicate could ask for `geometryChanged`, which is what the first
// version did. Two reasons not to.
//
// It is too wide: `ViewUpdate.geometryChanged` is defined as
// `docChanged || (flags & (Geometry|Height))`, so it is true on every
// keystroke, and dispatching a transaction per keystroke is a real cost rather
// than the no-op the old empty measure was.
//
// It is also not clearly wide ENOUGH for the case this exists for, which is a
// decoration swap riding a pure selection move, and betting the fix on a flag
// whose exact semantics we would be guessing at is how the first version got
// here. A non-empty selection is the complete and exactly-stated set of updates
// that can paint a band at all: a caret paints none, so there is nothing to get
// wrong. That set is entered only while the user is selecting, so the cost is
// bounded by the gesture rather than by typing.

import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { Annotation, Transaction, type Extension } from "@codemirror/state";

/** Marks this plugin's own re-dispatch, so it cannot answer itself. The
 *  predicate below would already refuse the echo (the re-dispatch sets
 *  `selectionSet`, and its selection is non-empty, so only this annotation
 *  separates them), which makes this the whole recursion stop rather than a
 *  belt on top of one. */
const remeasureDispatch = Annotation.define<boolean>();

/**
 * True when this update can leave `drawSelection` holding a stale rectangle
 * pair: the selection moved, it is non-empty (so a band is painted at all), and
 * this is not the echo of our own re-dispatch.
 *
 * Exported for `tests/editor/selectionRemeasure.test.ts`. The predicate is the
 * decision; the plugin around it is plumbing.
 */
export function needsSelectionRemeasure(update: {
  selectionSet: boolean;
  hasNonEmptySelection: boolean;
  isRemeasureEcho: boolean;
}): boolean {
  if (update.isRemeasureEcho) return false;
  // Necessary: with no selection change there is no new rectangle pair, and
  // this must not fire on scrolling or on typing that leaves the selection
  // alone.
  if (!update.selectionSet) return false;
  // Sufficient and exact: `drawSelection` paints a band only for a non-empty
  // range, so an empty one has nothing that can be painted wrong.
  return update.hasNonEmptySelection;
}

class SelectionRemeasurePlugin implements PluginValue {
  private frame: number | null = null;

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    const shouldRemeasure = needsSelectionRemeasure({
      selectionSet: update.selectionSet,
      hasNonEmptySelection: update.state.selection.ranges.some((r) => !r.empty),
      isRemeasureEcho: update.transactions.some(
        (tr) => tr.annotation(remeasureDispatch) === true,
      ),
    });
    if (!shouldRemeasure) return;
    // Next FRAME, and the hop is the whole point: a re-measure queued inside
    // this cycle would run against the same transient layout the first probe
    // read, which is the state being recovered from.
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      // Read the selection HERE rather than closing over the update's, so a
      // selection that moved in the meantime is respected and this stays a
      // value-preserving transaction in every case.
      this.view.dispatch({
        selection: this.view.state.selection,
        annotations: [
          remeasureDispatch.of(true),
          // Not a user action: it must not become an undo step, and
          // `undoSelection` must not walk back onto it.
          Transaction.addToHistory.of(false),
        ],
      });
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
