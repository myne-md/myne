// @vitest-environment jsdom
//
// myne-md/myne#631: ArrowUp / ArrowDown go to the same COLUMN on the adjacent
// row, not to that row's end.
//
// CodeMirror's `cursorLineUp` / `cursorLineDown` are coordinate probes: the goal
// is a pixel x, and when `moveVertically` cannot make progress they fall back to
// `moveToLineBoundary`, the probe `line-boundary.ts` documents as wrong in this
// app's centred max-width column. Three of `moveVertically`'s four return paths
// also drop or mis-derive the goal, and one of them clamps it to the full
// content width, which resolves to the target line's END and is then preserved,
// so the caret walks down the document hitting the end of every line.
//
// jsdom has no layout, so the probe cannot be exercised here. What can be
// pinned, and what the fix actually is, is the COLUMN ARITHMETIC: given a row
// to land on, does the caret take the column or the row's end? The stub below
// therefore models `moveVertically` returning the BROKEN answer (the adjacent
// line's end) on purpose: every assertion that passes is one that ignored it.

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, RangeSet } from "@codemirror/state";
import { Decoration, BlockType, EditorView, keymap } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  lineVerticalExtension,
  lineVerticalKeymap,
  setVerticalGoalForTest,
  verticalGoalOf,
  verticalTarget,
} from "@myne/editor/line-vertical";
import { myneExtensions } from "../../src/editor/extensions";
import { tableKeymap } from "@myne/editor/decorations/table";

//        0                   20 21   26 27                  47 48         59
const DOC = "0123456789ABCDEFGHIJ\nabcde\n0123456789ABCDEFGHIJ\n- [ ] label\n";
const LONG_1 = { from: 0 };
const SHORT = { from: 21, to: 26 };
const LONG_2 = { from: 27, to: 47 };
/** A task line: `- [ ] ` is six characters, so the label starts at 48 + 6. */
const TASK = { from: 48, content: 48 + 6, to: 48 + 11 };

/** One `moveToLineBoundary` call, recorded so a test can read its `assoc`. */
interface BoundaryCall {
  readonly head: number;
  readonly assoc: number;
  readonly forward: boolean;
}

/**
 * A view stub carrying only what `verticalTarget` reads.
 *
 * `moveVertically` deliberately answers with the adjacent line's END, which is
 * the defect's own answer, so the tests below prove the column comes from
 * elsewhere. `coordsAtPos` gives one y per line, which is what makes
 * `verifiedLineBoundary` accept the boundary probe rather than fall back.
 */
function stubView(
  extensions: readonly unknown[] = [],
  boundaryCalls: BoundaryCall[] = [],
): EditorView {
  // The markdown language is not decoration: `listMarkerEnd` confirms its regex
  // against the parse tree before agreeing a line is a list item, so without it
  // every task-line case here would silently take the not-a-list branch.
  const state = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage }), ...(extensions as never[])],
  });
  const view = {
    state,
    moveToLineBoundary: (range: { head: number; assoc: number }, forward: boolean) => {
      boundaryCalls.push({ head: range.head, assoc: range.assoc, forward });
      const line = state.doc.lineAt(range.head);
      return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
    },
    coordsAtPos: (pos: number) => {
      const y = state.doc.lineAt(pos).number * 20;
      return { top: y, bottom: y + 18, left: 0, right: 0 };
    },
    moveVertically: (range: { head: number }, forward: boolean) => {
      const line = state.doc.lineAt(range.head);
      const n = line.number + (forward ? 1 : -1);
      if (n < 1 || n > state.doc.lines) return EditorSelection.cursor(range.head);
      // The broken answer on purpose: the adjacent line's END, and with the
      // `assoc` CodeMirror puts on it, which is the part that must survive.
      return EditorSelection.cursor(state.doc.line(n).to, -1);
    },
    ...blockMap(state, () => 20),
  };
  return view as unknown as EditorView;
}

/**
 * The height map half of the stub: one 20px `BlockType.Text` block per logical
 * line, which is the shape `isAdjacentRow` reads. `heightOf` lets a caller make
 * one line taller, which is how a soft-wrapped line is modelled.
 *
 * It exists because `isAdjacentRow` verifies `moveVertically`'s answer instead
 * of trusting it, so a stub without these two methods cannot drive the module at
 * all — and a stub that returned "adjacent, always" would make the guard
 * untestable, which is the failure mode this file's own history is about.
 */
