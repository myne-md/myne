// @vitest-environment jsdom
//
// What the caret measures beside a widget (myne-md/myne#1062).
//
// The mechanism is CodeMirror's, and it is one line of its source:
//
//     coordsInWidget(pos, side, block) {
//       let custom = this.widget.coordsAt(this.dom, pos, side);
//       if (custom) return custom;
//       if (block) return flattenRect(this.dom.getBoundingClientRect(), …)
//
// So the widget's own box is what a position on it reports unless the widget
// answers first — which is why an image embed drew a caret several hundred
// pixels tall. jsdom computes no layout, so these specs stub the two rects the
// helper reads and assert the DECISION it makes from them: which edge, and how
// tall. The pixel truth was measured in a real browser and is recorded on the
// issue; what a test can hold is that the answer stops being the widget's box.

import { describe, expect, it } from "vitest";
import { lineHeightCoords } from "@myne/editor/widget-line-coords";

const rect = (top: number, height: number, left = 10, width = 40) =>
  ({ top, height, left, width, right: left + width, bottom: top + height }) as DOMRect;

/** A widget inside a line, with both boxes stubbed. */
function mount(widget: DOMRect, line: DOMRect | null): HTMLElement {
  const content = document.createElement("div");
  content.className = "cm-content";
  const holder = line === null ? content : document.createElement("div");
  if (line !== null) {
    holder.className = "cm-line";
    holder.getBoundingClientRect = () => line;
    content.appendChild(holder);
  }
  const dom = document.createElement("span");
  dom.className = "cm-attachment-frame";
  dom.getBoundingClientRect = () => widget;
  holder.appendChild(dom);
  return dom;
}

describe("lineHeightCoords", () => {
  it("reports a text-height caret on a widget taller than its line", () => {
    const dom = mount(rect(100, 400), rect(100, 24));
    expect(lineHeightCoords(dom, 1)).toEqual({ left: 50, right: 50, top: 100, bottom: 124 });
  });

  it("keeps a widget shorter than its line at the widget's own height", () => {
    const dom = mount(rect(100, 12), rect(100, 24));
    expect(lineHeightCoords(dom, 1)?.bottom).toBe(112);
  });

  it("stands on the left edge before the widget and the right edge after it", () => {
    const dom = mount(rect(100, 400), rect(100, 24));
    expect(lineHeightCoords(dom, -1)?.left).toBe(10);
    expect(lineHeightCoords(dom, 1)?.left).toBe(50);
  });
  it("answers null for a widget that has never been laid out", () => {
    // A zero rect is the pre-measure state, and a caret drawn from it would sit
    // at the editor's top-left corner rather than on the widget.
    const dom = mount(rect(0, 0, 0, 0), rect(0, 0));
    expect(lineHeightCoords(dom, 1)).toBeNull();
  });

  it("keeps a block widget's caret at its own start, whichever side asked", () => {
    // A block widget owns its whole line, so its frame is as wide as the column;
    // answering with the right edge would put the caret at the far end of the
    // editor rather than on the line the block is on. It has no line ancestor
    // to borrow a height from either, so the inherited text metric is the only
    // source for one — stubbed here, because jsdom resolves no cascade.
    const dom = mount(rect(80, 60), null);
    dom.style.lineHeight = "24px";
    expect(lineHeightCoords(dom, 1)?.left).toBe(10);
    expect(lineHeightCoords(dom, -1)?.left).toBe(10);
    expect(lineHeightCoords(dom, 1)?.bottom).toBe(104);
  });

  it("reports the widget's own box when no text metric is resolvable", () => {
    // The honest fallback: with neither a line nor a computed line-height there
    // is nothing to say the widget is taller than a line, so the old answer
    // stands rather than an invented one.
    const dom = mount(rect(80, 60), null);
    expect(lineHeightCoords(dom, 1)?.bottom).toBe(140);
  });
});
