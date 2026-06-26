// Clip serializer — task 5 (capture-extraction): the fidelity-floor MATH
// construct (§3.2 inline `$`-disambiguation + §5 / PRD "faithful … math").
//
// Inline `$…$` (the `InlineMath` Lezer node) re-emits as `$content$` ONLY when
// the §3.2 tokenizer rules hold — opening `$` not followed by whitespace/digit,
// closing `$` not preceded by whitespace, no line break inside — so Myne's OWN
// `$`-tokenizer parses it back to the same `InlineMath` structure. Block
// `$$…$$` is NOT a parser node (it is a decoration range, detected exactly as
// `emitNoteHtml.ts::findBlockMath` does, code ranges excluded); a standalone
// `$$…$$` paragraph re-emits as the canonical multi-line `$$\n…\n$$` block.
//
// Math that cannot be made tokenizer-legal SAFE-DEGRADES to inert literal text
// (escaped `$`) that re-parses as text, never as a mis-parseable `$…$` span.
// A currency-like `$5` in prose is never an InlineMath node, so it is never
// emitted as opening math.

import { describe, expect, it } from "vitest";
import { parser } from "../../../src/dialect/lezer/parser";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import {
  emitInlineMath,
  isLegalInlineMath,
} from "../../../src/dialect/clip/math";
import { assertCanonicalD1, assertIdempotent, shapeOf } from "./_rig";

/** The mark-to-mark LaTeX content of the first `InlineMath` node in `emitted`,
 *  or `null` when there is no `InlineMath` node (degraded to text / currency). */
function inlineMathContent(emitted: string): string | null {
  const tree = parser.parse(emitted);
  let found: string | null = null;
  tree.topNode.cursor().iterate((node) => {
    if (node.name === "InlineMath" && found === null) {
      const marks = node.node.getChildren("MathMark");
      const from = marks[0] !== undefined ? marks[0].to : node.from;
      const last = marks[marks.length - 1];
      const to = last !== undefined && last.from > from ? last.from : node.to;
      found = emitted.slice(from, to);
      return false;
    }
    return undefined;
  });
  return found;
}

/** Count of `InlineMath` nodes in a parse of `emitted`. */
function inlineMathCount(emitted: string): number {
  const tree = parser.parse(emitted);
  let n = 0;
  tree.topNode.cursor().iterate((node) => {
    if (node.name === "InlineMath") n++;
    return undefined;
  });
  return n;
}

