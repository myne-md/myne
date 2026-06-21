// Reusable round-trip + idempotency rig for the clip serializer slices.
//
// Task 1 (capture-extraction) establishes this rig; every later construct
// slice (headings/lists/tables/code/math/callouts/footnotes/highlights)
// imports these helpers rather than re-deriving the invariants. The two
// load-bearing properties a canonical-D1 emit must hold (SYNC-7 / story 18):
//
//   1. Round-trip: `emit → parser.parse(emit)` is structurally identical to
//      the parse of the original handed-off markdown. "Structurally" means the
//      position-free nested node-name skeleton matches — emit may renormalize
//      bytes (canonical delimiters, whitespace) but must reproduce the same
//      tree shape, the checkable definition of "canonical D1".
//   2. Idempotency: `serialize(serialize(x)) === serialize(x)` — a second pass
//      is a fixed point (modeled on `table-model.ts`'s documented idempotence).
//
// The rig imports the SHARED parser singleton (the same instance the
// serializer uses) so a single `parser.parse` authority governs both the
// emit and the verification — no second parse instance anywhere.

import { expect } from "vitest";
import type { Tree } from "@lezer/common";
import { parser } from "../../../src/dialect/lezer/parser";
import { serializeClipMarkdown } from "../../../src/dialect/clip";

/**
 * Position-free nested node-name skeleton of a parse tree. Two documents share
 * a skeleton when their block/inline node nesting is identical regardless of
 * byte offsets — the structural-equality basis for the round-trip invariant.
 * A trailing newline (and other byte-level renormalizations the serializer is
 * allowed to make) does not change the skeleton.
 */
export function treeShape(tree: Tree): string {
  const out: string[] = [];
  let depth = 0;
  tree.cursor().iterate(
    (node) => {
      out.push("  ".repeat(depth) + node.name);
      depth++;
    },
    () => {
      depth--;
    },
  );
  return out.join("\n");
}

/** Parse a source string with the shared parser singleton and return its shape. */
export function shapeOf(source: string): string {
  return treeShape(parser.parse(source));
}

/**
 * Assert the round-trip invariant for one input: the serializer's output parses
 * (via the shared parser) to a tree structurally identical to the parse of the
 * input. Returns the emitted markdown so callers can layer extra assertions.
 */
export function assertRoundTrip(input: string): string {
  const emitted = serializeClipMarkdown(input);
  expect(shapeOf(emitted)).toBe(shapeOf(input));
  return emitted;
}

/**
 * Assert idempotency for one input: `serialize(serialize(x)) === serialize(x)`.
 * Returns the (stable) emitted markdown.
 */
export function assertIdempotent(input: string): string {
  const once = serializeClipMarkdown(input);
  const twice = serializeClipMarkdown(once);
  expect(twice).toBe(once);
  return once;
}

/**
 * Assert both invariants AND purity (the input string is never mutated — it is
 * immutable in JS, so this guards that the function returns a value derived from
 * it without throwing). The one-call convenience every construct slice uses.
 */
export function assertCanonicalD1(input: string): string {
  const before = input;
  const emitted = assertRoundTrip(input);
  assertIdempotent(input);
  expect(input).toBe(before); // pure: input reference unchanged
  return emitted;
}
