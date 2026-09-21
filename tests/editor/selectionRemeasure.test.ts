// @vitest-environment jsdom
//
// myne-md/myne#660, the double highlight, third time filed.
//
// #210 removed the `::selection` rule and it reproduced. #560 rebuilt
// `.cm-task-add`'s vertical metrics and added `isCaretLine`, and it reproduced
// on two gestures neither covered: `Cmd+Shift+←` from a line end, and a
// double-click on a word mid-row.
//
// Three closed issues on one symptom is the argument for asserting the RULE
// rather than eyeballing a screenshot. The `.cm-task-add-slot` geometry half
// lives in `taskAddLineBox.test.ts`, next to the `block()` helper that reads
// that stylesheet correctly.
//
// # Why this suite drives the PLUGIN and not only the predicate
//
// Its first version asserted the predicate alone, and every case passed while
// the plugin achieved literally nothing: it asked for the second look with an
// empty `view.requestMeasure({ read: () => null })`, which never re-queues the
// selection layer, because `EditorView` calls `docViewUpdate()` only under
// `if (redrawn)`. A predicate test cannot see that, and neither can injecting
// the defect the predicate checks for, because the defect was in the half that
// ACTS rather than the half that decides. `AGENTS.md` names this shape: "a
// fixture that cannot hold the defective state is not a test".
//
// So the second describe below mounts a real `EditorView` and asserts the
// observable consequence: a second transaction arrives, carrying the same
// selection, on the frame after the gesture. That is the thing the layer needs,
// and it is false for the version that shipped.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  needsSelectionRemeasure,
  selectionRemeasure,
} from "../../editor/src/selection-remeasure";

describe("the rule: which updates can leave a stale rectangle pair", () => {
  const base = {
    selectionSet: false,
    hasNonEmptySelection: false,
    isRemeasureEcho: false,
  };

  // Both reported gestures arrive as a `selectionSet` that leaves a non-empty
  // range, alongside a layout change: the `+` leaving the line, or the
  // `- [ ] ` run becoming source. The predicate cannot distinguish them, which
  // is the point of taking a plain update shape, so they are one case rather
  // than two identical ones.
  it("fires for a selection change that left text selected", () => {
    expect(
      needsSelectionRemeasure({ ...base, selectionSet: true, hasNonEmptySelection: true }),
    ).toBe(true);
  });

  // The other direction, which is what keeps this from being a blanket
  // re-measure: `embedded-html.ts` carries an explicit "do NOT call
  // requestMeasure here" because a measure per update runs mid-scroll. A caret
  // paints no band, so there is nothing a stale pair could get wrong.
  it("does not fire on a plain caret move", () => {
    expect(needsSelectionRemeasure({ ...base, selectionSet: true })).toBe(false);
  });

  it("does not fire on scrolling with no selection change", () => {
    expect(needsSelectionRemeasure({ ...base, hasNonEmptySelection: true })).toBe(false);
  });

  // The recursion stop. Without it the re-dispatch satisfies both clauses above
  // and answers itself every frame, forever.
  it("does not fire on the echo of its own re-dispatch", () => {
    expect(
      needsSelectionRemeasure({
        ...base,
        selectionSet: true,
        hasNonEmptySelection: true,
        isRemeasureEcho: true,
      }),
    ).toBe(false);
  });

  it("does not fire on an update that changed nothing", () => {
    expect(needsSelectionRemeasure(base)).toBe(false);
  });
});

describe("the act: the layer actually gets a second look", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
    vi.restoreAllMocks();
  });

  /** Mount `doc` with the plugin installed, collecting every transaction the
   *  view sees, and hand back a way to run the animation frames it queues.
   *
   *  `drain` runs ROUNDS rather than a single callback, and that is not
   *  tidiness. The rAF queue is shared: `EditorView` schedules its own measure
   *  cycles through it, so popping one entry runs whichever of the two got there
   *  first, and the first version of this suite asserted against CM's frame
   *  while believing it had run the plugin's. Draining to a fixed point and
   *  asserting on the TRANSACTIONS is the only reading that does not depend on
   *  who queued what. The round cap is what turns a runaway re-dispatch into a
   *  failed assertion instead of a hung test. */
  function mount(doc: string): { seen: Transaction[]; drain: (rounds?: number) => void } {
    let frames: Array<() => void> = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(() => cb(0));
      return frames.length;
    });
    const seen: Transaction[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [selectionRemeasure()] }),
      parent: host,
      dispatchTransactions: (trs, v) => {
        for (const tr of trs) seen.push(tr);
        v.update(trs);
      },
    });
    return {
      seen,
      drain: (rounds = 4) => {
        for (let i = 0; i < rounds && frames.length > 0; i++) {
          const due = frames;
          frames = [];
          for (const run of due) run();
        }
      },
    };
  }

  it("re-dispatches the same selection on the next frame", () => {
    const { seen, drain } = mount("- [ ] a task row");
    view!.dispatch({ selection: { anchor: 6, head: 12 } });
    expect(seen, "nothing should land before a frame runs").toHaveLength(1);

    drain();

    // The observable consequence: a SECOND transaction, which is what makes
    // `selectionLayer.update` return true and re-queue its `measureReq`. This
    // is the assertion the shipped no-op version fails.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.selection, "must carry a selection, or the layer ignores it").toBeDefined();
    // Value-preserving: it must re-measure, never move what the user selected.
    expect(seen[1]!.newSelection.main.from).toBe(6);
    expect(seen[1]!.newSelection.main.to).toBe(12);
    expect(seen[1]!.docChanged).toBe(false);
  });

  it("does not walk onto the undo stack", () => {
    // A re-measure is not a user action. Without this the user's next
    // `undoSelection` steps onto a transaction they never made.
    const { seen, drain } = mount("- [ ] a task row");
    view!.dispatch({ selection: { anchor: 6, head: 12 } });
    drain();
    // `Transaction.addToHistory` is the annotation `history()` reads.
    expect(seen[1]!.annotation(Transaction.addToHistory)).toBe(false);
  });

  it("stops after one echo instead of dispatching every frame", () => {
    const { seen, drain } = mount("- [ ] a task row");
    view!.dispatch({ selection: { anchor: 6, head: 12 } });
    // Many rounds, deliberately: the echo is itself a `selectionSet` leaving a
    // non-empty range, so without the annotation guard every round adds one and
    // this count grows with the bound rather than settling.
    drain(20);
    expect(seen).toHaveLength(2);
  });

  it("asks for nothing on a plain caret move", () => {
    const { seen, drain } = mount("- [ ] a task row");
    view!.dispatch({ selection: { anchor: 6, head: 6 } });
    drain(20);
    expect(seen).toHaveLength(1);
  });
});
