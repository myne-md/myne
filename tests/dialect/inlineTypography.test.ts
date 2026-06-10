// Inline typography parser registration (MYND-156, inline-typography task 1).
// Sub/Super/Emoji come pre-built from @lezer/markdown; Highlight (`==`) is
// hand-rolled. All four register in the shared parser without breaking the
// existing GFM strikethrough / footnote disambiguation.

import { describe, expect, it } from "vitest";
import { parser } from "../../src/dialect/lezer/parser";

function nodeNames(src: string): Set<string> {
  const names = new Set<string>();
  parser.parse(src).iterate({
    enter: (n) => {
      names.add(n.name);
    },
  });
  return names;
}

describe("inline typography parsing", () => {
  it("parses ==highlight== as a Highlight node", () => {
    const n = nodeNames("==hi==");
    expect(n).toContain("Highlight");
    expect(n).toContain("HighlightMark");
  });

  it("parses subscript ~x~ as Subscript", () => {
    expect(nodeNames("H~2~O")).toContain("Subscript");
  });

  it("parses superscript ^x^ as Superscript", () => {
    expect(nodeNames("X^2^")).toContain("Superscript");
  });

  it("parses :shortcode: as Emoji", () => {
    expect(nodeNames("a :smile: b")).toContain("Emoji");
  });
});

describe("no regression in adjacent constructs", () => {
  it("keeps ~~strike~~ as Strikethrough, not Subscript", () => {
    const n = nodeNames("~~gone~~");
    expect(n).toContain("Strikethrough");
    expect(n).not.toContain("Subscript");
  });

  it("keeps footnote [^1] parsing intact (^ not stolen by Superscript)", () => {
    expect(nodeNames("see [^1] x\n\n[^1]: note\n")).toContain("FootnoteReference");
  });

  it("does not parse `===` (three equals) as a Highlight", () => {
    expect(nodeNames("a === b")).not.toContain("Highlight");
  });
});
