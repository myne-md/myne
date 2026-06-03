// @vitest-environment jsdom
//
// Fenced code nested in a list item / blockquote.
//
// MYND-154 task 9 originally gated the card to TOP-LEVEL fences only (a nested
// fence parsed as FencedCode but got NO card chrome, to avoid colliding with
// the list marker / quote bar). MYND-155 lifted that gate, keyed off
// `quoteDepthOf`:
//   - A BLOCKQUOTE-nested fence renders as a single read-only contained widget
//     (`CodeInQuoteWidget`: bars in a left margin + an inset boxed card) — one
//     block-replace decoration spanning the whole block.
//   - A fence nested only in a plain LIST (no blockquote, so quoteDepth === 0)
//     falls through to the standard top-level card (bar + carded body + hidden
//     close fence) — multiple decorations.
// Either way the document text stays byte-stable (the card is decoration only).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import { buildCodeBlockDecorations } from "../../src/editor/decorations/fenced-code";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
      ],
    }),
    parent: host,
  });
  forceParsing(view);
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

function hasFenced(view: EditorView): boolean {
  let found = false;
  syntaxTree(view.state).iterate({
    enter: (n) => {
      if (n.name === "FencedCode") found = true;
    },
  });
  return found;
}

// Card decoration ranges in the away state (revealAllowed = false).
function cardDecos(view: EditorView): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  buildCodeBlockDecorations(view.state, false).between(
    0,
    view.state.doc.length,
    (from, to) => {
      out.push({ from, to });
    },
  );
  return out;
}

describe("nested fenced code (MYND-155: blockquote → contained card, list → standard card)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("a top-level fence gets the standard multi-part card (contrast control)", () => {
    m = mount("```rust\nlet x = 1;\n```");
    // Bar (open-fence replace) + carded body line + hidden close fence.
    expect(cardDecos(m.view).length).toBeGreaterThan(1);
  });

  it("a blockquote-nested fence renders as one contained card widget", () => {
    const doc = "> ```rust\n> let x = 1;\n> ```";
    m = mount(doc);
    expect(hasFenced(m.view)).toBe(true); // parser control: it IS a FencedCode
    const decos = cardDecos(m.view);
    // Exactly one block-replace spanning the whole block (CodeInQuoteWidget),
    // NOT the per-line standard card.
    expect(decos.length).toBe(1);
    expect(decos[0]).toEqual({ from: 0, to: m.view.state.doc.length });
    expect(m.view.state.doc.toString()).toBe(doc); // byte-stable
  });

  it("a list-nested fence (no blockquote) gets the standard card", () => {
    const doc = "- item\n  ```rust\n  let x = 1;\n  ```";
    m = mount(doc);
    expect(hasFenced(m.view)).toBe(true);
    // quoteDepth === 0 → falls through to the standard top-level card
    // (more than one decoration), unlike the single-widget blockquote case.
    expect(cardDecos(m.view).length).toBeGreaterThan(1);
    expect(m.view.state.doc.toString()).toBe(doc); // byte-stable
  });
});
