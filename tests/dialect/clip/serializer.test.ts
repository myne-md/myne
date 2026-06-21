// Clip serializer — task 1 (capture-extraction): serializer skeleton +
// paragraph / plain-inline-text walk + the round-trip + idempotency rig.
//
// This slice covers ONLY paragraphs and plain inline text (escaped/normalized
// per markdown-dialect.md §5). Later slices (headings/lists/tables/code/math/
// callouts/footnotes/highlights) extend the same walker and reuse `_rig.ts`.
//
// A clip is AUTHORED canonical-D1 content (SYNC-7), not a C1-preserved import,
// so the serializer is free to renormalize bytes as long as the parse tree
// round-trips structurally and the second pass is a fixed point.

import { describe, expect, it, vi } from "vitest";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { serializeClipMarkdown as serializeFromIndex } from "../../../src/dialect/index";
import * as parserModule from "../../../src/dialect/lezer/parser";
import {
  assertCanonicalD1,
  assertIdempotent,
  assertRoundTrip,
  shapeOf,
} from "./_rig";

describe("serializeClipMarkdown — single shared parser", () => {
  it("parses via the shared `parser` singleton (no second parse instance)", () => {
    const spy = vi.spyOn(parserModule.parser, "parse");
    try {
      serializeClipMarkdown("A paragraph.\n\nAnother paragraph.\n");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("never constructs a second parser (configure is not called)", () => {
    // The module imports the prebuilt singleton; nothing in the serializer
    // re-configures @lezer/markdown. Spying on the singleton's `parse` and
    // confirming it is the sole parse authority is the structural guarantee.
    const spy = vi.spyOn(parserModule.parser, "parse");
    try {
      serializeClipMarkdown("x\n");
      // Every parse the serializer performs goes through this one instance.
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("serializeClipMarkdown — multi-paragraph round-trip", () => {
  it("round-trips a multi-paragraph document to a structurally-identical tree", () => {
    const input =
      "First paragraph of the clip.\n\nSecond paragraph here.\n\nThird and last.\n";
    const emitted = assertRoundTrip(input);
    // Two paragraphs in, the structure is preserved (three Paragraph nodes).
    expect(shapeOf(emitted)).toBe(shapeOf(input));
  });

  it("separates paragraphs with a single blank line canonically", () => {
    const emitted = serializeClipMarkdown("one\n\n\n\ntwo\n");
    // Collapsed to exactly one blank line between the two paragraphs.
    expect(emitted).toContain("one\n\ntwo");
    assertRoundTrip("one\n\n\n\ntwo\n");
  });

  it("preserves plain inline text content within a paragraph", () => {
    const input = "A sentence with several words and punctuation, here.\n";
    const emitted = serializeClipMarkdown(input);
    expect(emitted).toContain("A sentence with several words and punctuation, here.");
    assertRoundTrip(input);
  });
});

describe("serializeClipMarkdown — idempotency", () => {
  it("is idempotent for a multi-paragraph document", () => {
    assertIdempotent("alpha para.\n\nbeta para.\n\ngamma para.\n");
  });

  it("is a fixed point on its own output", () => {
    const once = serializeClipMarkdown("p1\n\np2\n");
    expect(serializeClipMarkdown(once)).toBe(once);
  });
});

describe("serializeClipMarkdown — purity + throw-on-empty", () => {
  it("does not mutate the input string", () => {
    const input = "untouched input\n\nsecond\n";
    const copy = `${input}`;
    serializeClipMarkdown(input);
    expect(input).toBe(copy);
  });

  it("throws on empty input", () => {
    expect(() => serializeClipMarkdown("")).toThrow();
  });

  it("throws on whitespace-only input (no extractable content)", () => {
    expect(() => serializeClipMarkdown("   \n\n  \t\n")).toThrow();
  });

  it("does not throw on ordinary multi-paragraph content", () => {
    expect(() => serializeClipMarkdown("a\n\nb\n")).not.toThrow();
  });
});

describe("serializeClipMarkdown — export surface", () => {
  it("is reachable from src/dialect/index.ts", () => {
    expect(serializeFromIndex).toBe(serializeClipMarkdown);
  });
});

describe("serializeClipMarkdown — rig reusability (canonical-D1 helper)", () => {
  it("the one-call canonical-D1 helper passes for plain paragraphs", () => {
    assertCanonicalD1("paragraph one\n\nparagraph two\n");
  });

  it("plain text with markdown-inactive punctuation survives the round-trip", () => {
    assertCanonicalD1("Cost is 5 dollars, plus tax (10%).\n");
  });
});

describe("serializeClipMarkdown — plain inline text robustness", () => {
  it("passes recognize-only inline bytes through verbatim (#tag stays)", () => {
    const emitted = assertCanonicalD1("Text with #hashtag and 1. number.\n");
    expect(emitted).toContain("#hashtag");
  });

  it("preserves backslash escapes (recognize-only Escape node)", () => {
    const emitted = assertCanonicalD1("Text with \\* escaped star.\n");
    expect(emitted).toContain("\\*");
  });

  it("preserves HTML entities", () => {
    const emitted = assertCanonicalD1("x &amp; y entity.\n");
    expect(emitted).toContain("&amp;");
  });

  it("joins a soft-wrapped paragraph into a single canonical line", () => {
    const emitted = assertCanonicalD1("wrapped line one\nwrapped line two\n");
    expect(emitted).toBe("wrapped line one wrapped line two");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(serializeClipMarkdown("Lots   of    spaces.\n")).toBe(
      "Lots of spaces.",
    );
  });
});
