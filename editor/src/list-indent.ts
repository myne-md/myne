// Tab on a list line indents to a column the parser can read (myne-md/myne#658).
//
// # The defect
//
// `indentMore` inserts the `indentUnit` facet's literal string at the start of
// the line. It is structure-blind by design, which is right for code and wrong
// for a markdown list, because a list item's nesting is decided by a COLUMN, not
// by a width:
//
//   - Under a paragraph, four or more leading spaces make the line a lazy
//     continuation of that paragraph rather than a list item. So one Tab on a
//     `- [ ] …` line under a plain line of prose stopped it being a task at all:
//     `@lezer/markdown` emits no `Task` node, the checkbox never renders, and
//     `dialect/src/visitors/lineTasks.ts` builds the vault-wide index off the
//     same parse, so the todo also vanished from the Tasks panel, from every
//     filter and from the reminder scheduler, with nothing saying so.
//   - Under an existing item, the child must reach the PARENT'S CONTENT COLUMN.
//     `- ` is column 2, `1. ` is column 3, `10. ` is column 4. A fixed width is
//     right for at most one of them.
//
// # Why not just change `indentUnit`
//
// That was the first attempt and it is worse than it looks. Two spaces fixes the
// paragraph case at one depth and breaks the ordered-list case:
//
//     "1. parent\n  - [ ] child\n"   ->  OrderedList, BulletList  (siblings)
//     "1. parent\n   - [ ] child\n"  ->  OrderedList > ListItem > BulletList
//
// so a Tab under `1. ` silently produced a second list instead of a nested item
//. The same class of failure #658 is about, moved rather than removed. And two
// Tabs still reach four columns, so the paragraph case comes straight back one
// keystroke later. The cliff is not a width, so no width clears it.
//
// # The shape
//
// `list-continuation.ts`'s pattern: keep the upstream command for everything it
// is right about, and answer only the case it cannot see. A non-list line falls
// through to `indentMore` untouched, so indented code still indents by the
// editor's unit and every other language keeps its own indentation service.

import { indentLess, indentMore } from "@codemirror/commands";
import type { StateCommand } from "@codemirror/state";

/** Leading-whitespace width of `text`, counting a tab as the next multiple of 4. */
function indentWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4 - (width % 4);
    else break;
    }
  return width;
}

/** Whether `text` is a list item of any marker, bullet, task or ordered.
 *
 *  Shared with `decorations/hard-break.ts`, which needs the same question for a
 *  different reason (myne#657) and must not grow a second regex for it. */
export function isListItemLine(text: string): boolean {
  return contentColumn(text) !== null;
}

/** The content column of a list line: past its marker and the space after it.
 *  `null` when the line is not a list item. */
function contentColumn(text: string): number | null {
  const m = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)/.exec(text);
  if (m === null) return null;
  return indentWidth(m[1]!) + m[2]!.length + m[3]!.length;
}

/**
 * What Tab should do on this line.
 *
 * Three answers, not two, and the third is why this is not a `number | null`.
 * `defer` hands the line to `indentMore`; `indent` names a column; `noop`
 * consumes the key and changes nothing. Collapsing `noop` into `defer` is what
 * made the first version recreate myne#658 on the second press: deferring from a
 * list line that has no room left runs `indentMore`, which adds the full
 * four-space unit on top of what is already there.
 */
export type IndentPlan =
  | { kind: "defer" }
  | { kind: "noop" }
  | { kind: "indent"; column: number };

/**
 * The plan for `lineText`, given the non-blank lines above it.
 *
 * Exported for `tests/editor/listIndent.test.ts`: this is the decision, and the
 * command around it is plumbing.
 */
export function nextIndentColumn(
  lineText: string,
  precedingListLines: readonly string[],
): IndentPlan {
  if (contentColumn(lineText) === null) return { kind: "defer" }; // not a list item
  const own = indentWidth(lineText);

  // The nearest preceding list line that is not deeper than this one is the
  // item this one would nest under. Its CONTENT column is where a child starts.
  for (let i = precedingListLines.length - 1; i >= 0; i--) {
    const candidate = precedingListLines[i]!;
    const col = contentColumn(candidate);
    if (col === null) continue;
    if (indentWidth(candidate) <= own) {
      return col > own ? { kind: "indent", column: col } : { kind: "noop" };
    }
  }

  // No list above it: the line is a list interrupting a paragraph (or opening
  // the document). Any column from 1 to 3 keeps it a list item, and FOUR is the
  // cliff, so this case is clamped rather than stepped.
  //
  // `own + 2` alone recreated the exact bug on the SECOND press: 0 to 2 to 4,
  // and at 4 the line is a lazy continuation again, so the checkbox stops
  // rendering and the todo leaves the Tasks panel. `listIndent.test.ts` pins
  // that four columns under a paragraph is not a task, which is the assertion
  // that catches this.
  //
  // There is no deeper level to offer here, because a list interrupting a
  // paragraph has no parent to nest under. Refusing to go past 3 is the honest
  // answer: further Tabs are a no-op rather than a silent destruction.
  const PARAGRAPH_INTERRUPT_MAX = 3;
  if (own >= PARAGRAPH_INTERRUPT_MAX) return { kind: "noop" };
  return { kind: "indent", column: Math.min(own + 2, PARAGRAPH_INTERRUPT_MAX) };
}

/**
 * Tab. Indents a list line to a parser-legible column, everything else through
 * `indentMore`.
 */
