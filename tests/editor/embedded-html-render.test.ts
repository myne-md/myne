// @vitest-environment jsdom
//
// Inline embedded HTML rendering (MYND-209, task 2). Sanitized allowlisted
// elements render off-cursor; on* handlers stripped; HTML inside code stays
// literal; raw revealed on-cursor; byte-stable. The conformance harness stubs
// the sanitizer loader (never-resolve), so this test dispatches a real purifier.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import { setPurifier } from "../../src/editor/decorations/embedded-html";
import {
  type Purifier,
  registerHighlightClassHook,
} from "../../src/editor/html/sanitize";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

// This harness injects the raw DOMPurify default (bypassing `loadPurifier`,
// which the conformance harness stubs to never-resolve), so the highlight-class
// hook isn't registered automatically — apply it here to the same instance so
// `<mark class="hl-*">` survives sanitization exactly as it does in production.
beforeAll(() => {
  registerHighlightClassHook(DOMPurify as unknown as Purifier);
});

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

function withPurifier(doc: string, pos?: number): Mounted {
  const mounted = mount(doc, pos);
  mounted.view.dispatch({
    effects: setPurifier.of(
      DOMPurify as unknown as Parameters<typeof setPurifier.of>[0],
    ),
  });
  mounted.view.requestMeasure();
  return mounted;
}

describe("inline embedded HTML", () => {
  it("renders <kbd> as a kbd element off-cursor", () => {
    m = withPurifier("press <kbd>Ctrl</kbd> now\n");
    expect(query(m, ".cm-embedded-html kbd")).not.toBeNull();
    expect(renderedText(m)).not.toContain("<kbd>");
  });

  it("renders <mark> and <abbr title>", () => {
    m = withPurifier('<mark>hi</mark> <abbr title="HyperText">A</abbr>\n');
    expect(query(m, ".cm-embedded-html mark")).not.toBeNull();
    expect(query(m, ".cm-embedded-html abbr")).not.toBeNull();
  });

  it("renders a colored <mark class='hl-green'> keeping the class", () => {
    m = withPurifier('<mark class="hl-green">pop</mark>\n');
    const mark = query(m, ".cm-embedded-html mark");
    expect(mark).not.toBeNull();
    expect(mark!.classList.contains("hl-green")).toBe(true);
  });

  it("drops an unknown highlight class, rendering a plain <mark>", () => {
    m = withPurifier('<mark class="hl-orange">pop</mark>\n');
    const mark = query(m, ".cm-embedded-html mark");
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute("class")).toBeNull();
  });

  it("strips an on* handler from the rendered HTML", () => {
    m = withPurifier('<kbd onclick="evil()">K</kbd>\n');
    const el = query(m, ".cm-embedded-html");
    expect(el).not.toBeNull();
    expect(el!.innerHTML).not.toContain("onclick");
  });

  it("leaves <kbd> inside a code fence literal", () => {
    m = withPurifier("```html\n<kbd>x</kbd>\n```\n");
    expect(query(m, ".cm-embedded-html")).toBeNull();
    expect(renderedText(m)).toContain("<kbd>x</kbd>");
  });

  it("reveals raw HTML on-cursor", () => {
    m = withPurifier("a <kbd>Z</kbd> b\n");
    focusAt(m, 4); // inside <kbd>
    expect(renderedText(m)).toContain("<kbd>Z</kbd>");
  });

  it("round-trips embedded HTML byte-identical", () => {
    const doc = "<kbd>Ctrl</kbd> <mark>m</mark> <sub>2</sub> <sup>2</sup>\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});

describe("block embedded HTML", () => {
  it("renders a <p> block off-cursor", () => {
    m = withPurifier("<p>A raw HTML paragraph.</p>\n");
    expect(query(m, ".cm-embedded-html-block p")).not.toBeNull();
  });

  it("renders an interactive <details>/<summary> block", () => {
    m = withPurifier(
      "<details><summary>Click to expand</summary>hidden</details>\n",
    );
    const details = query(m, ".cm-embedded-html-block details");
    expect(details).not.toBeNull();
    expect(query(m, ".cm-embedded-html-block summary")?.textContent).toBe(
      "Click to expand",
    );
  });

  it("round-trips a <details> block byte-identical (toggle state never touches the buffer)", () => {
    const doc = "<details><summary>S</summary>body</details>\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });

  it("keeps the block widget DOM when an edit above shifts it (identity is source-keyed)", () => {
    m = withPurifier("intro\n<p>Block content.</p>\n");
    const before = query(m, ".cm-embedded-html-block");
    expect(before).not.toBeNull();
    // An edit ABOVE the block shifts its position; the widget's eq must stay
    // true (source unchanged) so CM reuses the DOM instead of rebuilding it
    // once per keystroke.
    m.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(query(m, ".cm-embedded-html-block")).toBe(before);
  });

  it("click-to-edit targets the block's LIVE position after edits above", () => {
    m = withPurifier("intro\n<p>Block content.</p>\n");
    const block = query(m, ".cm-embedded-html-block") as HTMLElement;
    // Shift the block by editing above it — the reused DOM's handler must
    // resolve the current position, not one baked in at build time.
    m.view.dispatch({ changes: { from: 0, insert: "more " } });
    block.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    // The cursor must land at the block's CURRENT start (line start of "<p>"),
    // which is what drives the reveal once the editor is focused. (The reveal
    // itself is focus-gated behind a real DOM focus event — the private
    // setEditorFocus effect — which jsdom cannot deliver, so it is not
    // asserted here; a stale baked-in anchor would land on line 1 instead.)
    const blockStart = m.view.state.doc.toString().indexOf("<p>");
    expect(m.view.state.selection.main.anchor).toBe(blockStart);
  });
});
