// @vitest-environment jsdom
//
// Horizontal-rule decoration must suppress itself on `---` lines that
// belong to a line-1-anchored YAML frontmatter block. Bug: @lezer/markdown
// has no frontmatter awareness — it sees the opening + closing `---` as
// HorizontalRule nodes. Without `locateFrontmatter` suppression, the
// hr-widget decoration competes with the frontmatter styled-block
// decoration, producing a visually broken "two-line sandwich" rendering.
//
// Test strategy: count HR widget DOM elements (`.cm-hr`) in the editor for
// a frontmatter doc vs. a standalone `---` doc. The frontmatter case must
// produce zero `.cm-hr` widgets; the standalone case must produce one.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { horizontalRuleDecorations } from "../../src/editor/decorations/horizontal-rule";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      // Park selection well outside any decorated range so cursor-aware
      // reveal doesn't suppress either decoration.
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [Wikilink],
        }),
        horizontalRuleDecorations(),
        frontmatterDecorations(),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("Horizontal-rule decoration vs. frontmatter suppression", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("standalone `---` line OUTSIDE frontmatter range → renders 1 hr widget", () => {
    const doc = "first paragraph\n\n---\n\nsecond paragraph\n";
    mounted = mount(doc);
    // Force decoration build by ensuring the view is laid out.
    mounted.view.requestMeasure();
    const hrs = mounted.host.querySelectorAll(".cm-hr");
    expect(hrs.length).toBeGreaterThanOrEqual(1);
  });

  it("frontmatter opening `---` is NOT rendered as an hr widget", () => {
    const doc = "---\nupdated: 2026-05-16T16:00:00.000Z\n---\nbody text\n";
    mounted = mount(doc);
    mounted.view.requestMeasure();
    // The frontmatter decoration hides the `---` delimiters via
    // Decoration.replace (empty widget). The hr decoration must NOT fire
    // on those same lines — otherwise a `.cm-hr` widget would render in
    // place of the hidden delimiter.
    const hrs = mounted.host.querySelectorAll(".cm-hr");
    expect(hrs.length).toBe(0);
  });

  it("frontmatter closing `---` is NOT rendered as an hr widget", () => {
    // Same as above — also asserts that the second `---` (closing
    // delimiter) is suppressed.
    const doc = "---\nupdated: foo\n---\nbody\n\n---\n\nafter\n";
    mounted = mount(doc);
    mounted.view.requestMeasure();
    // The standalone `---` AFTER body (outside frontmatter) should still
    // render an hr. The two frontmatter `---` lines should not.
    const hrs = mounted.host.querySelectorAll(".cm-hr");
    expect(hrs.length).toBe(1);
  });
});
