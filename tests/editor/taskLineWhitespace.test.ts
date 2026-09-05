// @vitest-environment jsdom
//
// myne-md/myne#657, a trailing space was in the document and not in live view.
//
// `hard-break.ts` hides the trailing markers of a `HardBreak` off-cursor (two or
// more trailing spaces, or a trailing `\`). That is right for prose, where the
// rendered break is the signal and two invisible spaces are noise. Inside a list
// item it reads as the editor eating a keystroke.
//
// These assert the RENDERED TEXT, not the source of the guard. The first version
// of this file grepped `hard-break.ts` for the literal `if (isTaskLine(...))`,
// which pinned one spelling, so the correction from `isTaskLine` to
// `isListItemLine` (the parser only emits a HardBreak on a list line when the
// item has a continuation, at which point a plain bullet has the identical
// problem) would have failed a test for a reason unrelated to behaviour, and
// deleting the guard's effect while keeping its text would have left it green.
//
// `Decoration.replace({})` removes the range from `contentDOM.textContent`, so
// "the spaces are still on screen" is directly observable.

import { afterEach, describe, expect, it } from "vitest";
import { focusAt, mount, type Mounted, teardown } from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

/** The editor's rendered text with the caret parked far from `interest`. */
function renderedAway(doc: string): string {
  m = mount(doc);
  focusAt(m, doc.length); // last line, so the line under test is off-cursor
  return m.view.contentDOM.textContent ?? "";
}

describe("a list item keeps its trailing spaces on screen", () => {
  // A HardBreak only exists on a list line when the item has a CONTINUATION
  // line: measured against @lezer/markdown, and the reason the predicate is
  // about list items rather than about task rows.
  it("keeps them on a task item", () => {
    const text = renderedAway("- [ ] label  \n  more\n\ntail\n");
    expect(text).toContain("label  ");
  });

  it("keeps them on a plain bullet item, which the first fix missed", () => {
    const text = renderedAway("- label  \n  more\n\ntail\n");
    expect(text).toContain("label  ");
  });

  it("keeps them on an ordered item", () => {
    const text = renderedAway("1. label  \n   more\n\ntail\n");
    expect(text).toContain("label  ");
  });

  // The other direction. MYND-208 hides these in prose deliberately, and a fix
  // that quietly reversed that would pass every case above.
  it("still hides them in a paragraph", () => {
    const text = renderedAway("paragraph  \nsecond line\n\ntail\n");
    expect(text).not.toContain("paragraph  ");
    expect(text).toContain("paragraph");
  });

  // And the cursor rule is untouched: the markers reveal on the caret's line
  // wherever they are, which is what makes them editable.
  it("reveals them in a paragraph while the caret is on that line", () => {
    m = mount("paragraph  \nsecond line\n");
    focusAt(m, 3);
    expect(m.view.contentDOM.textContent ?? "").toContain("paragraph  ");
  });
});
