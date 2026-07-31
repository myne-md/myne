// @vitest-environment jsdom
//
// Colored-highlight clean reveal (MYND-637). A colored highlight stored as
// `<mark class="hl-*">…</mark>` (MYND-285) must render like a yellow `==` one:
// off-cursor the tags are hidden and the inner text is painted; on-cursor it
// reveals a clean `==text==` SKIN — NEVER the raw `<mark>` HTML (the ticket's
// complaint #2). Mounted through the full production pipeline (`_conformance`),
// so a cross-decoration collision with embedded-html would surface here.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("colored-highlight clean reveal", () => {
  it("paints the inner text with its colour off-cursor, hiding the tags", () => {
    m = mount('<mark class="hl-blue">POP</mark>\n');
    const painted = query(m, ".cm-highlight.cm-hl-blue");
    expect(painted).not.toBeNull();
    expect(painted!.textContent).toBe("POP");
    // Neither the raw HTML nor a `==` skin shows while the caret is away.
    expect(renderedText(m)).not.toContain("<mark");
    expect(renderedText(m)).not.toContain("==");
  });

  it("reveals a clean ==text== skin on-cursor — never the raw <mark>", () => {
    const doc = 'a <mark class="hl-green">POP</mark> b\n';
    m = mount(doc);
    focusAt(m, doc.indexOf("POP") + 1); // caret inside the highlight
    expect(renderedText(m)).toContain("==POP==");
    expect(renderedText(m)).not.toContain("<mark");
  });

  it("does not route colored marks through the raw embedded-html widget", () => {
    // embedded-html's `.cm-embedded-html mark` would carry the raw-tag reveal;
    // the hl-* mark must be owned by colored-highlight instead.
    m = mount('<mark class="hl-pink">x</mark>\n');
    expect(query(m, ".cm-embedded-html mark.hl-pink")).toBeNull();
    expect(query(m, ".cm-highlight.cm-hl-pink")).not.toBeNull();
  });

  it("coexists with a yellow == highlight on the same line", () => {
    m = mount('==sun== and <mark class="hl-teal">sea</mark>\n');
    expect(query(m, ".cm-highlight.cm-hl-teal")).not.toBeNull();
    // The yellow one still renders via inline-typography (base .cm-highlight).
    expect(renderedText(m)).not.toContain("<mark");
  });

  it("leaves a colored mark inside a code fence literal (not painted)", () => {
    m = mount('```html\n<mark class="hl-red">x</mark>\n```\n');
    expect(query(m, ".cm-highlight.cm-hl-red")).toBeNull();
    expect(renderedText(m)).toContain('<mark class="hl-red">x</mark>');
  });

  it("round-trips a colored highlight byte-identical (render-only skin)", () => {
    const doc = 'a <mark class="hl-purple">note</mark> here\n';
    expect(roundTripBytes(doc)).toBe(doc);
  });

  it("ignores an empty colored highlight without crashing", () => {
    m = mount('<mark class="hl-blue"></mark>\n');
    expect(query(m, ".cm-highlight.cm-hl-blue")).toBeNull();
  });
});
