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
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { PARSE_BUDGET_MS } from "./_parse-budget";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { horizontalRuleDecorations } from "../../src/editor/decorations/horizontal-rule";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

type Mounted = { view: EditorView; host: HTMLElement };

/** Flush CM6's measure/decoration pass SYNCHRONOUSLY. CM6 schedules it on
 *  requestAnimationFrame; under full-suite load a synchronous test can query the
 *  decoration DOM before that rAF fires — a cross-file, load-dependent flake
 *  ("0 hr widgets" while the view is in fact correct). `measure()` is
 *  CM6-internal (absent from the public d.ts) but stable across the 6.x line; it
 *  is the synchronous body of the `requestMeasure()` that races here. */
function flushMeasure(view: EditorView): void {
  (view as unknown as { measure(flush?: boolean): void }).measure();
}

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
  // Parse the WHOLE document before the mount is handed back, and FAIL BY NAME
  // if that did not happen. An `EditorView`'s parsing is driven by a
  // `ViewPlugin` that schedules work asynchronously, so without this the tree
  // is whatever the background parser had reached when the constructor
  // returned. Both decorations here are built from that tree, which makes a
  // partial parse indistinguishable from a missing decoration: this file failed
  // in CI on `standalone \`---\` line OUTSIDE frontmatter range` with
  // `expected 0 to be greater than or equal to 1`, which reads as a broken
  // decoration and was a parse that had not reached the line.
  //
  // Same fix, same budget and same reasoning as the shared conformance mount;
  // `tests/editor/_parse-budget.ts` carries the measurements and records what
  // is NOT the cause (the budget is not reached at these document sizes).
  if (!forceParsing(view, view.state.doc.length, PARSE_BUDGET_MS)) {
    throw new Error(
      `hr-frontmatter: the syntax parse did not reach ${view.state.doc.length} ` +
        `within ${PARSE_BUDGET_MS} ms, so the tree is PARTIAL. The decoration ` +
        `asserted below is not necessarily missing: the parser had not reached it.`,
    );
  }
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
    flushMeasure(mounted.view);
    const hrs = mounted.host.querySelectorAll(".cm-hr");
    expect(hrs.length).toBeGreaterThanOrEqual(1);
  });

  it("frontmatter opening `---` is NOT rendered as an hr widget", () => {
    const doc = "---\nupdated: 2026-05-16T16:00:00.000Z\n---\nbody text\n";
    mounted = mount(doc);
    flushMeasure(mounted.view);
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
    flushMeasure(mounted.view);
    // The standalone `---` AFTER body (outside frontmatter) should still
    // render an hr. The two frontmatter `---` lines should not.
    const hrs = mounted.host.querySelectorAll(".cm-hr");
    expect(hrs.length).toBe(1);
  });
});
