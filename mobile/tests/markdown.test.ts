import { describe, it, expect } from "vitest";
import { parseInline, parseBlocks } from "../src/lib/markdown";

describe("parseInline()", () => {
  it("parses bold, italic, and code runs", () => {
    expect(parseInline("a **b** c *d* `e`")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "b" },
      { kind: "text", text: " c " },
      { kind: "italic", text: "d" },
      { kind: "text", text: " " },
      { kind: "code", text: "e" },
    ]);
  });

  it("parses wikilinks with and without an alias", () => {
    expect(parseInline("[[A]] [[B|c]]")).toEqual([
      { kind: "wikilink", target: "A", label: "A" },
      { kind: "text", text: " " },
      { kind: "wikilink", target: "B", label: "c" },
    ]);
  });

  it("parses Markdown links", () => {
    expect(parseInline("[x](http://y)")).toEqual([{ kind: "link", text: "x", href: "http://y" }]);
  });

  it("leaves plain text intact", () => {
    expect(parseInline("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });
});

describe("parseBlocks()", () => {
  it("parses headings with their levels", () => {
    expect(parseBlocks("# H1\n### H3")).toEqual([
      { kind: "heading", level: 1, content: [{ kind: "text", text: "H1" }] },
      { kind: "heading", level: 3, content: [{ kind: "text", text: "H3" }] },
    ]);
  });

  it("groups a fenced code block verbatim", () => {
    expect(parseBlocks("```\nlet x = 1\nlet y = 2\n```")).toEqual([{ kind: "code", text: "let x = 1\nlet y = 2" }]);
  });

  it("collects consecutive unordered list items", () => {
    expect(parseBlocks("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]] },
    ]);
  });

  it("recognizes an ordered list", () => {
    expect(parseBlocks("1. a\n2. b")[0]).toMatchObject({ kind: "list", ordered: true });
  });

  it("splits blank-separated text into paragraphs", () => {
    expect(parseBlocks("one\n\ntwo")).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "one" }] },
      { kind: "paragraph", content: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("parses blockquotes and horizontal rules", () => {
    const b = parseBlocks("> quoted\n\n---");
    expect(b[0]).toMatchObject({ kind: "quote" });
    expect(b[1]).toEqual({ kind: "hr" });
  });
});
