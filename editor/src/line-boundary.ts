// Cmd+→ / Cmd+← — go to the end / start of the line, and stay on the row you
// were on (myne#286).
//
// # What was wrong
//
// Myne binds nothing of its own to those chords, so they resolved to
// CodeMirror's `cursorLineBoundaryRight` / `cursorLineBoundaryLeft`. Those are
// not text operations — they are COORDINATE PROBES:
//
//     let coords = view.coordsAtPos(…)
//     let editorRect = view.dom.getBoundingClientRect()
//     let pos = view.posAtCoords({ x: editorRect.right - 1, y: middle of coords })
//
// `EditorView.lineWrapping` is on, so the probe branch is always taken, and the
// destination is whatever `posAtCoords` reports at the editor's own right edge
// on the caret's row. Two things make that answer wrong in this app:
//
//   - `view.dom` is `.cm-editor`, which sits inside a CENTRED column with a
//     max-width. `editorRect.right - 1` therefore lands in `.cm-line`'s right
//     padding, or — with a classic non-overlay scrollbar on WebKitGTK — on the
//     scrollbar itself. A caret-from-point outside the text box is exactly where
//     WebKit resolves to the FOLLOWING line.
//   - even inside the text box, a one-pixel overshoot at a soft-wrap point
//     resolves to the start of the next visual row rather than the end of the
//     current one.
//
// Either way the caret drops a row, which is never what "go to the end of the
// line" means.
//
// # The fix
//
// Keep CodeMirror's visual-line semantics — on a soft-wrapped paragraph, Cmd+→
// SHOULD stop at the wrap point — but verify the probe before trusting it. If
// the answer is not on the row the caret started on, the probe missed, and the
// logical line edge is used instead. A correct probe on a wrapped line lands at
// the wrap point with `assoc = -1`, which renders at the end of the current row,
// so the verification does not fire for the case it is meant to preserve.
//
// When the view cannot be measured at all (`coordsAtPos` returns null — a
// detached view, a line scrolled out of the viewport, or a test DOM with no
// layout), the probe is left alone: an unverifiable answer is not evidence of a
// wrong one.

import { EditorSelection, type SelectionRange } from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

/** Vertical midpoint of the caret's rect, or `null` when unmeasurable. */
function rowMidpoint(view: EditorView, range: SelectionRange): number | null {
  const coords = view.coordsAtPos(range.head, range.assoc === 0 ? -1 : range.assoc);
  return coords === null ? null : (coords.top + coords.bottom) / 2;
}

/**
 * The line-boundary destination for one range, verified to stay on its row.
 *
 * Exported for the unit test, which drives it with a stubbed `coordsAtPos` —
 * jsdom has no layout, so the probe itself cannot be exercised there and the
 * VERIFICATION is what there is to pin.
 */
export function verifiedLineBoundary(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
): SelectionRange {
  const probed = view.moveToLineBoundary(range, forward);
  const before = rowMidpoint(view, range);
  const after = rowMidpoint(view, probed);
  // Unmeasurable → trust the probe. Nothing has been shown to be wrong with it.
  if (before === null || after === null) return probed;
  // Half a line of tolerance: sub-pixel differences within a row are normal,
  // a row change is not.
  if (Math.abs(after - before) <= 1) return probed;
  const line = view.state.doc.lineAt(range.head);
  return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
}

function moveLineBoundary(view: EditorView, forward: boolean, extend: boolean): boolean {
  const ranges = view.state.selection.ranges.map((range) => {
    const target = verifiedLineBoundary(view, range, forward);
    return extend
      ? EditorSelection.range(range.anchor, target.head)
      : EditorSelection.cursor(target.head, target.assoc);
  });
  const selection = EditorSelection.create(ranges, view.state.selection.mainIndex);
  if (selection.eq(view.state.selection)) return false;
  view.dispatch({
    selection,
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/**
 * Bound BEFORE `defaultKeymap` so these shadow `cursorLineBoundaryRight` and
 * friends. Mac-only chords, matching the bindings they replace — the
 * Home/End-based bindings on other platforms are text operations already and
 * were never affected.
 */
export const lineBoundaryKeymap: readonly KeyBinding[] = [
  {
    mac: "Cmd-ArrowRight",
    run: (view) => moveLineBoundary(view, true, false),
    shift: (view) => moveLineBoundary(view, true, true),
    preventDefault: true,
  },
  {
    mac: "Cmd-ArrowLeft",
    run: (view) => moveLineBoundary(view, false, false),
    shift: (view) => moveLineBoundary(view, false, true),
    preventDefault: true,
  },
];
