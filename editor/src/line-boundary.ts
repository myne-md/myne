// Cmd+→ / Cmd+← and Cmd+Backspace / Cmd+Delete: the four macOS line-boundary
// chords, all four routed through ONE verified boundary (myne#286,
// myne-md/myne#561, myne-md/myne#564).
//
// # What was wrong, part one: the probe
//
// Myne bound nothing of its own to those chords, so they resolved to
// CodeMirror's `cursorLineBoundaryRight` / `cursorLineBoundaryLeft` and
// `deleteLineBoundaryBackward` / `deleteLineBoundaryForward`. None of those are
// text operations. All four are COORDINATE PROBES, through the same
// `view.moveToLineBoundary`:
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
// line" means, and under the DELETE chords it is worse than a wrong caret,
// because the wrong answer is applied to the document. myne#286 fixed the two
// movement chords and left the two deletion chords on the raw probe, which is
// how the same keystroke came to delete a whole line on one maintainer's machine
// and not on another's: window width, scrollbar style and where a soft wrap
// falls are all inputs to the probe, and all differ per machine.
//
// # What was wrong, part two: the line does not start where the text does
//
// On `- [ ] buy milk`, `- [ ] ` is decoration-hidden and drawn as a checkbox, so
// the line the user SEES begins at `buy`. Both the probe's fallback and the
// deletion target were `line.from`, the raw offset, so Cmd+Shift+← swept markup
// the user cannot see into the selection and Cmd+Backspace deleted it.
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
// Then, BACKWARD only, apply smart-home: on a list or task line the boundary is
// the item's content start, not `line.from`. A second press still reaches
// `line.from`, so nothing becomes unreachable. Forward is untouched: end of
// line is end of line on every kind of line.
//
// When the view cannot be measured at all (`coordsAtPos` returns null — a
// detached view, a line scrolled out of the viewport, or a test DOM with no
// layout), the probe is left alone: an unverifiable answer is not evidence of a
// wrong one. Smart-home still applies, because it reads the document rather than
// the layout and so is answerable without a measurable view.

import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

/** Vertical midpoint of the caret's rect, or `null` when unmeasurable. */
function rowMidpoint(view: EditorView, range: SelectionRange): number | null {
  const coords = view.coordsAtPos(range.head, range.assoc === 0 ? -1 : range.assoc);
  return coords === null ? null : (coords.top + coords.bottom) / 2;
}

/**
 * The list/task marker that opens the line `head` sits on: a bullet (`-`, `+`,
 * `*`) with an optional GFM task marker, or an ordered marker (`1.` / `1)`),
 * plus the whitespace after it.
 *
 * Deliberately narrower than a text match. The syntax tree has to agree that
 * this is a `ListItem` first, because `- not a list` inside a fenced code block
 * is prose that happens to look like one, and pulling the caret past a hyphen
 * there would be a silent wrong answer in the one place the editor promises
 * literal text.
 *
 * Exported for the unit test.
 *
 * @returns the offset of the first content character, or `null` when the line is
 *   not a list item, is a continuation line, or has no content after its marker
 *   (an empty `- [ ] `, where there is nothing for smart-home to protect).
 */
export function listMarkerEnd(state: EditorState, head: number): number | null {
  const line = state.doc.lineAt(head);
  // Cheap test first, tree second. This runs on every selection transaction, and
  // the overwhelming majority of lines are prose that cannot match, so resolving
  // the syntax tree for each of those would be work done to learn nothing.
  // Mirrors the marker grammar `@codemirror/lang-markdown`'s `getContext` uses,
  // so the two cannot disagree about where an item's marker ends.
  const match = /^[ \t]*(?:[-+*](?:[ \t]{1,4}\[[ xX]\])?|\d+[.)])[ \t]+/.exec(line.text);
  if (match === null) return null;
  // The regex needs a marker character and at least one space, so `end` is
  // always past `line.from`; the only bound worth testing is the upper one.
  const end = line.from + match[0].length;
  if (end > line.to) return null;
  // Now confirm the parser agrees this is a list item, because `- not a list`
  // inside a fenced code block matches the regex and is prose. `/Code/` alone
  // covers `FencedCode`, `CodeBlock` and `CodeText`, which all contain it.
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(head, -1);
    node !== null;
    node = node.parent
  ) {
    if (/Code/.test(node.name)) return null;
    if (node.name === "ListItem") return end;
  }
  return null;
}