export const listAwareIndent: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  // Multi-line selections are `indentMore`'s job: it indents every line in the
  // range, and re-deriving that per line here would be re-implementing it.
  if (state.doc.lineAt(range.anchor).number !== line.number) {
    return indentMore({ state, dispatch });
  }

  const preceding: string[] = [];
  for (let n = line.number - 1; n >= 1 && preceding.length < 64; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") break; // a blank line ends the list context
    preceding.push(text);
  }
  preceding.reverse();

  const plan = nextIndentColumn(line.text, preceding);
  if (plan.kind === "defer") return indentMore({ state, dispatch });
  // Consume the key and change nothing. NOT a fall-through to `indentMore`:
  // this line is a list item with no room left, and `indentMore` would add the
  // whole four-space unit on top, landing back on the lazy-continuation cliff
  // that myne#658 is about.
  if (plan.kind === "noop") return true;

  const current = indentWidth(line.text);
  const insert = " ".repeat(plan.column - current);

  dispatch(
    state.update({
      changes: { from: line.from, insert },
      // The caret keeps its position in the TEXT, not its offset in the doc.
      selection: { anchor: range.anchor + insert.length, head: range.head + insert.length },
      userEvent: "input.indent",
      scrollIntoView: true,
    }),
  );
  return true;
};

/**
 * Shift-Tab on a list line: outdent one level and leave the caret inside the item
 * (myne-md/myne#1064).
 *
 * The report: after an outdent the next character landed in front of the marker
 * (`P- [ ]`), which also stops the line parsing as a task, so the checkbox goes
 * and the todo leaves the Tasks panel. `indentLess` removes up to one
 * `indentUnit` of leading whitespace and maps the selection by that length, which
 * is right at depth 1 by accident and says nothing about the caret: one at the
 * line's start — where an empty rendered item leaves it — stays in front of the
 * marker.
 *
 * So: step out to the enclosing list line's indent, and floor the caret at the
 * item's CONTENT column, past the `[ ]` as well as the bullet. Off a list line
 * this is still `indentLess`.
 */
export const listAwareOutdent: StateCommand = ({ state, dispatch }) => {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  // A selection that spans lines is `indentLess`'s job, for the same reason the
  // indent side defers: it outdents every line in the range, and re-deriving that
  // per line here would be re-implementing it.
  if (!range.empty) return indentLess({ state, dispatch });
  if (!isListItemLine(line.text)) return indentLess({ state, dispatch });

  const ownWidth = indentWidth(line.text);
  const ownChars = leadingWhitespaceChars(line.text);

  const preceding: string[] = [];
  for (let n = line.number - 1; n >= 1 && preceding.length < 64; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") break; // a blank line ends the list context
    preceding.push(text);
  }
  preceding.reverse();

  // The step out is to the nearest shallower list line's INDENT — the level this
  // item belonged to — or to column 0 when there is none.
  let targetWidth = 0;
  for (let i = preceding.length - 1; i >= 0; i--) {
    const candidate = preceding[i]!;
    if (contentColumn(candidate) === null) continue;
    const indent = indentWidth(candidate);
    if (indent < ownWidth) {
      targetWidth = indent;
      break;
    }
  }

  // How many leading characters to delete to reach `targetWidth`. Characters
  // rather than columns, because a tab can cross the target in one step.
  let removeChars = 0;
  let removedWidth = 0;
  while (removeChars < ownChars && removedWidth < ownWidth - targetWidth) {
    const ch = line.text[removeChars]!;
    removedWidth += ch === "\t" ? 4 - (removedWidth % 4) : 1;
    removeChars += 1;
  }

  const head = range.head;
  const anchor = range.anchor;

  if (removeChars === 0) {
    // Already at the outermost level: consume the key, change nothing except
    // flooring the caret inside the item.
    dispatch(
      state.update({
        selection: floorSelection(line.text, line.from, head, anchor),
        userEvent: "input.indent",
      }),
    );
    return true;
  }

  // Delete leading WHITESPACE only, never the marker: the item must keep parsing.
  const next = state.update({
    changes: { from: line.from, to: line.from + removeChars },
    // The caret keeps its position in the TEXT, then is floored at the NEW
    // line's content column — which is the fix: an outdent can no longer leave
    // it in front of the marker.
    selection: floorSelection(
      line.text.slice(removeChars),
      line.from,
      head - removeChars,
      anchor - removeChars,
    ),
    userEvent: "input.indent",
    scrollIntoView: true,
  });
  dispatch(next);
  return true;
};

/** Leading whitespace characters of `text` (the indentation's length in bytes). */
function leadingWhitespaceChars(text: string): number {
  let n = 0;
  while (n < text.length && (text[n] === " " || text[n] === "\t")) n += 1;
  return n;
}

/** Where an item's CONTENT starts, past the bullet AND the `[ ] ` marker: a caret
 *  between the two is the same defect one character along. */
function itemContentColumn(text: string): number {
  const base = contentColumn(text);
  if (base === null) return 0;
  const rest = text.slice(base);
  const task = /^\[[ xX]\]([ \t]+)/.exec(rest);
  return task === null ? base : base + 3 + task[1]!.length;
}

/** Both ends floored, not only the head: a range that began before the marker
 *  would otherwise start the next edit outside the item. */
function floorSelection(
  text: string,
  lineFrom: number,
  head: number,
  anchor: number,
): { anchor: number; head: number } {
  const floor = lineFrom + itemContentColumn(text);
  return {
    anchor: Math.max(anchor, floor),
    head: Math.max(head, floor),
  };
}
