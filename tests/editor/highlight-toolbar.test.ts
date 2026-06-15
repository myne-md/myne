// Highlight toolbar button wrap behavior (MYND-156, task 4). The floating
// toolbar DOM has no test runner; this verifies the underlying `==` wrap action
// the highlight button fires (`toggleWrap("==", "==")`).

import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { toggleWrap } from "../../src/editor/wrap-toggle";

function applyWrap(
  open: string,
  close: string,
  doc: string,
  from: number,
  to: number,
): string {
  let result = doc;
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
  });
  toggleWrap(open, close)({
    state,
    dispatch: (tr: Transaction) => {
      result = tr.state.doc.toString();
    },
  });
  return result;
}

function applyHighlightWrap(doc: string, from: number, to: number): string {
  return applyWrap("==", "==", doc, from, to);
}

describe("highlight toolbar wrap", () => {
  it("wraps the selected text in ==…==", () => {
    expect(applyHighlightWrap("make this pop", 5, 9)).toBe("make ==this== pop");
  });

  it("wraps a whole-line selection", () => {
    expect(applyHighlightWrap("important", 0, 9)).toBe("==important==");
  });
});

// Multi-color highlight (decisions.md 2026-06-15): the color swatches wrap the
// selection in `<mark class="hl-…">…</mark>` via the same `toggleWrap` helper.
describe("multi-color highlight wrap", () => {
  const GREEN_OPEN = '<mark class="hl-green">';
  const GREEN_CLOSE = "</mark>";

  it("wraps the selection in a colored <mark>", () => {
    expect(applyWrap(GREEN_OPEN, GREEN_CLOSE, "make this pop", 5, 9)).toBe(
      'make <mark class="hl-green">this</mark> pop',
    );
  });

  it("untoggles an exactly-selected colored <mark> span (idempotent)", () => {
    const wrapped = 'make <mark class="hl-green">this</mark> pop';
    // Select the full `<mark…>this</mark>` span (offsets 5..40) and re-apply.
    const markEnd = 5 + GREEN_OPEN.length + "this".length + GREEN_CLOSE.length;
    expect(applyWrap(GREEN_OPEN, GREEN_CLOSE, wrapped, 5, markEnd)).toBe(
      "make this pop",
    );
  });

  it("yellow swatch still emits ==…== (default, unchanged)", () => {
    expect(applyHighlightWrap("make this pop", 5, 9)).toBe("make ==this== pop");
  });
});
