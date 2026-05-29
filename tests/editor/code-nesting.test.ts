// @vitest-environment jsdom
//
// Fenced code nested in a list item / blockquote (MYND-154 task 9).
// The card is gated to top-level fences (non-breaking); a nested fence still
// parses as FencedCode (so coloring applies via the parseMixed wrap) but gets
// no card chrome — avoiding a collision with the list marker / quote bar.
// Pixel-perfect nested cards are deferred per the grill.

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

function cardDecoCount(view: EditorView): number {
  let n = 0;
  buildCodeBlockDecorations(view.state, false).between(0, view.state.doc.length, () => {
    n++;
  });
  return n;
}

describe("nested fenced code (task 9)", () => {
  let m: Mounted | null = null;
  afterEach(() => {
    if (m) teardown(m);
    m = null;
  });

  it("a top-level fence DOES get the card (contrast control)", () => {
    m = mount("```rust\nlet x = 1;\n```");
    expect(cardDecoCount(m.view)).toBeGreaterThan(0);
  });

  it("a blockquote-nested fence parses as FencedCode but gets NO card", () => {
    const doc = "> ```rust\n> let x = 1;\n> ```";
    m = mount(doc);
    expect(hasFenced(m.view)).toBe(true); // parser control: it IS a FencedCode
    expect(cardDecoCount(m.view)).toBe(0); // card skipped (gated to top-level)
    expect(m.view.state.doc.toString()).toBe(doc); // byte-stable
  });

  it("a list-nested fence parses as FencedCode but gets NO card", () => {
    const doc = "- item\n  ```rust\n  let x = 1;\n  ```";
    m = mount(doc);
    expect(hasFenced(m.view)).toBe(true);
    expect(cardDecoCount(m.view)).toBe(0);
    expect(m.view.state.doc.toString()).toBe(doc);
  });
});
