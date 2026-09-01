// @vitest-environment jsdom
//
// The caret never sits on the frontmatter Properties block (myne-md/myne#595,
// re-opening #209 / MYND-608 for the two arrival paths its fix did not cover).
//
// Every assertion here reads `assoc` as well as `head`, deliberately. The offset
// was already correct in both broken paths: what was wrong was the association,
// which is what `coordsAtPos` resolves the position through, so a suite that
// asserts only on `head` passes while the caret is painted at the block's right
// edge. jsdom has no layout and cannot measure that paint; the association is
// the fact that decides it.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  cursorCharRight,
  cursorLineUp,
  deleteCharBackward,
} from "@codemirror/commands";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";
import { CMEditor } from "../../editor/src/CMEditor";
import "./_conformance";

// `<CMEditor>` mounts the full `myneExtensions()` stack, five of whose lazy
// loaders end in an async dispatch that can land mid-update in jsdom. Importing
// the conformance harness for its side effects stubs all five at module scope,
// the same set this file used to copy, in the module that owns the list.

afterEach(cleanup);

const DOC =
  "---\ntitle: 1 Eylul\nfolder: 00 - INBOX/\n---\nfirst body line\nsecond line\n";
const FLOOR = DOC.indexOf("first body line");

let view: EditorView | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

/** A view over `doc` with the frontmatter extension only, caret at `anchor`. */
function mountDoc(doc: string, anchor = 0): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [frontmatterDecorations()],
    }),
    parent: host,
  });
  return view;
}

/** The same, over the shared `DOC`. */
const mount = (anchor: number): EditorView => mountDoc(DOC, anchor);

/** A rendered `<CMEditor>` over `value`, and the live view it handed back. */
function renderEditor(value: string): EditorView {
  let live: EditorView | null = null;
  render(
    <CMEditor
      noteId={null}
      value={value}
      onChange={() => {}}
      onReady={(v) => {
        live = v;
      }}
    />,
  );
  const editor = live as EditorView | null;
  if (editor === null)
    throw new Error("onReady should hand back the live view");
  return editor;
}

/** `head` and `assoc` of the main range, the pair that decides where CM paints. */
function caret(v: EditorView): { head: number; assoc: number } {
  const main = v.state.selection.main;
  return { head: main.head, assoc: main.assoc };
}

describe("the floor is measured on the document, not on the string", () => {
  it("mounts a note whose frontmatter carries CRLF line endings", () => {
    // CodeMirror drops every `\r` while building the document, so a floor
    // measured on the source string is too large by exactly that count. It does
    // not degrade: an offset past the end makes `EditorState.create` throw, the
    // editor never mounts, and its pane sits on "Loading…" forever. Two shapes
    // reach it, and this is the shortest.
    const crlf = "---\ntitle: x\r\n---";
    const v = renderEditor(crlf);
    expect(v).not.toBeNull();
    // Mounted at all is the assertion; the caret is inside the document.
    expect(v!.state.selection.main.head).toBeLessThanOrEqual(
      v!.state.doc.length,
    );
  });

  it("puts the caret on the body floor of a frontmatter-only note", () => {
    // Its body is the single empty line at the end, and the floor is that
    // line's offset, the document's length. The block stops one character
    // short of it, so the line is there to hold the caret.
    const only = "---\ntitle: x\n---\n";
    const v = renderEditor(only);
    expect(caret(v!)).toEqual({ head: only.length, assoc: 1 });
  });
});

describe("an empty first body line is rendered at all", () => {
  const lines = (v: EditorView): string[] =>
    Array.from(v.dom.querySelectorAll(".cm-line")).map(
      (l) => (l as HTMLElement).textContent ?? "",
    );

  it("gives a blank line under the block its own `.cm-line`", () => {
    // jsdom has no layout, so the PAINT cannot be asserted here. This is what
    // decides it: `coordsAtPos` measures the line the caret is on, and a block
    // replace that ran to the next line's start left that line UNRENDERED, so
    // the lookup fell back to the Properties block's own box.
    expect(lines(mountDoc("---\ntitle: x\n---\n\n# Heading\n"))).toEqual([
      "",
      "# Heading",
      "",
    ]);
  });

  it("renders a body that starts with text exactly as before", () => {
    expect(lines(mountDoc("---\ntitle: x\n---\nbody\n"))).toEqual(["body", ""]);
  });

  it("keeps the final empty line of a frontmatter-only note", () => {
    expect(lines(mountDoc("---\ntitle: x\n---\n"))).toEqual([""]);
  });

  it("leaves no stray source line when the block has no trailing newline", () => {
    // Stopping one character short unconditionally would leave the closing
    // `---`'s last dash outside the widget, painted as a line of raw source.
    expect(lines(mountDoc("---\ntitle: x\n---"))).toEqual([]);
  });
});

describe("a caret that arrives at the boundary associates forward", () => {
  it("after one ArrowRight out of the block", () => {
    const v = mount(0);
    cursorCharRight(v);
    expect(caret(v)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("after Backspace back to the start of the first body line", () => {
    const v = mount(FLOOR + 1);
    deleteCharBackward(v);
    expect(caret(v)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("after a click on the first body offset", () => {
    const v = mount(FLOOR + 4);
    v.dispatch({ selection: { anchor: FLOOR } });
    expect(caret(v)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("after ArrowUp from the second body line", () => {
    const v = mount(DOC.indexOf("second line"));
    cursorLineUp(v);
    expect(caret(v)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("and a selection aimed INTO the block is still clamped out of it", () => {
    const v = mount(FLOOR);
    v.dispatch({ selection: { anchor: 2, head: 2 } });
    expect(caret(v)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("without re-filtering itself into a loop", () => {
    // The guard appends a second transaction, which runs through the guard in
    // turn. A caret already at the boundary with assoc 1 must be returned
    // untouched, or that second pass appends a third.
    let transactions = 0;
    const counted = new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: EditorSelection.create([
          EditorSelection.cursor(FLOOR + 1, 1),
        ]),
        extensions: [
          frontmatterDecorations(),
          EditorState.transactionExtender.of(() => {
            transactions += 1;
            return null;
          }),
        ],
      }),
    });
    counted.dispatch({ selection: { anchor: 0 } });
    expect(caret(counted)).toEqual({ head: FLOOR, assoc: 1 });
    // One dispatched transaction plus the guard's own repair, and nothing more.
    expect(transactions).toBeLessThanOrEqual(2);
    counted.destroy();
  });
});

describe("the caret does not open inside the block", () => {
  it("puts a freshly mounted editor's caret on the first body offset", () => {
    // The reported symptom: open a note, look at it, and the caret is drawn on
    // the Properties panel. Nothing had moved it because nothing had dispatched
    // a transaction: the guard is a transactionFilter and a state's initial
    // selection is not one.
    const v = renderEditor(DOC);
    expect(v).not.toBeNull();
    expect(caret(v!)).toEqual({ head: FLOOR, assoc: 1 });
  });

  it("leaves a note with no frontmatter at offset 0", () => {
    let live: EditorView | null = null;
    render(
      <CMEditor
        noteId={null}
        value={"just a body\n"}
        onChange={() => {}}
        onReady={(v) => {
          live = v;
        }}
      />,
    );
    const v = live as EditorView | null;
    expect(v!.state.selection.main.head).toBe(0);
  });
});
