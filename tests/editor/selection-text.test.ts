// Selection seam (MYND-339): `selectedRangesText` projects an EditorState's
// selection to the text the document-statistics readout measures.

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { selectedRangesText } from "../../src/editor/selectionText";

describe("selectedRangesText", () => {
  it("empty selection → ''", () => {
    const s = EditorState.create({ doc: "hello", selection: { anchor: 2, head: 2 } });
    expect(selectedRangesText(s)).toBe("");
  });

  it("single non-empty range → the substring", () => {
    const s = EditorState.create({ doc: "hello world", selection: { anchor: 0, head: 5 } });
    expect(selectedRangesText(s)).toBe("hello");
  });

  it("multiple ranges → joined by newline", () => {
    const s = EditorState.create({
      doc: "abcdef",
      selection: EditorSelection.create([
        EditorSelection.range(0, 2),
        EditorSelection.range(4, 6),
      ]),
      // CM6 collapses to the main range unless multi-selection is allowed.
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    expect(selectedRangesText(s)).toBe("ab\nef");
  });
});
