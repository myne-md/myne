// Inline-decoration inertness inside code (MYND-154 task 8).
//
// The wikilink-chip / inline-tag / emphasis / link / inline-code decoration
// builders all traverse `syntaxTree(state)` and match by node NAME. So the
// guarantee that `[[wiki]]`, `#tag`, `**bold**`, `[x](y)` render verbatim
// inside a fenced block reduces to: the parser must not emit those inline
// node names inside a FencedCode. This test asserts exactly that, with control
// assertions proving the same literals DO parse outside a fence (so a wrong
// node name can't make the inertness check pass for the wrong reason).

import { describe, expect, it } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { InlineTag } from "../../src/dialect/lezer/inline-tag";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";

const language = markdown({
  base: markdownLanguage,
  extensions: [Wikilink, InlineTag, codeNestMarkdownExtension],
}).language;

const INLINE_MARKUP = ["Wikilink", "InlineTag", "Emphasis", "StrongEmphasis", "Link"];

function nodeNamesIn(tree: Tree, from: number, to: number): Set<string> {
  const names = new Set<string>();
  tree.iterate({ from, to, enter: (n) => void names.add(n.name) });
  return names;
}

function firstFenced(tree: Tree): SyntaxNode {
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (!found && n.name === "FencedCode") found = n.node;
    },
  });
  if (!found) throw new Error("no FencedCode in fixture");
  return found;
}

const DOC = [
  "Outside [[wiki]], #tag, **bold**, [link](http://x).", // prose: markup IS parsed
  "",
  "```text",
  "inside [[wiki]] #tag **bold** [link](http://x) stays literal",
  "```",
  "",
].join("\n");

describe("inline markup inside a fenced code block", () => {
  const tree = language.parser.parse(DOC);

  it("control: the same markup DOES parse in prose (proves the node names are right)", () => {
    const prose = nodeNamesIn(tree, 0, DOC.indexOf("```text"));
    expect(prose.has("Wikilink")).toBe(true);
    expect(prose.has("InlineTag")).toBe(true);
    expect(prose.has("StrongEmphasis")).toBe(true); // `**bold**` → StrongEmphasis
    expect(prose.has("Link")).toBe(true);
  });

  it("emits NO inline-markup nodes inside the fenced block — literals stay verbatim", () => {
    const fenced = firstFenced(tree);
    const inside = nodeNamesIn(tree, fenced.from, fenced.to);
    for (const name of INLINE_MARKUP) {
      expect(inside.has(name)).toBe(false);
    }
  });
});