/**
 * {@link listMarkerEnd}, narrowed to rows that have something after the marker.
 *
 * The two are separate because their callers need different answers on an EMPTY
 * `- [ ] `. Smart-home wants `null` there: pulling the caret to a content start
 * that IS the line end would make Cmd+← a no-op on that row. A caller asking
 * only "is this a list row" wants the offset, and answering `null` cost
 * myne-md/myne#560 a case: triple-clicking an empty task row kept the untrimmed
 * selection and still dropped the caret a row below, which is the defect the
 * trim exists to fix, on the one row shape nothing tested.
 */
export function listContentStart(state: EditorState, head: number): number | null {
  const end = listMarkerEnd(state, head);
  return end !== null && end < state.doc.lineAt(head).to ? end : null;
}

/**
 * Smart-home: pull a BACKWARD boundary forward to the list item's content start.
 *
 * Three cases, and the last two are why this is not just `return content`:
 *
 *   - caret inside the label, target before the content start → the content
 *     start. This is the reported case: Cmd+Shift+← on a task line should take
 *     the label, not the hidden `- [ ] `.
 *   - caret already AT (or before) the content start → leave the target alone,
 *     so the second press reaches `line.from` and the raw start stays reachable.
 *   - target already at or past the content start → leave it alone. That is a
 *     soft-wrap point inside the label, and it is the right answer.
 */
function smartHomeBackward(
  state: EditorState,
  range: SelectionRange,
  target: SelectionRange,
): SelectionRange {
  const content = listContentStart(state, range.head);
  if (content === null) return target;
  if (target.head >= content || range.head <= content) return target;
  return EditorSelection.cursor(content, 1);
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
  return probeLineBoundary(view, range, forward).target;
}

/**
 * The verified boundary, plus whether the probe had to be REPLACED to get it.
 *
 * The two callers want different things from a failed probe, and giving them the
 * same answer was a real defect (myne-md/myne#564). For MOVEMENT, the logical
 * line edge is a fine consolation: the caret goes somewhere sensible and a wrong
 * guess costs one keystroke to undo. For DELETION it is not, because the same
 * offset now decides how much text disappears. On a soft-wrapped paragraph,
 * which this file's header says is exactly when the probe misses in this app,
 * `line.to` is the end of the whole paragraph rather than the end of the visual
 * row, so one Cmd+Delete would take the lot.
 *
 * So the flag is reported rather than swallowed, and `deleteToLineBoundary`
 * declines to act on a boundary nobody could verify.
 */
