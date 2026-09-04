// @vitest-environment jsdom
//
// Spell-check skip helper (SYNC-3, MYND-264 task 1) + native-spellcheck-off
// wiring (SYNC-5, MYND-264 task 2).

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { InlineTag } from "../../src/dialect/lezer/inline-tag";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import { isSpellable } from "../../src/editor/decorations/spell-skip";
import { myneExtensions } from "../../src/editor/extensions";

// One occurrence of each probe word so `indexOf` is unambiguous.
const DOC = [
  "---",
  "title: titleword",
  "---",
  "",
  "Here is proseword text.",
  "Inline `inlineword` here.",
  "A #tagword here.",
  "A [[Targetword]] here.",
  "A [[Other|Displayword]] here.",
  "A <https://urlword.com> here.",
  "```",
  "fencedword block",
  "```",
].join("\n");

function mountParser(doc: string): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: [Wikilink, InlineTag, codeNestMarkdownExtension],
        }),
      ],
    }),
    parent: host,
  });
  assertParsed(view);
  return view;
}

function spellableAtWord(view: EditorView, word: string): boolean {
  const pos = view.state.doc.toString().indexOf(word);
  expect(pos, `probe word "${word}" present`).toBeGreaterThanOrEqual(0);
  // Probe a position INSIDE the word (not its boundary).
  return isSpellable(view.state, pos + 1);
}

describe("isSpellable (SYNC-3 skip rules)", () => {
  const view = mountParser(DOC);

  it("spell-checks plain prose", () => {
    expect(spellableAtWord(view, "proseword")).toBe(true);
  });

  it("skips the frontmatter block", () => {
    expect(spellableAtWord(view, "titleword")).toBe(false);
  });

  it("skips inline code", () => {
    expect(spellableAtWord(view, "inlineword")).toBe(false);
  });

  it("skips fenced code", () => {
    expect(spellableAtWord(view, "fencedword")).toBe(false);
  });

  it("skips an inline tag", () => {
    expect(spellableAtWord(view, "tagword")).toBe(false);
  });

  it("skips a wikilink target", () => {
    expect(spellableAtWord(view, "Targetword")).toBe(false);
  });

  it("spell-checks a wikilink alias (display text)", () => {
    expect(spellableAtWord(view, "Displayword")).toBe(true);
  });

  it("skips a URL / autolink", () => {
    expect(spellableAtWord(view, "urlword")).toBe(false);
  });
});

describe("native WebView spellcheck disabled (SYNC-5)", () => {
  it("myneExtensions sets spellcheck=false on the editor content", () => {
    const state = EditorState.create({ doc: "x", extensions: [myneExtensions()] });
    const attrs = state.facet(EditorView.contentAttributes);
    const off = attrs.some(
      (a) => typeof a !== "function" && a.spellcheck === "false",
    );
    expect(off).toBe(true);
  });
});
