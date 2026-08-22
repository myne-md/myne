// A triple-click on a list row selects that row, and leaves the caret on it
// (myne-md/myne#560).
//
// # What it does
//
// CM6's triple-click selects the line PLUS its trailing newline, so `range.to`
// is the NEXT line's start. On ordinary prose that is invisible and correct. On
// a row rendered as a checkbox plus a label it costs two things at once:
//
//   - the caret ends up one row BELOW the row that was clicked, so the next
//     keystroke lands somewhere the user did not click;
//   - `drawSelection` draws the multi-row form, a band running to the right edge
//     of the content plus a zero-width piece on the following row, instead of
//     one band over the row.
//
// So the trailing newline is trimmed, and only that. The selection still covers
// the whole row, hidden `- [x] ` included, which is what the user asked for
// and which the task-list decoration answers by rendering that run as SOURCE
// while it is selected (`revealsRange`), so no translucent band ever lands on
// the checkbox's opaque fill.
//
// # Why it is this narrow
//
// It fires only for a POINTER selection (`select.pointer`) that spans exactly
// one list row plus its break, in a transaction that changes no text.
//
//   - Keyboard selections are untouched. Their behaviour lives at the boundary
//     itself (`line-boundary.ts`'s smart-home) and is deliberately progressive:
//     the first Cmd+Shift+← takes the label, a second takes the marker too.
//     A filter here as well silently undid that second press once already.
//   - Non-list rows are untouched: the reasoning is about a row drawn as a
//     widget, and prose has none.
//   - Anything spanning more than one row is untouched, because there the band
//     genuinely is a block and the trailing newline is part of what was selected.
//   - `tr.docChanged` transactions are untouched, so no edit has its selection
//     rewritten under it.
//
// One limit the list above cannot state, because the layer cannot see it: at the
// transaction layer `event.detail` is gone, so a triple-click is identified by
// the SHAPE it leaves behind. A drag or a shift-click that happens to end at the
// next line's start is trimmed identically. That is accepted rather than
// overlooked. The alternative is `EditorView.mouseSelectionStyle`, which means
// reimplementing the drag state machine for `detail === 3`, more surface than
// these twenty lines, to separate two gestures the user cannot tell apart in the
// result either.

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { listMarkerEnd } from "./line-boundary";

/**
 * The row-without-its-newline range, or `null` when the rule does not apply.
 *
 * Exported for the unit test. The filter around it is plumbing; this is the
 * decision.
 */
export function trimRowNewline(
  state: EditorState,
  range: { from: number; to: number; anchor: number; head: number; empty: boolean },
): { anchor: number; head: number } | null {
  if (range.empty) return null;
  const line = state.doc.lineAt(range.from);
  // Exactly one row plus its break. Not `>=`: a selection ending anywhere else
  // is not the gesture this exists for.
  if (range.to !== line.to + 1) return null;
  if (range.from > line.from) return null;
  // A list row, which is where a marker is drawn as a widget. `listMarkerEnd`
  // rather than `listContentStart`: the latter answers `null` on an EMPTY
  // `- [ ] `, which is still a row with a widget on it and still drops the caret
  // a row below without this. Resolved at `line.to`, inside the item: `range.to`
  // is on the NEXT line and would read the wrong one.
  if (listMarkerEnd(state, line.to) === null) return null;
  return range.anchor <= range.head
    ? { anchor: range.from, head: line.to }
    : { anchor: line.to, head: range.from };
}

export function taskRowSelection(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.isUserEvent("select.pointer")) return tr;
    if (tr.selection === undefined || tr.docChanged) return tr;
    let touched = false;
    const ranges = tr.selection.ranges.map((range) => {
      const trimmed = trimRowNewline(tr.startState, range);
      if (trimmed === null) return range;
      touched = true;
      return EditorSelection.range(trimmed.anchor, trimmed.head);
    });
    if (!touched) return tr;
    // Appended as a second spec rather than rebuilt: `state.update` combines them
    // and the later `selection` wins, so the original transaction keeps its
    // annotations (`userEvent: "select.pointer"` among them, which the floating
    // toolbar's show trigger reads) and its effects.
    return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex) }];
  });
}