function probeLineBoundary(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
): { target: SelectionRange; probeReplaced: boolean } {
  const probed = view.moveToLineBoundary(range, forward);
  const before = rowMidpoint(view, range);
  const after = rowMidpoint(view, probed);
  // Unmeasurable → trust the probe. Nothing has been shown to be wrong with it.
  // Half a line of tolerance: sub-pixel differences within a row are normal,
  // a row change is not.
  const sameRow =
    before === null || after === null || Math.abs(after - before) <= 1;
  let verified = probed;
  if (!sameRow) {
    // Only the fallback needs the line, and the fallback is the rare path.
    const line = view.state.doc.lineAt(range.head);
    verified = EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
  }
  return {
    target: forward ? verified : smartHomeBackward(view.state, range, verified),
    probeReplaced: !sameRow,
  };
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
 * `@codemirror/commands`' `skipAtomic`, which is not exported. A boundary that
 * lands INSIDE an atomic range (a table widget, a task chip, a tag pill) must be
 * pushed to that range's edge, or the delete cuts a construct in half and leaves
 * unparseable source behind.
 */
function skipAtomic(view: EditorView, pos: number, forward: boolean): number {
  for (const provider of view.state.facet(EditorView.atomicRanges)) {
    provider(view).between(pos, pos, (from, to) => {
      if (from < pos && to > pos) pos = forward ? to : from;
    });
  }
  return pos;
}

/**
 * `deleteLineBoundaryBackward` / `deleteLineBoundaryForward`, rebuilt on the
 * verified boundary above.
 *
 * The structure mirrors `@codemirror/commands`' `deleteBy` deliberately, down to
 * the `userEvent` values and the announce: a delete that reports itself as
 * something other than `delete.backward` / `delete.forward` is invisible to
 * every listener keyed on those, the undo grouping included. The only thing that
 * differs is where the boundary comes from.
 *
 * Exported for the unit test, for the same reason `verifiedLineBoundary` is:
 * jsdom cannot exercise the probe, so the DECISION made on top of it is what
 * there is to pin.
 *
 * The at-the-boundary fallback is the library's: when the caret is ALREADY at
 * the boundary, eat one character across the line break, so a repeated
 * Cmd+Backspace still joins lines rather than becoming a no-op.
 */
export function deleteToLineBoundary(view: EditorView, forward: boolean): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  let event = "delete.selection";
  const spec = state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) {
      const { target, probeReplaced } = probeLineBoundary(view, range, forward);
      // A REPLACED probe is not a boundary, it is the logical line edge standing
      // in for one. Movement may take that; a delete may not, because on a
      // soft-wrapped paragraph it is the far end of the paragraph. Fall back to
      // the single-character step the at-the-boundary case already uses: too
      // little is one more keypress, too much is a paragraph.
      const boundary = probeReplaced ? range.head : target.head;
      // The boundary, unless the caret is already ON it, in which case step one
      // character. Both directions reduce to that one rule; spelling it as two
      // mirrored comparisons made the shared half look like a coincidence.
      let towards =
        boundary !== range.head
          ? boundary
          : forward
            ? Math.min(state.doc.length, range.head + 1)
            : Math.max(0, range.head - 1);
      if (towards < from) {
        event = "delete.backward";
        towards = skipAtomic(view, towards, false);
      } else if (towards > from) {
        event = "delete.forward";
        towards = skipAtomic(view, towards, true);
      }
      from = Math.min(from, towards);
      to = Math.max(to, towards);
    } else {
      from = skipAtomic(view, from, false);
      to = skipAtomic(view, to, true);
    }
    return from === to
      ? { range }
      : {
          changes: { from, to },
          range: EditorSelection.cursor(from, from < range.head ? -1 : 1),
        };
  });
  if (spec.changes.empty) return false;
  view.dispatch(
    state.update(spec, {
      scrollIntoView: true,
      userEvent: event,
      effects:
        event === "delete.selection"
          ? EditorView.announce.of(state.phrase("Selection deleted"))
          : undefined,
    }),
  );
  return true;
}

/**
 * Bound BEFORE `defaultKeymap` so these shadow `cursorLineBoundaryRight`,
 * `deleteLineBoundaryBackward` and friends. Mac-only chords, matching the
 * bindings they replace. The Home/End-based bindings on other platforms are
 * text operations already and were never affected.
 *
 * **`mac:`-only is also why there is no E2E scenario for them, and the absence
 * is stated rather than left to be noticed.** The tauri-driver lane is a Linux
 * container, so these bindings are not installed in it and no scenario there can
 * press one. jsdom cannot cover the interesting half either: `probeLineBoundary`
 * branches on real `coordsAtPos` geometry, so every unit test drives it through
 * a stub. What is left is unit tests over stubbed geometry plus the manual pass,
 * and closing the gap needs a macOS E2E seat this project does not have.
 * `scripts/e2e-scenario-floor.json` carries the same note beside the floor.
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
  {
    mac: "Cmd-Backspace",
    run: (view) => deleteToLineBoundary(view, false),
    preventDefault: true,
  },
  {
    mac: "Cmd-Delete",
    run: (view) => deleteToLineBoundary(view, true),
    preventDefault: true,
  },
];
