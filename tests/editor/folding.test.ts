// @vitest-environment jsdom
//
// Mount CM6 folding + heading-section folding (heading-list-folding / MYND-300,
// task 2, stories 1/2/7).
//
// Heading-section fold ranges already exist in editor state — lang-markdown's
// `markdown()` composes a `headerIndent` foldService — so mounting
// `codeFolding()` + the inline fold markers (in `myneFolding()`) SURFACES them;
// we write no custom heading fold service. These tests assert:
//   - a heading line reports a foldable range running to the next same-or-higher
//     heading (so folding an H1 SUBSUMES the nested H2/H3 — story 7);
//   - `foldAll` / `unfoldAll` round-trip the fold state on a multi-heading doc;
//   - the list-fold service is composed in (a children-bearing item folds).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  foldable,
  foldAll,
  foldedRanges,
  syntaxTree,
  unfoldAll,
} from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { assertParsed } from "./_parse-budget";
import { myneFolding } from "../../src/editor/folding";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), myneFolding()],
    }),
    parent: host,
  });
  assertParsed(view);
  syntaxTree(view.state);
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

/** Count the folded ranges currently in the state. */
function foldCount(view: EditorView): number {
  let n = 0;
  foldedRanges(view.state).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const DOC = [
  "# Alpha",
  "intro alpha",
  "## Alpha One",
  "child body",
  "### Deep",
  "deeper body",
  "# Beta",
  "beta body",
].join("\n");

describe("myneFolding — heading-section folding", () => {
  it("an H1 heading is foldable, and its section subsumes nested H2/H3 (runs to the next H1)", () => {
    m = mount(DOC);
    const view = m.view;
    const h1Line = view.state.doc.lineAt(DOC.indexOf("# Alpha"));
    const range = foldable(view.state, h1Line.from, h1Line.to);
    expect(range).not.toBeNull();
    // The fold range must reach AT LEAST into the nested section (past `### Deep`)
    // — i.e. folding `# Alpha` hides `## Alpha One` + `### Deep`, the subsume rule.
    const betaStart = DOC.indexOf("# Beta");
    expect(range!.to).toBeGreaterThanOrEqual(DOC.indexOf("deeper body"));
    expect(range!.to).toBeLessThanOrEqual(betaStart);
  });

  it("a leaf heading (no following nested content before the next heading) folds its own lines", () => {
    m = mount(DOC);
    const view = m.view;
    const deepLine = view.state.doc.lineAt(DOC.indexOf("### Deep"));
    const range = foldable(view.state, deepLine.from, deepLine.to);
    expect(range).not.toBeNull();
    // `### Deep`'s section ends at `# Beta` (the next same-or-higher heading).
    expect(range!.to).toBeLessThanOrEqual(DOC.indexOf("# Beta"));
  });
});

describe("myneFolding — foldAll / unfoldAll", () => {
  it("foldAll collapses every heading section; unfoldAll expands them back", () => {
    m = mount(DOC);
    const view = m.view;
    expect(foldCount(view)).toBe(0);
    expect(foldAll(view)).toBe(true);
    expect(foldCount(view)).toBeGreaterThan(0);
    expect(unfoldAll(view)).toBe(true);
    expect(foldCount(view)).toBe(0);
  });
});

describe("myneFolding — list folding composed in", () => {
  it("a children-bearing list item is foldable through the mounted service", () => {
    m = mount("- parent\n  - child a\n  - child b\n- flat\n");
    const view = m.view;
    const parentLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("parent"));
    expect(foldable(view.state, parentLine.from, parentLine.to)).not.toBeNull();
  });
});
