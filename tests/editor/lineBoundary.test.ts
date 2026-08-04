// @vitest-environment jsdom
//
// myne#286 — Cmd+→ / Cmd+← must stay on the row the caret is on.
//
// CodeMirror's `cursorLineBoundaryRight` is a coordinate probe against
// `view.dom.getBoundingClientRect().right - 1`. `view.dom` is `.cm-editor`,
// which sits inside a centred max-width column, so that x lands in `.cm-line`'s
// right padding — or on a classic scrollbar — and a caret-from-point outside the
// text box is exactly where WebKit resolves to the FOLLOWING line.
//
// jsdom has no layout, so the probe itself cannot be exercised here. What can be
// pinned — and what the fix actually is — is the VERIFICATION: given a probe
// answer, is it accepted or replaced?

import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { verifiedLineBoundary } from "@myne/editor/line-boundary";

const DOC = "first line here\nsecond line here\n";

/**
 * A view stub carrying only what `verifiedLineBoundary` reads: the state, the
 * probe answer, and a row-midpoint per offset.
 */
function stubView(opts: {
  probe: number;
  rows: Record<number, number | null>;
}): EditorView {
  const state = EditorState.create({ doc: DOC });
  return {
    state,
    moveToLineBoundary: vi.fn(() => EditorSelection.cursor(opts.probe, -1)),
    coordsAtPos: (pos: number) => {
      const y = opts.rows[pos];
      return y === null || y === undefined ? null : { top: y, bottom: y + 18, left: 0, right: 0 };
    },
  } as unknown as EditorView;
}

const LINE1 = { from: 0, to: 15 };
const LINE2 = { from: 16, to: 32 };

describe("verifiedLineBoundary", () => {
  it("accepts a probe that stays on the caret's row", () => {
    const view = stubView({ probe: LINE1.to, rows: { 5: 100, [LINE1.to]: 100 } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(5), true);
    expect(out.head).toBe(LINE1.to);
  });

  it("accepts a wrap-point probe, which renders on the caret's row", () => {
    // The case the verification must NOT break: on a soft-wrapped paragraph the
    // visual boundary is a real destination, and `assoc = -1` renders it at the
    // end of the current row.
    const view = stubView({ probe: 8, rows: { 3: 100, 8: 100 } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(3), true);
    expect(out.head).toBe(8);
  });

  it("replaces a probe that dropped a row with the logical line end", () => {
    // The reported symptom: the caret appears at the start of the following
    // line instead of the end of the current one.
    const view = stubView({ probe: LINE2.from, rows: { 5: 100, [LINE2.from]: 122 } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(5), true);
    expect(out.head).toBe(LINE1.to);
    expect(out.assoc).toBe(-1);
  });

  it("mirrors for the backward direction", () => {
    const view = stubView({ probe: LINE1.to, rows: { 20: 122, [LINE1.to]: 100 } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(20), false);
    expect(out.head).toBe(LINE2.from);
    expect(out.assoc).toBe(1);
  });

  it("trusts the probe when the view cannot be measured", () => {
    // A detached view, a line scrolled out of the viewport, or a test DOM: an
    // unverifiable answer is not evidence of a wrong one.
    const view = stubView({ probe: LINE2.from, rows: { 5: null, [LINE2.from]: null } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(5), true);
    expect(out.head).toBe(LINE2.from);
  });

  it("tolerates sub-pixel differences within a row", () => {
    const view = stubView({ probe: LINE1.to, rows: { 5: 100, [LINE1.to]: 100.6 } });
    const out = verifiedLineBoundary(view, EditorSelection.cursor(5), true);
    expect(out.head).toBe(LINE1.to);
  });
});
