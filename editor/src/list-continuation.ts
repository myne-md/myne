// Enter inside a list: `insertNewlineContinueMarkup`, with the two repairs it
// needs before a rendered checklist survives it (myne-md/myne#588, #593).
//
// # Why a repair rather than a command of our own
//
// The upstream command is not a line of logic, it is list semantics: the marker
// of the enclosing context at every nesting level, the ordered-list renumbering
// that follows an insertion, the dedent-on-empty-item rule, blockquote
// continuation, `\r\n` handling. Re-implementing that to change two things would
// be re-implementing all of it, and the parts we did not mean to change are the
// parts that would drift.
//
// So the command is used as a PLANNER. It is a `StateCommand`, which means the
// only thing it does with its `dispatch` is hand back one `Transaction` built
// from the state we gave it, so passing a `dispatch` that captures instead of
// applying yields the plan, unapplied, with nothing dispatched to the view. The
// two repairs below rewrite that plan's CHANGES; every change they do not name
// rides through byte-for-byte, including the renumbering ones.
//
// The dispatched transaction is rebuilt rather than forwarded, and it restates
// the three properties upstream sets on its own (`selection`, `scrollIntoView`,
// `userEvent`). Copying `plan.effects` across would be wrong rather than
// thorough: the rebuild runs `state.update` a second time, so any effect a
// transaction extender contributed is contributed again, and forwarding the
// first copy too would apply it twice.
//
// # Repair 1: the list stays as tight as the user wrote it (#588)
//
// `nonTightList()` is a property of the whole LIST: two items with a blank line
// anywhere between them make it "loose" in CommonMark's sense, and from then on
// every Enter in that list inserts a blank line before the new marker, including
// from items that have no blank line above them. One deliberately spaced list
// therefore starts double-spacing every item the user adds to it. The insert
// carries that blank line as a second line break, so the repair is to drop it.
//
// # Repair 2: a task marker keeps its separator (#593)
//
// Before inserting, the command walks the change's `from` back over every
// whitespace character preceding the caret, so that splitting an item does not
// leave trailing spaces behind. On a task line the character that walk reaches
// is the space between `[ ]` and the label, and GFM requires it. The parser's
// own test is `/^\[[ xX]\][ \t]/`, so `- [ ]` with nothing after it is not a
// task item at all. The item left above the split stops parsing as a task, its
// checkbox is not rendered, and the user is looking at raw `- [ ]` markup.
//
// Neither repair is reachable from `insertNewlineContinueMarkupCommand`'s
// config: `nonTightLists` gates only the empty-item arm (which myne#562 already
// configures), and the whitespace walk has no option at all.

