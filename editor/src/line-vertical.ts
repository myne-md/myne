// ArrowUp / ArrowDown: go to the same COLUMN on the row above or below, not to
// that row's end (myne-md/myne#631).
//
// # What was wrong
//
// Myne bound nothing of its own to the plain arrows, so they resolved to
// CodeMirror's `cursorLineUp` / `cursorLineDown`. Those are coordinate probes,
// and in this app's layout every one of their fallbacks is wrong:
//
//     let moved = view.moveVertically(range, forward)
//     return moved.head != range.head ? moved : view.moveToLineBoundary(range, forward)
//
// `moveToLineBoundary` is the SAME probe `line-boundary.ts` documents at length
// for Cmd+←/→ (myne#286): it asks `posAtCoords` for the position at
// `view.dom.getBoundingClientRect().right - 1`, and `view.dom` is `.cm-editor`,
// which sits inside a centred max-width column, so that x is outside the text
// box. That fix could only shadow the two Mac chords; a keymap cannot reach a
// call CodeMirror makes INSIDE `cursorByLine`. Its return value is
// `EditorSelection.cursor(pos, ±1)` with no fourth argument, so the goal column
// is destroyed at the same time.
//
// `moveVertically` itself loses or mis-derives the goal on three of its four
// return paths, and one of them explains the reported symptom directly: when
// `coordsAtPos` returns null, which it does for a position inside a replaced or
// hidden range, and Myne hides markdown syntax with dozens of
// `Decoration.replace` sites, the goal becomes
// `min(contentWidth, defaultCharacterWidth * column)`, which on a long line
// clamps to the FULL content width and resolves to the target line's end. That
// goal is then preserved, so every subsequent press repeats it: the caret walks
// down the document hitting the end of every line.
//
// Two more sinks on the same path: CodeMirror's own internal `skipAtoms` (not
// the exported one this module imports from `line-boundary.ts`) rebuilds the
// cursor without a goal whenever an atomic range is crossed, and there are seven
// providers here (tag chip, task chip, table, frontmatter, attachment embed,
// drawing embed, wikilink chip. And `frontmatter.ts`'s selection guard
// re-creates the range as `EditorSelection.cursor(head, 1)` when it clamps.
//
// # The fix
//
// Keep a goal of our own, as a CHARACTER OFFSET from the start of the visual
// row rather than as a pixel x. That is what the reporter asked for, "go to
// whatever is directly above or below", and it is also the only kind of goal
// that survives this editor, where a 2em heading and a 14px monospace task line
// sit one row apart and a pixel x means two different columns on them.
//
// The row's own boundaries come from `verifiedLineBoundary` (line-boundary.ts),
// reused rather than copied: it wraps the same broken probe with the check that
// the answer stayed on the caret's row, and falls back to the logical line edge
// when it did not. Pushing a landing out of an atomic range is that file's
// `skipAtoms`, reused the same way and asked for its `"nearer"` edge, since a
// vertical move arrives with no horizontal direction to push along.
// `moveVertically` is still used, but ONLY to identify which row to land on,
// never for the column, and `moveToLineBoundary` is never reached.
//
// The goal is sticky across consecutive vertical moves, so passing through a
// short line and back out to a long one returns to the original column, and it
// is dropped by any other selection change or any edit.

import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type SelectionRange,
} from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { listContentStart, skipAtoms, verifiedLineBoundary } from "./line-boundary";

/** Carried by this module's own dispatches so the goal survives them. */
const setVerticalGoal = StateEffect.define<readonly number[] | null>();

/**
 * The sticky column per selection range, as characters from the start of the
 * visual row.
 *
 * ONE PER RANGE, not one for the whole selection: with several cursors at
 * different columns a single shared goal would drag them all onto the main
 * one's column at the first short line. CodeMirror's own `goalColumn` is
 * per-range for the same reason. The array is used only while its length still
 * matches the selection's, so a selection that gained or lost a cursor simply
 * re-derives.
 *
 * Anything that is not one of our own vertical moves clears it: an edit changes
 * what a column means, and a click or a horizontal move is the user choosing a
 * new one. Without the field the goals would have to live on the ranges'
 * `goalColumn`, which is a pixel value CodeMirror owns and repeatedly discards.
 *
 * One consequence worth knowing rather than working around: arrowing up into
 * the frontmatter boundary clears the goal. `frontmatterSelectionGuard` clamps
 * with `sequential: true`, i.e. a SECOND transaction that moves the selection
 * and carries no effect of ours, so the rule above fires. That is the honest
 * answer: the caret ended up somewhere it did not ask for, so the next move
 * re-derives its column from where it actually is.
 */
