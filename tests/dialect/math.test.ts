// Inline math parsing + `$`-disambiguation (MYND-48, math-katex task 2).
// The currency-safety rules are load-bearing: tests.md's `Currency: $ € £ …`
// and `$5` must NOT parse as math.

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

describe("inline math + $-disambiguation", () => {
  it("parses $E = mc^2$ as InlineMath", () => {
    const n = nodeNames("the $E = mc^2$ formula");
    expect(n).toContain("InlineMath");
    expect(n).toContain("MathMark");
  });

  it("does NOT parse currency ($ followed by whitespace)", () => {
    expect(nodeNames("Currency: $ € £ ¥ ₿")).not.toContain("InlineMath");
  });

  it("does NOT parse $5 as math ($ + digit = currency)", () => {
    expect(nodeNames("it cost $5 today")).not.toContain("InlineMath");
  });

  it("does NOT parse $$…$$ as inline math (that is block)", () => {
    expect(nodeNames("$$x = y$$")).not.toContain("InlineMath");
  });

  it("requires a non-space char before the closing $", () => {
    expect(nodeNames("a $x $ b")).not.toContain("InlineMath");
  });

  it("does not cross a line break", () => {
    expect(nodeNames("$x\ny$")).not.toContain("InlineMath");
  });
});
