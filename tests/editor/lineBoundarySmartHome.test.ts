// @vitest-environment jsdom
//
// myne-md/myne#561 + myne-md/myne#564: the BACKWARD line boundary on a list or
// task line, for movement and for deletion.
//
// On `- [ ] buy milk` the editor draws a checkbox and hides `- [ ] `, so the
// line the user sees begins at `buy`. Both chords used to target `line.from`,
// the raw offset: Cmd+Shift+← swept markup the user cannot see into the
// selection, and Cmd+Backspace deleted it outright.
//
// jsdom has no layout, so (as in `lineBoundary.test.ts`, whose stub this
// follows) the coordinate probe cannot be exercised here. The stub supplies a
// probe answer and a row midpoint; what is pinned is what the module does with
// them. The DOCUMENT is real, and parsed by the real markdown language, because
// `listContentStart` refuses to trust a text match on its own.

import { describe, expect, it, vi } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, RangeSet } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import {
  deleteToLineBoundary,
  lineBoundaryKeymap,
  listContentStart,
  verifiedLineBoundary,
} from "@myne/editor/line-boundary";

function mdState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
}

/**
 * A view stub over a REAL markdown-parsed state. `moveToLineBoundary` answers
 * `probe`; `coordsAtPos` answers `null` for every offset, which is the
 * "unmeasurable" path, so the verification accepts the probe untouched and
 * every assertion below is about smart-home alone.
 */
function stubView(doc: string, probe: number, selection?: EditorSelection): EditorView {
  let state = mdState(doc);
  if (selection !== undefined) state = state.update({ selection }).state;
  const view = {
    get state() {
      return state;
    },
    moveToLineBoundary: vi.fn(() => EditorSelection.cursor(probe, 1)),
    coordsAtPos: () => null,
    dispatch: (tr: { state: EditorState }) => {
      state = tr.state;
    },
  };
  return view as unknown as EditorView;
}

// `- [ ] buy milk`: `- [ ] ` is 6 chars, so the label starts at 6.
const TASK = "- [ ] buy milk\n";
const CONTENT = 6;
const LINE_END = 14;

describe("listContentStart", () => {
  it("finds the label start on a task item", () => {
    expect(listContentStart(mdState(TASK), 10)).toBe(CONTENT);
  });

  it("finds it on a plain bullet and on an ordered item", () => {
    expect(listContentStart(mdState("- buy milk\n"), 5)).toBe(2);
    expect(listContentStart(mdState("1. buy milk\n"), 5)).toBe(3);
  });

  it("declines on a line that is not a list item", () => {
    expect(listContentStart(mdState("buy milk\n"), 4)).toBeNull();
  });

  it("declines on an EMPTY task item, because there is no label to protect", () => {
    // `- [ ] ` with nothing after it: the content start is the line end, and
    // pulling the caret there would make Cmd+← a no-op on that line.
    expect(listContentStart(mdState("- [ ] \n"), 6)).toBeNull();
  });

  it("declines inside a fenced code block, where a hyphen is literal text", () => {
    // The reason this reads the syntax tree instead of matching the line. A
    // caret pulled past a hyphen inside a fence would be a silent wrong answer
    // in the one place the editor promises the bytes are what they look like.
    const doc = "```\n- not a list\n```\n";
    expect(listContentStart(mdState(doc), 8)).toBeNull();
  });
});

describe("verifiedLineBoundary, backward, on a task line", () => {
  it("stops at the label start rather than sweeping the hidden markup", () => {
    const view = stubView(TASK, 0);
    const out = verifiedLineBoundary(view, EditorSelection.cursor(LINE_END), false);
    expect(out.head).toBe(CONTENT);
  });

  it("reaches the raw line start on the SECOND press", () => {
    // Smart-home must not make `line.from` unreachable.
    const view = stubView(TASK, 0);
    const out = verifiedLineBoundary(view, EditorSelection.cursor(CONTENT), false);
    expect(out.head).toBe(0);
  });

  it("extends past the label on the SECOND press of a shift-extended selection", () => {
    // The reported hard stop. After the first Cmd+Shift+← the head sits at the
    // label start; the second press must reach `line.from` so the marker can be
    // taken too. The range is non-empty here, which is what a shift-extension
    // looks like; the earlier case only covered a bare caret.
    const view = stubView(TASK, 0);
    const extended = EditorSelection.range(LINE_END, CONTENT);
    const out = verifiedLineBoundary(view, extended, false);
    expect(out.head).toBe(0);
  });

  it("leaves a probe that already landed inside the label alone", () => {
    // A soft-wrap point mid-label is a real destination and is not a bug.
    const view = stubView(TASK, 10);
    const out = verifiedLineBoundary(view, EditorSelection.cursor(LINE_END), false);
    expect(out.head).toBe(10);
  });

  it("does not touch a plain prose line", () => {
    const view = stubView("buy milk\n", 0);
    const out = verifiedLineBoundary(view, EditorSelection.cursor(8), false);
    expect(out.head).toBe(0);
  });

  it("does not touch the FORWARD direction", () => {
    // End of line is end of line on every kind of line.
    const view = stubView(TASK, LINE_END);
    const out = verifiedLineBoundary(view, EditorSelection.cursor(CONTENT), true);
    expect(out.head).toBe(LINE_END);
  });
});