const verticalGoalField = StateField.define<readonly number[] | null>({
  create() {
    return null;
  },
  update(value, tr) {
    // Our own transaction carries the effect, and it wins over the checks below
    // precisely because it also moves the selection.
    for (const e of tr.effects) if (e.is(setVerticalGoal)) return e.value;
    if (tr.docChanged) return null;
    if (!tr.startState.selection.eq(tr.state.selection)) return null;
    return value;
  },
});

/**
 * Start of the visual row `range` sits on, and therefore the origin the column
 * is measured from.
 *
 * On a list or task line this is the CONTENT start, not the line start: the
 * `- [ ] ` is hidden behind a checkbox widget, so the content start is where the
 * row visibly begins, and a column measured from anywhere else would shift by
 * the marker's width whenever the caret crossed between a task line and a plain
 * one.
 *
 * `listContentStart` FIRST, rather than leaning on the smart-home that
 * `verifiedLineBoundary`'s backward direction already carries. Smart-home has a
 * deliberate carve-out: it returns the raw line start when the caret is already
 * at or before the content start, so a second Home press can still reach the raw
 * `- `, and that carve-out lands on exactly the position Home puts you at. A
 * caret sitting ON the content start would have measured its column from
 * `line.from`, i.e. 6 on a task line, while one character later measured 1, so
 * arrowing down from the first character of a label jumped six columns and from
 * the second jumped one. Reading the content start directly has no such hole,
 * and the `Math.min` keeps it an origin rather than a destination: a caret
 * genuinely inside the hidden marker measures from the line start, which is the
 * only thing it can mean there.
 */
function rowStart(view: EditorView, range: SelectionRange): number {
  const boundary = verifiedLineBoundary(view, range, false).head;
  const content = listContentStart(view.state, range.head);
  return content === null ? boundary : Math.min(content, range.head);
}

/** End of the visual row `range` sits on. */
function rowEnd(view: EditorView, range: SelectionRange): number {
  return verifiedLineBoundary(view, range, true).head;
}

/**
 * The row to land on, as any position inside it, or `null` when there is none.
 *
 * `moveVertically` is asked only WHICH row, never where in it: its column answer
 * is the defect this module exists for. When it reports no progress (at the
 * document's edge, or when its own probe fails) the adjacent logical line is
 * used instead, because the one thing that must never happen here is falling
 * through to `moveToLineBoundary`.
 */
function targetRow(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
): SelectionRange | null {
  const moved = view.moveVertically(
    EditorSelection.cursor(range.head, range.assoc),
    forward,
  );
  // The RANGE, not just its offset. On a soft-wrapped line a wrap point is one
  // offset shared by two visual rows, and only `assoc` says which, so reducing
  // this to a number and rebuilding a bare cursor would resolve the row
  // boundaries below against the row ABOVE the one we just moved into.
  if (moved.head !== range.head) return moved;

  const doc = view.state.doc;
  const line = doc.lineAt(range.head);
  if (forward) {
    return line.number < doc.lines
      ? EditorSelection.cursor(doc.line(line.number + 1).from, 1)
      : null;
  }
  return line.number > 1 ? EditorSelection.cursor(doc.line(line.number - 1).to, -1) : null;
}

/**
 * Where one range goes on a vertical move, plus the goal it should leave behind.
 *
 * Exported for the unit test, which drives it with a stubbed view, since jsdom has no
 * layout, so the probe cannot be exercised there and the COLUMN ARITHMETIC is
 * what there is to pin.
 */
