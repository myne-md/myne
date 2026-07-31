// @vitest-environment jsdom
//
// Caret-aware highlight editing (MYND-637). The toolbar's highlight control
// detects the highlight ENCLOSING the selection and rewrites it in place —
// recolour, yellow↔colour swap, or remove — keeping the inner text and leaving
// storage as the settled `<mark class="hl-*">` / `==` bytes (MYND-285). Tests the
// two pure pieces the control wires up: `detectEnclosingHighlight` (state-only)
// and `applyHighlightEdit` (dispatches the rewrite).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  applyHighlightEdit,
  detectEnclosingHighlight,
} from "@myne/editor/toolbar/highlight-edit";

const OPEN = (c: string): string => `<mark class="${c}">`;

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

/** Build a live view over `doc` with the selection at `[from, to]`, run
 *  `applyHighlightEdit` on the detected enclosing highlight, and return the
 *  resulting document bytes. */
function rewrite(doc: string, from: number, to: number, target: string): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: from, head: to } }),
    parent: host,
  });
  const enc = detectEnclosingHighlight(view.state, from, to);
  if (enc === null) throw new Error("no enclosing highlight detected");
  applyHighlightEdit(view, enc, target);
  return view.state.doc.toString();
}

describe("detectEnclosingHighlight", () => {
  const doc = `make ${OPEN("hl-blue")}this</mark> pop`;
  const innerFrom = doc.indexOf("this");
  const innerTo = innerFrom + "this".length;

  it("detects a colored <mark> enclosing the selection", () => {
    const enc = detectEnclosingHighlight(
      EditorState.create({ doc }),
      innerFrom,
      innerTo,
    );
    expect(enc).not.toBeNull();
    expect(enc!.kind).toBe("mark");
    expect(enc!.color).toBe("hl-blue");
    expect(doc.slice(enc!.innerFrom, enc!.innerTo)).toBe("this");
  });

  it("detects a yellow == highlight enclosing the selection", () => {
    const y = "make ==this== pop";
    const enc = detectEnclosingHighlight(EditorState.create({ doc: y }), 7, 11);
    expect(enc!.kind).toBe("eq");
    expect(enc!.color).toBe("hl-yellow");
    expect(y.slice(enc!.innerFrom, enc!.innerTo)).toBe("this");
  });

  it("returns null when the selection is not inside any highlight", () => {
    const plain = "make this pop";
    expect(detectEnclosingHighlight(EditorState.create({ doc: plain }), 5, 9)).toBeNull();
  });

  it("returns null when the selection spans lines", () => {
    const multi = `${OPEN("hl-blue")}a\nb</mark>`;
    expect(detectEnclosingHighlight(EditorState.create({ doc: multi }), 22, 25)).toBeNull();
  });
});

describe("applyHighlightEdit", () => {
  const colored = `make ${OPEN("hl-blue")}this</mark> pop`;
  const cInner = colored.indexOf("this");
  const yellow = "make ==this== pop";

  it("recolours a colored highlight, keeping <mark> storage", () => {
    const out = rewrite(colored, cInner, cInner + 4, "hl-green");
    expect(out).toBe(`make ${OPEN("hl-green")}this</mark> pop`);
  });

  it("swaps yellow → colour (== becomes <mark>)", () => {
    const out = rewrite(yellow, 7, 11, "hl-blue");
    expect(out).toBe(`make ${OPEN("hl-blue")}this</mark> pop`);
  });

  it("swaps colour → yellow (<mark> becomes ==)", () => {
    const out = rewrite(colored, cInner, cInner + 4, "hl-yellow");
    expect(out).toBe("make ==this== pop");
  });

  it("removes a colored highlight when the active colour is chosen (toggle off)", () => {
    const out = rewrite(colored, cInner, cInner + 4, "hl-blue");
    expect(out).toBe("make this pop");
  });

  it("removes a yellow highlight when yellow is chosen", () => {
    const out = rewrite(yellow, 7, 11, "hl-yellow");
    expect(out).toBe("make this pop");
  });
});