describe("clip serializer — inline `$…$` math", () => {
  it("round-trips a simple inline math span tokenizer-legal", () => {
    const input = "An eq $x+y$ here.\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("$x+y$");
    expect(inlineMathContent(emitted)).toBe("x+y");
  });

  it("emits inline math with NO whitespace/digit after the opening `$`", () => {
    const input = "Value $x_1 + y_2$ here.\n";
    const emitted = assertCanonicalD1(input);
    const content = inlineMathContent(emitted);
    expect(content).not.toBeNull();
    // opener legality: first content char is neither whitespace nor a digit.
    expect(/^[\s\d]/u.test(content!)).toBe(false);
    expect(content).toBe("x_1 + y_2");
  });

  it("emits inline math with NO whitespace before the closing `$`", () => {
    const input = "Eq $a = b$ done.\n";
    const emitted = assertCanonicalD1(input);
    const content = inlineMathContent(emitted);
    expect(content).not.toBeNull();
    expect(/\s$/u.test(content!)).toBe(false);
  });

  it("round-trips two inline math spans in one paragraph", () => {
    const input = "First $a$ and second $b$ done.\n";
    const emitted = assertCanonicalD1(input);
    expect(emitted).toContain("$a$");
    expect(emitted).toContain("$b$");
    expect(inlineMathCount(emitted)).toBe(2);
  });

  it("preserves the LaTeX content byte-exact inside the span", () => {
    const input = "Sum $\\sum_{i=0}^{n} i^2$ ok.\n";
    const emitted = serializeClipMarkdown(input);
    expect(inlineMathContent(emitted)).toBe("\\sum_{i=0}^{n} i^2");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("is idempotent through inline math emission", () => {
    const input = "Identity $e^{i\\pi}+1=0$ holds.\n";
    const emitted = assertIdempotent(input);
    expect(emitted).toContain("$e^{i\\pi}+1=0$");
  });
});

describe("clip serializer — currency is never opening math", () => {
  it("leaves a currency-like `$5` in prose as literal text (no InlineMath)", () => {
    const input = "It costs $5 today.\n";
    const emitted = assertCanonicalD1(input);
    expect(inlineMathCount(emitted)).toBe(0);
    expect(emitted).toContain("$5");
  });

  it("leaves `$5.00` … `$10` currency runs as literal text", () => {
    const input = "From $5.00 to $10 each.\n";
    const emitted = assertCanonicalD1(input);
    expect(inlineMathCount(emitted)).toBe(0);
    expect(emitted).toContain("$5.00");
    expect(emitted).toContain("$10");
  });

  it("does not open math when `$` is followed by a space (price list)", () => {
    const input = "Pay $ 5 or $ 10.\n";
    const emitted = assertCanonicalD1(input);
    expect(inlineMathCount(emitted)).toBe(0);
  });
});

describe("clip serializer — block `$$…$$` math", () => {
  it("emits a standalone block as the canonical multi-line `$$…$$`", () => {
    const input = "$$\nE=mc^2\n$$\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe("$$\nE=mc^2\n$$");
    // Re-parses to a bare Paragraph (block `$$` is not a node) — same shape.
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("round-trips a tight one-line `$$a+b$$` to the canonical multi-line form", () => {
    const input = "$$a+b$$\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe("$$\na+b\n$$");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("emits a block between paragraphs, preserving the prose blocks", () => {
    const input = "Intro text.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter text.\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toBe("Intro text.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter text.");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("is idempotent through block math emission", () => {
    const input = "$$\n\\frac{a}{b}\n$$\n";
    const emitted = serializeClipMarkdown(input);
    expect(serializeClipMarkdown(emitted)).toBe(emitted);
    expect(emitted).toBe("$$\n\\frac{a}{b}\n$$");
  });

  it("does not treat a `$$` inside a fenced code block as block math", () => {
    const input = "```\n$$x$$\n```\n";
    const emitted = serializeClipMarkdown(input);
    // The `$$` is inside a code zone — it survives byte-exact in the fence.
    expect(emitted).toBe("```\n$$x$$\n```");
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });
});

describe("clip serializer — safe-degrade of un-representable inline math", () => {
  // These cases drive the degrade arm. A handed-off note may carry an
  // InlineMath whose mark-to-mark content (after upstream normalization) would
  // be tokenizer-ILLEGAL if re-emitted as `$content$`. Rather than emit a span
  // Myne's reader mis-parses, the serializer escapes the `$` so the bytes
  // re-parse as INERT literal text (Escape nodes), never as math.
  //
  // A parsed InlineMath always has legal endpoints (the tokenizer guarantees
  // it), so to exercise the degrade path we synthesize content the emit path
  // cannot legalize. The cross-check: the emit re-parses with ZERO InlineMath
  // nodes and ZERO bare opening-math `$`.

  it("never emits a mis-parseable `$…$`: a degraded span re-parses with no InlineMath", () => {
    // A legal span stays math; this test pins the invariant the degrade path
    // upholds — emitted inline math, if present, is ALWAYS a real InlineMath
    // node (no half-open `$` left dangling).
    const input = "Mix $a+b$ and prose with a stray cost $5 here.\n";
    const emitted = assertCanonicalD1(input);
    // Exactly one real math span (the `$a+b$`); the `$5` stays currency text.
    expect(inlineMathCount(emitted)).toBe(1);
    expect(inlineMathContent(emitted)).toBe("a+b");
  });

  it("an escaped `\\$` in prose never opens math and round-trips", () => {
    const input = "Literal \\$x\\$ is not math.\n";
    const emitted = assertCanonicalD1(input);
    expect(inlineMathCount(emitted)).toBe(0);
  });
});

describe("clip serializer — inline math §3.2 legality + degrade (unit)", () => {
  // The §3.2 contract, exercised directly against the emit helper, since a
  // PARSED InlineMath always has legal endpoints (the tokenizer guarantees it),
  // so the degrade arm cannot be reached through real markdown — but it is the
  // correctness floor and must be pinned.

  it("accepts a clean span as legal", () => {
    expect(isLegalInlineMath("x+y")).toBe(true);
    expect(emitInlineMath("x+y")).toBe("$x+y$");
  });

  it("rejects a leading-digit content (would read as currency) → degrade", () => {
    expect(isLegalInlineMath("5x")).toBe(false);
    // The bytes carry no `$`, so the degrade is the inert literal content.
    const out = emitInlineMath("5x");
    expect(parser.parse(out).topNode.getChild("InlineMath")).toBeNull();
  });

  it("rejects a leading-space content (space after opener) → degrade", () => {
    expect(isLegalInlineMath(" x")).toBe(false);
  });

  it("rejects a trailing-space content (space before closer) → degrade", () => {
    expect(isLegalInlineMath("x ")).toBe(false);
  });

  it("rejects line-crossing content → degrade", () => {
    expect(isLegalInlineMath("a\nb")).toBe(false);
  });

  it("rejects an interior bare `$` (would close early / open `$$`) → degrade", () => {
    expect(isLegalInlineMath("a$b")).toBe(false);
    // The degrade escapes EVERY `$` so no opening/closing delimiter survives —
    // the bytes re-parse as inert text, never a mis-parseable span.
    const out = emitInlineMath("a$b");
    const tree = parser.parse(`prose ${out} end`);
    let mathNodes = 0;
    tree.topNode.cursor().iterate((node) => {
      if (node.name === "InlineMath") mathNodes++;
      return undefined;
    });
    expect(mathNodes).toBe(0);
    expect(out).toBe("a\\$b");
  });

  it("degrade output re-parses as text (Escape nodes), never as math", () => {
    const out = emitInlineMath(" 5$x");
    const tree = parser.parse(`val ${out} done`);
    let mathNodes = 0;
    tree.topNode.cursor().iterate((node) => {
      if (node.name === "InlineMath") mathNodes++;
      return undefined;
    });
    expect(mathNodes).toBe(0);
    expect(out).toContain("\\$");
  });
});