import {
  type ChangeSpec,
  EditorSelection,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";

/** The upstream command, configured as myne-md/myne#562 configured it: Enter on
 *  an empty list item deletes a level of markup rather than pushing the item
 *  down a row to make a tight list loose. */
const planContinuation = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** A task marker at the very END of the text left above the split, i.e. the
 *  caret sits between `[ ]` and its label. Mirrors the parser's marker shape
 *  (`@lezer/markdown`'s `TaskList` leaf), minus the separator this is about. */
const TASK_MARKER_TAIL = /\[[ xX]\]$/;

/** What CommonMark counts as a blank line inside a list or quote context: the
 *  quote marks and indentation the context contributes, and nothing else. This
 *  is the shape `blankLine()` builds, so it is the shape repair 1 removes. */
const BLANK_LINE = /^[\s>]*$/;

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

/**
 * Enter in a Markdown markup context (list item, blockquote), repaired.
 *
 * Returns false, leaving Enter to the bindings below it (`autoCloseFence` and
 * `defaultKeymap`), exactly when the upstream command declines: outside a
 * markup context, on a non-empty selection, and with the caret inside the
 * markup of its own line.
 */
export const continueListMarkup: StateCommand = ({ state, dispatch }) => {
  let planned: Transaction | null = null;
  const handled = planContinuation({
    state,
    dispatch: (tr) => {
      planned = tr;
    },
  });
  // TS narrows `planned` back to its initialiser across the call (it is only
  // ever assigned from a closure), so the capture needs re-typing to be read.
  const plan = planned as Transaction | null;
  if (!handled || plan === null) return false;

  const lineBreak = state.lineBreak;
  const changes: ChangeSpec[] = [];
  /** The `from` of each repaired continuation insert: one per selection range,
   *  and where that range's caret ends up once the change lands. */
  const carets: number[] = [];

  plan.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let text = inserted.toString();
    // Only a continuation insert opens with a line break. The command's other
    // shapes (the markup deletion on an empty item, an ordered list's
    // renumbering, the blockquote double-blank collapse) are left alone.
    if (!text.startsWith(lineBreak)) {
      changes.push({ from: fromA, to: toA, insert: text });
      return;
    }

    let from = fromA;
    let to = toA;

    // Repair 1 (#588): `lineBreak + blank + lineBreak + markup` → `lineBreak +
    // markup`. `markup` never contains a line break, so the second break can
    // only be the loose-list blank line.
    const rest = text.slice(lineBreak.length);
    const secondBreak = rest.indexOf(lineBreak);
    if (secondBreak !== -1 && BLANK_LINE.test(rest.slice(0, secondBreak))) {
      text = lineBreak + rest.slice(secondBreak + lineBreak.length);
    }

    // Repair 2 (#593): keep one separator on each side of the split when it
    // falls between a task marker and its label.
    const line = state.doc.lineAt(fromA);
    if (TASK_MARKER_TAIL.test(state.doc.sliceString(line.from, from))) {
      if (from < to && isSpace(state.doc.sliceString(from, from + 1))) {
        from += 1; // keep one of the characters the walk was about to eat
      } else {
        text = " " + text; // the caret was tight against `]`, so add one
      }
      // The markup carries a separator of its own, so whitespace still standing
      // at the split point would double it on the new line.
      //
      // SPACES only, never a tab, and the distinction is a byte-stability one
      // rather than a cosmetic one. `isSpace` here matched both, so a tab at the
      // split point was deleted rather than carried: measured against upstream
      // over 23 documents at every caret offset, `- [ ]\ttab` split at the
      // marker gave `- [ ] \n- tab` where upstream gives `- [ ]\n- \ttab`. A tab
      // is indentation the author typed, which `markdown-dialect.md` §6 C1 says
      // is theirs; a run of spaces at the marker IS the separator this repair is
      // re-adding one of, which is why the run is still collapsed.
      //
      // Stopping after a single space instead was the other wrong answer, and it
      // was measured too: on `- [ ]  foo` it leaves three spaces where the author
      // wrote two, because the split consumes one and the markup adds one back.
      // Collapsing the whole space run is what makes the count come out at what
      // was there.
      if (text.endsWith(" ")) {
        while (to < line.to && state.doc.sliceString(to, to + 1) === " ") to += 1;
      }
    }

    changes.push({ from, to, insert: text });
    carets.push(from);
  });

  // No continuation insert to repair (the empty-item and blockquote arms): the
  // plan is already what we want, so dispatch it rather than rebuilding it.
  if (carets.length === 0) {
    dispatch(plan);
    return true;
  }

  const changeSet = state.changes(changes);
  // Mapping the insert's own `from` forward lands after the inserted text, at the
  // same position upstream computes as `from + insert.length + 1`, but derived
  // from the REPAIRED change and through any earlier change in the same set.
  const ranges = carets.map((pos) => EditorSelection.cursor(changeSet.mapPos(pos, 1)));
  const mainIndex = Math.min(plan.selection?.mainIndex ?? 0, ranges.length - 1);
  dispatch(
    state.update({
      changes: changeSet,
      selection: EditorSelection.create(ranges, mainIndex),
      scrollIntoView: true,
      // Upstream's own annotation. History groups on it, so a continuation
      // undoes with the typing around it rather than as its own step.
      userEvent: "input",
    }),
  );
  return true;
};