export function verticalTarget(
  view: EditorView,
  range: SelectionRange,
  forward: boolean,
  goal: number | null,
): { head: number; assoc: -1 | 1; goal: number } | null {
  const column = goal ?? range.head - rowStart(view, range);
  const landing = targetRow(view, range, forward);
  if (landing === null) return null;

  const from = rowStart(view, landing);
  const to = rowEnd(view, landing);
  // Clamp to the row's end when the row is shorter. `column` is kept as the goal
  // regardless, so a longer row further along gets the original column back
  // rather than the clamped one.
  // `"nearer"` rather than a direction: a vertical move arrives with no
  // horizontal one, so the closest edge is the least surprising place to be
  // pushed out to. The delete path next door names `"forward"` / `"backward"`
  // for the same reason in reverse.
  const head = skipAtoms(view, Math.min(from + column, to), "nearer");
  // WHICH ROW the caret renders on, and it is not derivable from `forward`.
  //
  // A soft-wrap point is ONE offset shared by two visual rows, and only `assoc`
  // chooses between them. Landing on a row's START has to associate FORWARD (1)
  // or it renders at the end of the row above; landing on a row's END has to
  // associate BACKWARD (-1) or it renders at the start of the row below. Both
  // are reachable from either direction of travel: Down onto column 0 of a
  // wrapped row is a row start, and Up clamped to a short row is a row end. So
  // this reads the position, the way `targetRow` does twelve lines up, rather
  // than the direction. Getting it from `forward` puts the caret a row out and
  // makes the next press look like it did nothing, because `moveVertically`
  // then reports no progress from a head that never visibly moved.
  const assoc: -1 | 1 = head === to && to !== from ? -1 : 1;
  return { head, assoc, goal: column };
}

function moveVerticalByColumn(view: EditorView, forward: boolean, extend: boolean): boolean {
  const { ranges, mainIndex } = view.state.selection;
  const stored = view.state.field(verticalGoalField, false) ?? null;
  // Only while it still describes THIS selection; otherwise every range
  // re-derives its own column from where it sits.
  const goals = stored !== null && stored.length === ranges.length ? stored : null;

  let collapsed = false;
  const results = ranges.map((range, i) => {
    // CodeMirror's own first rule in `cursorByLine`, kept deliberately: a plain
    // arrow on a NON-EMPTY selection collapses it to the end it is heading for
    // rather than spending the keypress on a row. Only the pixel goal below it
    // is wrong in this app; this part is what every editor does. Shift+Arrow
    // extends from the head instead, so it skips this.
    if (!extend && !range.empty) {
      collapsed = true;
      return { range: EditorSelection.cursor(forward ? range.to : range.from), goal: 0 };
    }
    const t = verticalTarget(view, range, forward, goals?.[i] ?? null);
    // A range that could not move keeps whatever goal it had, so it rejoins the
    // others at its original column once it can move again.
    if (t === null) return { range, goal: goals?.[i] ?? 0 };
    return {
      range: extend
        ? EditorSelection.range(range.anchor, t.head)
        : EditorSelection.cursor(t.head, t.assoc),
      goal: t.goal,
    };
  });

  const selection = EditorSelection.create(
    results.map((r) => r.range),
    mainIndex,
  );
  // Nothing moved (at the document's edge, say) so fall through and let
  // CodeMirror's own command take its usual shot at the document start/end.
  if (selection.eq(view.state.selection)) return false;

  view.dispatch({
    selection,
    // A collapse is the user choosing a new position, not a step in a walk, so
    // the columns are dropped rather than carried into the next arrow press.
    effects: setVerticalGoal.of(collapsed ? null : results.map((r) => r.goal)),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

/**
 * Bound BEFORE `defaultKeymap` so these shadow `cursorLineUp` / `cursorLineDown`
 * and their `moveToLineBoundary` fallback, and AFTER `tableKeymap` so arrowing
 * into a read-only table still wins. Every platform, unlike the Mac-only
 * `lineBoundaryKeymap`: nothing about the defect is platform specific.
 */
export const lineVerticalKeymap: readonly KeyBinding[] = [
  {
    key: "ArrowUp",
    run: (view) => moveVerticalByColumn(view, false, false),
    shift: (view) => moveVerticalByColumn(view, false, true),
  },
  {
    key: "ArrowDown",
    run: (view) => moveVerticalByColumn(view, true, false),
    shift: (view) => moveVerticalByColumn(view, true, true),
  },
];

/** The sticky-column state the keymap above reads. */
export function lineVerticalExtension(): Extension {
  return verticalGoalField;
}

/**
 * The sticky columns, one per selection range, or `null` when there is no goal.
 *
 * Exported for the test that reads a goal back out of a REAL state. Deleting
 * `lineVerticalExtension()` from the extension list, or replacing the field's
 * `update` body with `return null`, failed nothing before this existed: the
 * field degrades silently, so the arrows go on working and only the stickiness
 * this module was written for is gone.
 */
export function verticalGoalOf(state: EditorState): readonly number[] | null {
  return state.field(verticalGoalField, false) ?? null;
}

/** The effect that carries a goal, exported for that same test. */
export const setVerticalGoalForTest = setVerticalGoal;