function blockMap(
  state: EditorState,
  heightOf: (line: number) => number,
): {
  lineBlockAt: (pos: number) => unknown;
  lineBlockAtHeight: (height: number) => unknown;
} {
  const topOf = (n: number) => {
    let y = 0;
    for (let i = 1; i < n; i++) y += heightOf(i);
    return y;
  };
  const at = (n: number) => ({
    from: state.doc.line(n).from,
    to: state.doc.line(n).to,
    top: topOf(n),
    bottom: topOf(n) + heightOf(n),
    type: BlockType.Text,
  });
  return {
    lineBlockAt: (pos: number) => at(state.doc.lineAt(pos).number),
    lineBlockAtHeight: (height: number) => {
      let y = 0;
      for (let n = 1; n <= state.doc.lines; n++) {
        const h = heightOf(n);
        if (height < y + h) return at(n);
        y += h;
      }
      return at(state.doc.lines);
    },
  };
}

/** Offset where the task line's single logical line breaks into two rows. */
const TASK_WRAP = TASK.from + 8;
/**
 * The shared stub with ONE line soft-wrapped, which is the only difference that
 * matters here: `coordsAtPos` gives the task line's two rows different y values,
 * and `moveToLineBoundary` answers with the ROW start rather than the line's.
 */
function wrappedTaskStubView(): EditorView {
  const state = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const rowOf = (pos: number) => (pos >= TASK_WRAP && pos <= TASK.to ? 1 : 0);
  const view = {
    state,
    moveToLineBoundary: (range: { head: number }, forward: boolean) => {
      const line = state.doc.lineAt(range.head);
      if (line.from !== TASK.from) {
        return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
      }
      const second = rowOf(range.head) === 1;
      const at = forward ? (second ? line.to : TASK_WRAP) : second ? TASK_WRAP : line.from;
      return EditorSelection.cursor(at, forward ? -1 : 1);
    },
    coordsAtPos: (pos: number) => {
      const y = state.doc.lineAt(pos).number * 20 + rowOf(pos) * 10;
      return { top: y, bottom: y + 8, left: 0, right: 0 };
    },
    moveVertically: (range: { head: number }, forward: boolean) => {
      const line = state.doc.lineAt(range.head);
      const n = line.number + (forward ? 1 : -1);
      if (n < 1 || n > state.doc.lines) return EditorSelection.cursor(range.head);
      return EditorSelection.cursor(state.doc.line(n).to, -1);
    },
    ...blockMap(state, (n) => (state.doc.line(n).from === TASK.from ? 30 : 20)),
  };
  return view as unknown as EditorView;
}

/**
 * The shared stub with `moveVertically` answering the DOCUMENT START, which is
 * what `posAtCoords` returns (`PosAssoc(0, 1)`) when its scan walks above the
 * content box — the reported "ArrowUp teleports me to the note's heading".
 */
function jumpyStubView(): EditorView {
  const state = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const view = {
    state,
    moveToLineBoundary: (range: { head: number }, forward: boolean) => {
      const line = state.doc.lineAt(range.head);
      return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
    },
    // A real y per line, so `verifiedLineBoundary` VERIFIES the probe and the
    // row boundaries below are the sane ones. Only the row choice is broken.
    coordsAtPos: (pos: number) => {
      const y = state.doc.lineAt(pos).number * 20;
      return { top: y, bottom: y + 18, left: 0, right: 0 };
    },
    moveVertically: () => EditorSelection.cursor(0, 1),
    ...blockMap(state, () => 20),
  };
  return view as unknown as EditorView;
}

/**
 * The shared stub whose BACKWARD boundary, on the caret's own row, resolves past
 * the caret — and whose `coordsAtPos` is constant, so the verification in
 * `verifiedLineBoundary` cannot tell that it did (`before === null || after ===
 * null` is not the only way to be unmeasurable; a same-y answer is what a caret
 * against a replaced run produces).
 *
 * Everything except that one case answers normally, so the landing row's own
 * boundaries stay sane and the assertion is about the NEGATIVE column alone.
 */
