// Link-destination + title escaping in the clip serializer (L3 — the
// "never broken markdown / round-trip-safe" guarantee for links). A
// destination with whitespace or unbalanced parens, and a title carrying a
// double-quote, must emit canonical D1 that re-parses to the SAME tree (and is
// idempotent) — never a `[text](url)` that breaks apart on re-parse.

import { describe, expect, it } from "vitest";
import { serializeClipMarkdown } from "../../../src/dialect/clip";
import { assertCanonicalD1 } from "./_rig";

describe("clip serializer — link destination escaping", () => {
  it("round-trips a destination containing a space (angle-bracket form)", () => {
    const out = assertCanonicalD1("[a](<b c>)");
    expect(out).toContain("(<b c>)");
  });

  it("round-trips a destination with an unbalanced paren", () => {
    // `<...>` permits parens that a bare destination could not carry.
    assertCanonicalD1("[a](<x(y>)");
  });

  it("leaves a clean destination bare (no needless wrapping)", () => {
    const out = serializeClipMarkdown("[a](https://example.com/p-q_r)");
    expect(out).toContain("(https://example.com/p-q_r)");
    expect(out).not.toContain("<https://");
  });

  it("does not re-wrap an already angle-wrapped clean destination", () => {
    // A dash is legal bare — the strip+rewrap must not add angle brackets.
    const out = serializeClipMarkdown("[a](<https://example.com/p-q>)");
    expect(out).toContain("(https://example.com/p-q)");
    expect(out).not.toContain("<https://");
  });
});

describe("clip serializer — link title escaping", () => {
  it("escapes a double-quote in a single-quoted source title", () => {
    const out = assertCanonicalD1(`[a](u 'q"t')`);
    // Canonicalized to the double-quote form with the inner quote escaped.
    expect(out).toContain('"q\\"t"');
  });

  it("round-trips and is idempotent for a plain double-quoted title", () => {
    const out = assertCanonicalD1('[a](u "plain")');
    expect(out).toContain('"plain"');
  });
});
