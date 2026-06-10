// @vitest-environment jsdom
//
// Whole-document byte-stability over tests.md (MYND-208, task 2). The global
// §6 C1 regression guard: the full editor renders every construct in the
// torture document, and a no-edit focus cycle leaves the buffer byte-identical.
// Render-only decorations must never mutate bytes — if a future decoration
// rewrites the buffer (e.g. an emoji decoration that substitutes the glyph in
// place instead of as a widget), this test fails.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { roundTripBytes } from "./_conformance";

const TESTS_MD = readFileSync(
  resolve(process.cwd(), "tests/fixtures/tests.md"),
  "utf8",
);

describe("tests.md whole-document byte stability (C1)", () => {
  it("round-trips byte-identical through a no-edit focus cycle", () => {
    expect(roundTripBytes(TESTS_MD)).toBe(TESTS_MD);
  });

  it("the byte-identity guard is non-vacuous (a changed document diverges)", () => {
    const mutated = TESTS_MD.replace(
      "# H1 — First Level Heading",
      "# CHANGED HEADING",
    );
    expect(mutated).not.toBe(TESTS_MD);
    // The guard distinguishes a changed document from the original...
    expect(roundTripBytes(mutated)).not.toBe(TESTS_MD);
    // ...and the mutated document itself still round-trips byte-identical
    // (decorations don't mutate the buffer, whatever its content).
    expect(roundTripBytes(mutated)).toBe(mutated);
  });
});
