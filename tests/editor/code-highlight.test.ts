// Tests for the nested code-highlight gate (MYND-154 task 3).
// Pure-decision tests + an integration check that grounds the closed-ness
// signal (CodeMark child count) against the real markdown parser.

import { describe, it, expect } from "vitest";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { fencedCodeNestLanguage } from "../../src/editor/code-highlight";

function firstFenced(src: string): SyntaxNode | null {
  return markdownLanguage.parser.parse(src).topNode.getChild("FencedCode");
}

describe("fencedCodeNestLanguage — gate decision", () => {
  it("nests a closed, tagged fence", () => {
    expect(fencedCodeNestLanguage("FencedCode", 2, "rust")?.name).toBe("rust");
    expect(fencedCodeNestLanguage("FencedCode", 2, "JS")?.name).toBe("javascript");
  });

  it("does NOT nest an unclosed fence (< 2 CodeMarks) — no color bleed", () => {
    expect(fencedCodeNestLanguage("FencedCode", 1, "rust")).toBeNull();
    expect(fencedCodeNestLanguage("FencedCode", 0, "rust")).toBeNull();
  });

  it("does NOT nest an untagged or unknown fence", () => {
    expect(fencedCodeNestLanguage("FencedCode", 2, "")).toBeNull();
    expect(fencedCodeNestLanguage("FencedCode", 2, "foober")).toBeNull();
  });

  it("does NOT nest non-fenced nodes", () => {
    expect(fencedCodeNestLanguage("Paragraph", 2, "rust")).toBeNull();
    expect(fencedCodeNestLanguage("CodeBlock", 2, "rust")).toBeNull();
  });
});

describe("closed-ness signal grounded against the real parser", () => {
  it("a closed fence has two CodeMark children → gate nests", () => {
    const node = firstFenced("```rust\nlet x = 1;\n```");
    expect(node).not.toBeNull();
    const marks = node!.getChildren("CodeMark").length;
    expect(marks).toBe(2);
    const info = node!.getChild("CodeInfo");
    const infoText = info ? "rust" : "";
    expect(fencedCodeNestLanguage("FencedCode", marks, infoText)?.name).toBe("rust");
  });

  it("an unclosed fence has one CodeMark, extends to EOF → gate skips (no bleed)", () => {
    const src = "```rust\nlet x = 1;\nmore text below that must NOT become code";
    const node = firstFenced(src);
    expect(node).not.toBeNull();
    const marks = node!.getChildren("CodeMark").length;
    expect(marks).toBe(1);
    // The parser extends an unclosed fence to EOF — which is exactly why the
    // gate must suppress nesting, or coloring would bleed down the document.
    expect(node!.to).toBe(src.length);
    expect(fencedCodeNestLanguage("FencedCode", marks, "rust")).toBeNull();
  });
});