function bogusRowStartStubView(): EditorView {
  const state = EditorState.create({
    doc: DOC,
    extensions: [markdown({ base: markdownLanguage })],
  });
  const original = TASK.content + 3;
  const view = {
    state,
    moveToLineBoundary: (range: { head: number }, forward: boolean) => {
      if (!forward && range.head === original) {
        return EditorSelection.cursor(original + 2, 1);
      }
      const line = state.doc.lineAt(range.head);
      return EditorSelection.cursor(forward ? line.to : line.from, forward ? -1 : 1);
    },
    // Constant: the probe always looks like it stayed on the caret's row.
    coordsAtPos: () => ({ top: 0, bottom: 18, left: 0, right: 0 }),
    moveVertically: (range: { head: number }, forward: boolean) => {
      const line = state.doc.lineAt(range.head);
      const n = line.number + (forward ? 1 : -1);
      if (n < 1 || n > state.doc.lines) return EditorSelection.cursor(range.head);
      return EditorSelection.cursor(state.doc.line(n).to, -1);
    },
    ...blockMap(state, () => 20),
  };
  return view as unknown as EditorView;
}

describe("verticalTarget", () => {
  it("refuses a row answer that is not adjacent, instead of jumping to it", () => {
    // The reported defect, mechanised. `moveVertically` is a coordinate probe,
    // and `posAtCoords` answers `PosAssoc(0, 1)` — the document's FIRST line —
    // when its upward scan walks past the top of the content box. Every arm of
    // that scan is reachable on a task row (the `- [ ] ` run is a replaced
    // range, `+` is a point widget, headings hide their `#`), so what the user
    // sees is "ArrowUp from any todo teleports me to the note's heading", six
    // rows away, with the character column intact — the column is computed
    // separately, which is why the jump read as a row move.
    //
    // The stub's answer is offset 0 on purpose. The assertion is that the caret
    // ends up ONE row up, at the same column, and not on line 1.
    const view = jumpyStubView();
    const out = verticalTarget(view, EditorSelection.cursor(TASK.content + 3), false, null);
    expect(out).not.toBeNull();
    expect(out!.head, "one row up, same column — not the document's first line").toBe(
      LONG_2.from + 3,
    );
  });

  it("never measures a column from a row that starts after the caret", () => {
    // The other way a vertical arrow reaches backwards: `rowStart`'s verified
    // boundary trusts its probe when `coordsAtPos` cannot measure the position
    // (`before === null || after === null` is "unmeasurable → trust it"), and a
    // task row is exactly where it cannot — the caret sits against a replaced
    // run. A boundary that resolves PAST the caret makes the column negative,
    // and `min(from + column, to)` then lands on the row above the one that was
    // chosen. Clamped, the same input can only land on the row's start.
    const view = bogusRowStartStubView();
    const out = verticalTarget(
      view,
      EditorSelection.cursor(TASK.content + 3),
      false,
      null,
    );
    expect(out).not.toBeNull();
    expect(out!.goal, "a column is never negative").toBe(0);
    expect(out!.head, "the landing row's own start").toBe(LONG_2.from);
  });

  it("lands on the same column, not the row's end, when the next row is longer", () => {
    const view = stubView();
    // Column 5 on the short middle line, moving down into a 20-char line.
    const out = verticalTarget(view, EditorSelection.cursor(SHORT.from + 5), true, null);
    expect(out).not.toBeNull();
    // `LONG_2.to` is the stub's own answer and the reported symptom both, so
    // landing on the column rather than there is the whole assertion.
    expect(out!.head).toBe(LONG_2.from + 5);
  });

  it("clamps to the row's end when the next row is shorter", () => {
    const view = stubView();
    const out = verticalTarget(view, EditorSelection.cursor(LONG_1.from + 12), true, null);
    expect(out!.head).toBe(SHORT.to); // 5 chars, so column 12 does not exist
  });

  it("keeps the ORIGINAL column as the goal after clamping, so it comes back", () => {
    // The property a pixel goal cannot give and a re-derived column cannot
    // either: passing through a short line and out the other side must return to
    // where the caret started, not to the short line's end.
    const view = stubView();
    const down = verticalTarget(view, EditorSelection.cursor(LONG_1.from + 12), true, null);
    expect(down!.goal).toBe(12);
    const again = verticalTarget(view, EditorSelection.cursor(down!.head), true, down!.goal);
    expect(again!.head).toBe(LONG_2.from + 12);
  });

  it("measures a task line's column from its LABEL, including at the label's start", () => {
    // The `- [ ] ` is decoration-hidden behind a checkbox, so the label is where
    // the row visibly begins and the column has to be measured from there, or it
    // shifts by six whenever the caret crosses between a task line and a plain
    // one.
    //
    // The at-the-start case is the one that had a hole. Smart-home deliberately
    // returns the RAW line start when the caret is already at the content start,
    // so a second Home press can reach the `- `, and leaning on it here made a
    // caret ON the label's first character measure column 6 while one character
    // later measured 1.
    const view = stubView();
    const atStart = verticalTarget(view, EditorSelection.cursor(TASK.content), false, null);
    expect(atStart!.goal, "column at the label's first character").toBe(0);
    const oneIn = verticalTarget(view, EditorSelection.cursor(TASK.content + 1), false, null);
    expect(oneIn!.goal, "column one character later").toBe(1);
  });

  it("measures a wrapped list item from its own visual row, not the item's", () => {
    // `listContentStart` is LINE-based, so on the second visual row of a
    // soft-wrapped list or task item it answers with the FIRST row's content
    // start. Taking it there measures the column across a wrap boundary, and the
    // arithmetic then cancels: the landing row's origin comes out as the same
    // content start, so `min(from + column, to)` resolves back to the position
    // the caret was already at, `moveVerticalByColumn` sees an unchanged
    // selection and returns false, and the press falls through to
    // `defaultKeymap` and into the `moveToLineBoundary` probe this whole module
    // exists to shadow.
    //
    // Wrapped list items are the common case in a prose editor, and no other
    // test here models wrapping: the shared stub gives one y per LINE, which is
    // what let this ship. This stub gives the task line two rows.
    const view = wrappedTaskStubView();
    const out = verticalTarget(view, EditorSelection.cursor(TASK_WRAP + 1), false, null);
    expect(out).not.toBeNull();
    // One character into the second row. Measured from the item's content start
    // it would be 3, which is a position on the row above.
    expect(out!.goal, "column measured from the caret's own visual row").toBe(1);
  });

  it("mirrors upward", () => {
    const view = stubView();
    const out = verticalTarget(view, EditorSelection.cursor(LONG_2.from + 7), false, null);
    expect(out!.head).toBe(SHORT.to); // clamped: the short line has 5 chars
    expect(out!.goal).toBe(7);
  });

  it("returns null at the document's edge, so CodeMirror's own command runs", () => {
    const view = stubView();
    expect(verticalTarget(view, EditorSelection.cursor(2), false, null)).toBeNull();
    const lastLine = view.state.doc.line(view.state.doc.lines);
    expect(verticalTarget(view, EditorSelection.cursor(lastLine.from), true, null)).toBeNull();
  });

  it("pushes a landing inside an atomic range out to its nearer edge", () => {
    // Seven providers register atomic ranges in the real editor (tag chip, task
    // chip, table, frontmatter, attachment embed, drawing embed, wikilink chip).
    // CodeMirror's own skip happens inside `moveVertically` and drops the goal on
    // the way, so this module does it after taking the column. A real RangeSet,
    // not a hand-rolled `between`: the arithmetic being checked is the choice of
    // edge, and a fake iterator would let a wrong `between` contract pass.
    const atom = RangeSet.of([
      Decoration.replace({}).range(LONG_2.from + 2, LONG_2.from + 8),
    ]);
    const view = stubView([EditorView.atomicRanges.of(() => atom)]);

    // Column 3 lands inside (2, 8), nearer the start, so it goes to 2.
    const near = verticalTarget(view, EditorSelection.cursor(SHORT.from + 3), true, null);
    expect(near!.head).toBe(LONG_2.from + 2);
    // Column 7 is nearer the end, so it goes to 8.
    const far = verticalTarget(view, EditorSelection.cursor(SHORT.from + 4), true, 7);
    expect(far!.head).toBe(LONG_2.from + 8);
    // The goal is the column the user asked for, not the pushed-out position.
    expect(far!.goal).toBe(7);
  });

  it("keeps going when leaving one provider's range lands inside another's", () => {
    // The bound loop in `skipAtoms` exists for this and only this: seven
    // providers register atomic ranges and nothing makes them disjoint, so one
    // pass can leave a position inside a neighbour. A single-pass version passes
    // every other case in this file, which is why the overlap gets its own.
    //
    // Two providers whose ranges OVERLAP: [2, 8) and [6, 12). Column 7 is inside
    // the first, whose nearer edge is 8, which is inside the second, whose
    // nearer edge is 6, which is inside the first again. Choosing the nearer
    // edge every pass oscillates 8 and 6 forever and the bound returns a
    // position still inside a range, which is the one outcome this function
    // exists to prevent. Committing to the side the first pass chose is what
    // makes it converge.
    const first = RangeSet.of([Decoration.replace({}).range(LONG_2.from + 2, LONG_2.from + 8)]);
    const second = RangeSet.of([Decoration.replace({}).range(LONG_2.from + 6, LONG_2.from + 12)]);
    const view = stubView([
      EditorView.atomicRanges.of(() => first),
      EditorView.atomicRanges.of(() => second),
    ]);

    const out = verticalTarget(view, EditorSelection.cursor(SHORT.from + 4), true, 7);
    const col = out!.head - LONG_2.from;
    // Outside BOTH, not merely outside the one it was pushed from.
    expect(col <= 2 || col >= 12, `column ${col} is still inside an atomic range`).toBe(true);
  });

  it("associates a row-START landing forward and a row-END landing backward", () => {
    // A soft-wrap point is ONE offset shared by two visual rows, and only
    // `assoc` chooses between them. Deriving it from the direction of travel
    // (`forward ? -1 : 1`) is the obvious thing and it is inverted: Down onto
    // column 0 of a wrapped row is a row START and would render at the end of
    // the row above, so the caret looks not to have moved and the next press
    // then jumps a whole paragraph. jsdom cannot wrap, so what is pinned is the
    // rule the renderer reads.
    const view = stubView();

    // Column 0: the landing is the row's start, whichever way we came.
    const down = verticalTarget(view, EditorSelection.cursor(SHORT.from), true, null);
    expect(down!.head).toBe(LONG_2.from);
    expect(down!.assoc).toBe(1);
    const up = verticalTarget(view, EditorSelection.cursor(LONG_2.from), false, null);
    expect(up!.head).toBe(SHORT.from);
    expect(up!.assoc).toBe(1);

    // Clamped to a short row's end: the landing is the row's end, either way.
    const clampedDown = verticalTarget(view, EditorSelection.cursor(LONG_1.from + 12), true, null);
    expect(clampedDown!.head).toBe(SHORT.to);
    expect(clampedDown!.assoc).toBe(-1);
    const clampedUp = verticalTarget(view, EditorSelection.cursor(LONG_2.from + 12), false, null);
    expect(clampedUp!.head).toBe(SHORT.to);
    expect(clampedUp!.assoc).toBe(-1);
  });

  it("resolves the landing row from the RANGE, assoc included, not a bare offset", () => {
    // On a soft-wrapped line a wrap point is ONE offset shared by two visual
    // rows, and only `assoc` says which. Reducing `moveVertically`'s answer to a
    // number, which is the obvious simplification, makes the row boundaries
    // below resolve against the row ABOVE the one just moved into, so the caret
    // lands a row short on every wrapped paragraph. jsdom cannot wrap anything,
    // so what is pinned is that the assoc reaches the boundary probe at all.
    const calls: BoundaryCall[] = [];
    const view = stubView([], calls);
    verticalTarget(view, EditorSelection.cursor(SHORT.from + 3), true, null);

    const onLanding = calls.filter((c) => c.head === LONG_2.to);
    expect(onLanding.length, "the landing row's boundaries were probed").toBeGreaterThan(0);
    for (const c of onLanding) expect(c.assoc).toBe(-1);
  });
});

