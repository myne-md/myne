// `trimRowNewline`, the decision behind the triple-click row selection
// (myne-md/myne#560), tested as the pure function it is.
//
// Three lanes cover this behaviour and each covers a different step, which is
// worth stating because the division is what justifies the E2E:
//
//   - HERE: the decision. Given a range and a document, is this the gesture the
//     rule applies to, and what does it become? Every refusal branch and both
//     directions, with no view, no layout and no pointer. Three of the cases
//     below (the plain trim, the empty task row, the prose row) do restate the
//     mounted lane through a cheaper mechanism; the rest are reachable only
//     here, and the reverse direction is the reason the file exists.
//   - `taskLineEditing.test.ts`: the WIRING. A mounted CM6 view, a dispatched
//     `select.pointer` transaction, and the resulting selection and DOM.
//   - `e2e/task-row-selection.e2e.ts`: the GESTURE. Three real clicks, in a real
//     WebView, producing the transaction the other two assume.
//
// The reverse direction is the branch only this lane reaches: a drag that ends
// ABOVE where it started puts `anchor` after `head`, and the trim has to keep
// that orientation or the caret jumps to the other end of the row. Neither of
// the other two lanes produces it, because CM6's triple-click never does.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { trimRowNewline } from "@myne/editor/task-selection";

const DOC = "- [x] milk\nplain prose\n- [ ] \nlast\n";

function stateFor(doc = DOC): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  // Parse the WHOLE document before asserting, and the reason is a flake this
  // file produced on its second full-suite run. `syntaxTree(state)` returns
  // whatever the incremental parser finished inside its own time budget, which
  // on a fresh state under a loaded machine can stop short: `listMarkerEnd`
  // then finds no `TaskMarker` on the row and `trimRowNewline` correctly
  // declines, so the test fails on a real answer to a half-parsed document.
  // Passing alone and failing in the suite is the signature.
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

/** The shape the filter hands `trimRowNewline`, built from two offsets. */
function range(anchor: number, head: number) {
  return {
    anchor,
    head,
    from: Math.min(anchor, head),
    to: Math.max(anchor, head),
    empty: anchor === head,
  };
}

describe("trimRowNewline applies", () => {
  it("drops the trailing newline and keeps the whole row", () => {
    // `- [x] milk\n` is 0..11; CM6's triple-click selects to 11, the next line's
    // start. The row itself ends at 10. `anchor` staying 0 is the other half:
    // `- [x] ` is in the selection and on the clipboard, which is what the task
    // decoration then renders as source, so no band lands on the checkbox.
    expect(trimRowNewline(stateFor(), range(0, 11))).toEqual({ anchor: 0, head: 10 });
  });

  it("works on an EMPTY task row, where the marker IS the line", () => {
    // `- [ ] ` is 23..29, its break at 29. `listContentStart` answers null here,
    // which is why the rule is keyed off `listMarkerEnd` instead.
    expect(trimRowNewline(stateFor(), range(23, 30))).toEqual({ anchor: 23, head: 29 });
  });

  it("preserves a REVERSE selection's orientation", () => {
    // The branch neither other lane reaches. A drag upward leaves `anchor` after
    // `head`; flipping it here would move the caret to the other end of the row,
    // so the next keystroke lands at the wrong edge.
    const out = trimRowNewline(stateFor(), range(11, 0));
    expect(out).toEqual({ anchor: 10, head: 0 });
    expect(out!.anchor).toBeGreaterThan(out!.head);
  });
});

describe("trimRowNewline declines", () => {
  it("an empty range, which is a caret and not a selection", () => {
    // This pins the BEHAVIOUR and not the `range.empty` branch, and the
    // difference is worth writing down: removing that branch leaves this case
    // answered anyway. An empty range at `p` has `to === p`, and passing the
    // next test needs `p === lineAt(p).to + 1`, which no position inside its own
    // line can satisfy. So `range.empty` is unreachable-by-construction defence
    // rather than a live guard, and a test cannot distinguish it from its
    // successor. Injecting each of the other four branches DOES fail a named
    // case here; this one is stated as the exception.
    expect(trimRowNewline(stateFor(), range(3, 3))).toBeNull();
  });

  it("a selection that does not end exactly at the next line's start", () => {
    // Strictly `line.to + 1`. A selection ending anywhere else is not the
    // gesture this exists for, and trimming it would eat a character the user
    // selected.
    expect(trimRowNewline(stateFor(), range(0, 10))).toBeNull();
    expect(trimRowNewline(stateFor(), range(0, 12))).toBeNull();
  });

  it("a selection that does not start at the row's own start", () => {
    expect(trimRowNewline(stateFor(), range(2, 11))).toBeNull();
  });

  it("a plain prose row, which is drawn as no widget at all", () => {
    // `plain prose\n` is 11..23. The reasoning is about a row rendered as a
    // widget; trimming prose would change a standard gesture for nothing.
    expect(trimRowNewline(stateFor(), range(11, 23))).toBeNull();
  });

  it("the LAST row, which has no trailing break to trim", () => {
    // `last` with the document's final newline at 34. Guarded by the same
    // `range.to !== line.to + 1` test, and worth its own case because a document
    // without a trailing newline is the shape that would make it fire.
    const doc = "- [x] milk";
    expect(trimRowNewline(stateFor(doc), range(0, 10))).toBeNull();
  });
});
