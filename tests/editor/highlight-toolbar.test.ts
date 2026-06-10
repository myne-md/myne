// Highlight toolbar button wrap behavior (MYND-156, task 4). The floating
// toolbar DOM has no test runner; this verifies the underlying `==` wrap action
// the highlight button fires (`toggleWrap("==", "==")`).

import { describe, expect, it } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { toggleWrap } from "../../src/editor/wrap-toggle";

function applyHighlightWrap(doc: string, from: number, to: number): string {
  let result = doc;
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
  });
  toggleWrap("==", "==")({
    state,
    dispatch: (tr: Transaction) => {
      result = tr.state.doc.toString();
    },
  });
  return result;
}

describe("highlight toolbar wrap", () => {
  it("wraps the selected text in ==…==", () => {
    expect(applyHighlightWrap("make this pop", 5, 9)).toBe("make ==this== pop");
  });

  it("wraps a whole-line selection", () => {
    expect(applyHighlightWrap("important", 0, 9)).toBe("==important==");
  });
});