describe("deleteToLineBoundary, backward, on a task line", () => {
  it("takes ONE character when the probe had to be replaced", () => {
    // The movement chords accept the logical line edge when the coordinate probe
    // misses: a wrong caret costs one keystroke. A delete may not, because on a
    // soft-wrapped paragraph that edge is the far end of the PARAGRAPH, and this
    // file's own header says the probe misses routinely in this app.
    //
    // The stub reports two different row midpoints, which is what a replaced
    // probe looks like from inside `probeLineBoundary`.
    let state = mdState("- [ ] buy milk\n").update({
      selection: EditorSelection.cursor(LINE_END),
    }).state;
    const view = {
      get state() {
        return state;
      },
      moveToLineBoundary: () => EditorSelection.cursor(0, 1),
      coordsAtPos: (pos: number) =>
        pos === LINE_END
          ? { top: 100, bottom: 118, left: 0, right: 0 }
          : { top: 140, bottom: 158, left: 0, right: 0 },
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state;
      },
    } as unknown as EditorView;

    expect(deleteToLineBoundary(view, false)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [ ] buy mil\n");
  });

  it("takes two presses to clear a task line, not one", () => {
    // The reported behaviour was one press eating `- [ ] label` whole. First
    // press stops at the label; second takes the marker.
    const view = stubView(TASK, 0, EditorSelection.single(LINE_END));

    expect(deleteToLineBoundary(view, false)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [ ] \n");

    expect(deleteToLineBoundary(view, false)).toBe(true);
    expect(view.state.doc.toString()).toBe("\n");
  });

  it("joins with the previous line once the caret is at the raw start", () => {
    // The library's own at-the-boundary fallback, preserved: a repeated
    // Cmd+Backspace must keep making progress rather than becoming a no-op.
    const view = stubView("first\n- [ ] a\n", 6, EditorSelection.single(6));
    expect(deleteToLineBoundary(view, false)).toBe(true);
    expect(view.state.doc.toString()).toBe("first- [ ] a\n");
  });
});

describe("atomic ranges are not cut in half", () => {
  it("stops the delete at an atomic range's edge", () => {
    // `skipAtomic` had no test: replacing its body with `return pos` left the
    // whole suite green. Its own docstring names what that costs, and it is not
    // cosmetic: "a boundary that lands INSIDE an atomic range (a table widget, a
    // task chip, a tag pill) must be pushed to that range's edge, or the delete
    // cuts a construct in half and leaves unparseable source behind."
    //
    // `- [ ] a [due:: 2026-01-01] b`: the chip spans 8..26, and the probe lands
    // at 15, inside it. That is the real case the docstring names, a coordinate
    // probe resolving mid-widget, and the delete must be pushed out to the
    // chip's edge (8) rather than cutting it at 15 and leaving `[due:: 20` behind.
    const doc = "- [ ] a [due:: 2026-01-01] b\n";
    const atomic = EditorView.atomicRanges.of(() =>
      RangeSet.of([{ from: 8, to: 26, value: Decoration.mark({}) }]),
    );
    let state = EditorState.create({
      doc,
      selection: EditorSelection.cursor(28),
      extensions: [markdown({ base: markdownLanguage }), atomic],
    });
    const view = {
      get state() {
        return state;
      },
      moveToLineBoundary: () => EditorSelection.cursor(15, 1),
      coordsAtPos: () => null,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state;
      },
    } as unknown as EditorView;

    expect(deleteToLineBoundary(view, false)).toBe(true);
    // Everything from the chip's start is gone; the chip itself is intact-or-gone
    // rather than sliced, so what remains ends at offset 8.
    expect(state.doc.toString()).toBe("- [ ] a \n");
  });
});

describe("the chords are actually bound", () => {
  it("binds Cmd+Backspace and Cmd+Delete to the verified deletes", () => {
    // Both entries were deleted from `lineBoundaryKeymap` during review and the
    // suite stayed green: every test here calls the command directly, and the
    // bindings are `mac:`-only so the Linux E2E lane cannot reach them either.
    // A correct command bound to nothing is the shape nothing reports.
    const chords = lineBoundaryKeymap.map((b) => b.mac);
    expect(chords).toContain("Cmd-Backspace");
    expect(chords).toContain("Cmd-Delete");
    for (const key of ["Cmd-Backspace", "Cmd-Delete"]) {
      const binding = lineBoundaryKeymap.find((b) => b.mac === key);
      expect(binding?.run, `${key} has no run`).toBeTypeOf("function");
      expect(binding?.preventDefault, `${key} must swallow the browser default`).toBe(true);
    }
  });

  it("still binds the two movement chords it shares a file with", () => {
    const chords = lineBoundaryKeymap.map((b) => b.mac);
    expect(chords).toContain("Cmd-ArrowLeft");
    expect(chords).toContain("Cmd-ArrowRight");
  });
});
