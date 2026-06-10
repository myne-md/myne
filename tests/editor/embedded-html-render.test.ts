// @vitest-environment jsdom
//
// Inline embedded HTML rendering (MYND-209, task 2). Sanitized allowlisted
// elements render off-cursor; on* handlers stripped; HTML inside code stays
// literal; raw revealed on-cursor; byte-stable. The conformance harness stubs
// the sanitizer loader (never-resolve), so this test dispatches a real purifier.

import { afterEach, describe, expect, it } from "vitest";
import DOMPurify from "dompurify";
import { setPurifier } from "../../src/editor/decorations/embedded-html";
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
});
