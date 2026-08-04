// myne#322 — an inline node that crosses a line break inside a blockquote.
//
// `renderInline` is called once per SOURCE LINE for a blockquote paragraph, so
// the per-line `> ` structure survives a re-parse. But `renderInlineNode` renders
// a node's FULL range, not the slice — so a node straddling the window was
// emitted whole by the first line's call, and then the trailing
// `slice(pos, to)` re-emitted its remainder on the next line's call.
//
// The caller re-prefixes that leftover, so `> *a\n> b*` serialized to
// `> *a b*\n> > b*` — a fabricated NESTED blockquote containing content the
// source never had, quote mark and all. Both invariants this module declares
// load-bearing fail on those inputs; the second pass diverges further still.
//
// This is exactly what Turndown emits for `<blockquote><em>a<br>b</em></blockquote>`,
// i.e. any clipped pull-quote with a bold run or a link in it.

import { describe, expect, it } from "vitest";
import { assertCanonicalD1, assertIdempotent } from "./_rig";

// Strict tree-shape round-trip does NOT apply to this input class, and cannot:
// the source carries an interior `QuoteMark` INSIDE the inline node — the `>` on
// the wrapped line — and collapsing the wrap onto one line necessarily removes
// it. That mark is markup of the wrap, not of the content. What must hold, and
// what was diverging, is IDEMPOTENCY: the old output grew a bogus nested
// blockquote on the first pass and drifted further on every pass after it.
describe("a blockquote whose inline node crosses a line break", () => {
  it("emphasis", () => {
    expect(assertIdempotent("> *a\n> b*\n")).toBe("> *a b*");
  });

  it("strong, across a hard break", () => {
    expect(assertIdempotent("> **a  \n> b**\n")).toBe("> **a b**");
  });

  it("a link whose text wraps", () => {
    expect(assertIdempotent("> [a  \n> b](http://e.com)\n")).toBe(
      "> [a b](http://e.com)",
    );
  });

  it("a run spanning three lines", () => {
    expect(assertIdempotent("> *a\n> b\n> c*\n")).toBe("> *a b c*");
  });

  it("strikethrough", () => {
    expect(assertIdempotent("> ~~a\n> b~~\n")).toBe("> ~~a b~~");
  });

  it("leaves a blockquote whose inline nodes stay on one line alone", () => {
    // The bound in the other direction: the per-line rendering that keeps the
    // `> ` structure must still work.
    expect(assertCanonicalD1("> *a*\n> *b*\n")).toBe("> *a*\n> *b*");
  });
});
