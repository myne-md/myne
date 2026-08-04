// @vitest-environment jsdom
//
// Scroll slack past the last line (#375). Covers the two pure pieces the
// extension is built from: which element is treated as the scroller, and how much
// slack a given viewport height earns. The plugin itself needs layout to do
// anything and jsdom has none — `clientHeight` is 0 there, so it computes 0 and
// stays inert, which is the correct jsdom behaviour rather than a gap.

import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { resolveScrollHost, slackFor } from "@myne/editor/scroll-slack";

/** `resolveScrollHost` reads exactly two fields, so a structural stand-in is the
 *  honest fixture — building a real view would test CM6, not the walk. */
function viewOver(dom: HTMLElement, scrollDOM: HTMLElement): EditorView {
  return { dom, scrollDOM } as unknown as EditorView;
}

/** editor `.cm-editor` inside `inner` inside `outer`, all under `document.body`. */
function tree(): { outer: HTMLElement; inner: HTMLElement; editor: HTMLElement; scroller: HTMLElement } {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  const editor = document.createElement("div");
  const scroller = document.createElement("div");
  editor.appendChild(scroller);
  inner.appendChild(editor);
  outer.appendChild(inner);
  document.body.appendChild(outer);
  return { outer, inner, editor, scroller };
}

describe("slackFor", () => {
  it("reserves 60% of the viewport below the cap", () => {
    expect(slackFor(600)).toBe(360);
  });

  it("clamps at the cap so a tall viewport can't reserve the world", () => {
    expect(slackFor(1600)).toBe(480);
    expect(slackFor(100_000)).toBe(480);
  });

  it("reserves nothing for a viewport that hasn't been measured", () => {
    // The jsdom / pre-layout case, and the guard that keeps a degenerate
    // measurement from writing a negative or NaN padding.
    expect(slackFor(0)).toBe(0);
    expect(slackFor(-40)).toBe(0);
    expect(slackFor(Number.NaN)).toBe(0);
    expect(slackFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("resolveScrollHost", () => {
  it("finds the nearest scrolling ancestor — the host pane, not the editor", () => {
    const { outer, editor, scroller } = tree();
    outer.style.overflowY = "auto";
    expect(resolveScrollHost(viewOver(editor, scroller))).toBe(outer);
  });

  it("prefers the NEAREST one when the layout nests two scrollers", () => {
    const { outer, inner, editor, scroller } = tree();
    outer.style.overflowY = "auto";
    inner.style.overflowY = "scroll";
    expect(resolveScrollHost(viewOver(editor, scroller))).toBe(inner);
  });

  it("walks past a clipping ancestor — `hidden` does not scroll", () => {
    const { outer, inner, editor, scroller } = tree();
    outer.style.overflowY = "auto";
    inner.style.overflowY = "hidden";
    expect(resolveScrollHost(viewOver(editor, scroller))).toBe(outer);
  });

  it("falls back to the editor's own scroller when no ancestor scrolls", () => {
    const { editor, scroller } = tree();
    expect(resolveScrollHost(viewOver(editor, scroller))).toBe(scroller);
  });
});