describe("a plain arrow on a non-empty selection", () => {
  // This path needs NO layout: the command answers before it ever measures, so
  // unlike everything above it can run against a real EditorView in jsdom.
  //
  // It exists because it is CodeMirror's own first rule in `cursorByLine`, and
  // this module shadows that command wholesale. Only the pixel goal underneath
  // it is wrong in this app; collapsing a selection to the end it is heading for
  // is what every editor does, and dropping it would be a regression introduced
  // by a fix.
  function mount(): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc: DOC,
        extensions: [lineVerticalExtension()],
        selection: EditorSelection.range(LONG_1.from + 2, LONG_1.from + 9),
      }),
    });
  }

  const run = (view: EditorView, key: "ArrowUp" | "ArrowDown"): boolean =>
    lineVerticalKeymap.find((b) => b.key === key)!.run!(view);

  it("collapses forward to the selection's end, without moving a row", () => {
    const view = mount();
    expect(run(view, "ArrowDown")).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(LONG_1.from + 9);
    view.destroy();
  });

  it("collapses backward to the selection's start", () => {
    const view = mount();
    expect(run(view, "ArrowUp")).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(LONG_1.from + 2);
    view.destroy();
  });
});

describe("the bindings are actually mounted", () => {
  // Deleting `...lineVerticalKeymap` from `extensions.ts`, or
  // `lineVerticalExtension()` from the same array, left the ENTIRE suite green:
  // every test above imports the two directly and none of them calls
  // `myneExtensions()`. The goal field is the worse half, because it degrades
  // silently: `state.field(verticalGoalField, false) ?? null` just yields a
  // non-sticky column, so the arrows go on working and only the property this
  // module was written for is gone. A correct command bound to nothing is the
  // shape nothing reports, and the sibling module carries the same test for the
  // same reason (`lineBoundarySmartHome.test.ts`, "the chords are actually
  // bound").

  it("binds ArrowUp and ArrowDown, with a shift variant on each", () => {
    const keys = lineVerticalKeymap.map((b) => b.key);
    expect(keys).toContain("ArrowUp");
    expect(keys).toContain("ArrowDown");
    for (const key of ["ArrowUp", "ArrowDown"]) {
      const binding = lineVerticalKeymap.find((b) => b.key === key);
      expect(binding?.run, `${key} has no run`).toBeTypeOf("function");
      expect(binding?.shift, `${key} has no shift variant`).toBeTypeOf("function");
    }
  });

  it("reaches the arrows through the real extension list", () => {
    // Resolved the way CodeMirror resolves them: build the whole editor and ask
    // the keymap facet what answers ArrowDown. `defaultKeymap`'s `cursorLineDown`
    // is in that list too, so the assertion is that OURS is among them, which is
    // what the ordering in `extensions.ts` exists for.
    const state = EditorState.create({ doc: DOC, extensions: [...myneExtensions()] });
    const ours = lineVerticalKeymap.find((b) => b.key === "ArrowDown")!.run!;
    const bound = state
      .facet(keymap)
      .flat()
      .filter((b) => b.key === "ArrowDown")
      .map((b) => b.run);
    expect(bound).toContain(ours);
  });

  it("stays behind tableKeymap, which is a source-order contract nothing else holds", () => {
    // `extensions.ts` pins the position in a comment ("AFTER tableKeymap, so
    // arrowing into a read-only table still wins") and both are entries of one
    // `keymap.of([...])` array, so source order IS the mechanism. The test above
    // asserts only that ours is among the bindings, which stays true after a
    // reorder, so the contract had nothing holding it: moving our entry up would
    // break table entry with the whole suite green.
    const state = EditorState.create({ doc: DOC, extensions: [...myneExtensions()] });
    const bound = state
      .facet(keymap)
      .flat()
      .filter((b) => b.key === "ArrowDown")
      .map((b) => b.run);
    const ours = bound.indexOf(lineVerticalKeymap.find((b) => b.key === "ArrowDown")!.run!);
    const table = bound.indexOf(tableKeymap.find((b) => b.key === "ArrowDown")!.run!);
    expect(table, "tableKeymap binds ArrowDown").toBeGreaterThanOrEqual(0);
    expect(ours, "lineVerticalKeymap binds ArrowDown").toBeGreaterThanOrEqual(0);
    expect(table, "tableKeymap must be asked first").toBeLessThan(ours);
  });

  it("installs the goal field, proven by storing a goal and reading it back", () => {
    // NOT `expect(verticalGoalOf(state)).toBeNull()`, which was the first
    // version of this and passed with the field deleted: the accessor collapses
    // "no field" and "field holding no goal" to the same `null`, so it asserts
    // nothing. Storing a value and reading it back is the state assertion the
    // presence check only looked like. Deleting `lineVerticalExtension()` from
    // the extension list fails here and nowhere else.
    const state = EditorState.create({ doc: DOC, extensions: [...myneExtensions()] });
    const view = new EditorView({ state, parent: document.body });
    try {
      view.dispatch({ effects: setVerticalGoalForTest.of([7]) });
      expect(verticalGoalOf(view.state)).toEqual([7]);
    } finally {
      view.destroy();
    }
  });

  it("keeps the goal across our own move and drops it on anything else", () => {
    // The field's own update branches. Replacing its body with `return null`
    // failed nothing before this: no test read a goal back out of a real state.
    const state = EditorState.create({
      doc: DOC,
      extensions: [lineVerticalExtension()],
      selection: EditorSelection.cursor(LONG_1.from + 3),
    });
    const view = new EditorView({ state, parent: document.body });
    try {
      view.dispatch({ effects: setVerticalGoalForTest.of([7]) });
      expect(verticalGoalOf(view.state)).toEqual([7]);

      // A foreign selection move is the user choosing a new column.
      view.dispatch({ selection: EditorSelection.cursor(LONG_1.from + 1) });
      expect(verticalGoalOf(view.state)).toBeNull();

      // And an edit changes what a column means.
      view.dispatch({ effects: setVerticalGoalForTest.of([7]) });
      view.dispatch({ changes: { from: 0, insert: "x" } });
      expect(verticalGoalOf(view.state)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
