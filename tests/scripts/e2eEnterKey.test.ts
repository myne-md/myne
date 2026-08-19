// Every `ENTER` constant in the E2E suite must actually be U+E007.
//
// **The character is invisible, so losing it is invisible too.** WebDriver's
// Actions API delivers Enter as the private-use code point U+E007; a literal
// "\n" in a `sendKeys` payload is passed through as U+000A and CM6 never sees a
// keypress. Specs therefore carry an `ENTER` constant, and several wrote it as
// the raw character.
//
// `e2e/drawing-inline-embed.e2e.ts` had `const ENTER = ""`. The character was
// gone from the source, and nothing could see it: the file reads identically
// with and without it, `tsc` is happy with an empty string, and the failure
// surfaced 45 seconds later as a missing drawing thumbnail. `/drawing` was
// being typed with no Enter after it, so the slash menu never confirmed and no
// drawing note was ever minted. The scenario had been red on develop and on
// every branch, and it read like a broken drawing feature rather than a lost
// keystroke.
//
// The repo's own note on this trap says to BYTE-VERIFY rather than trust the
// display. This test is that verification, run on every commit, and it also
// pushes the suite toward the escape form: `""` survives a copy-paste,
// an editor that normalises private-use characters, and a reviewer's eye.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { globSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..", "..");

/** Resolve a TypeScript string literal's `\uXXXX` escapes to real characters. */
function resolveEscapes(literal: string): string {
  return literal.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** Every `const <NAME containing ENTER> = "…"` in the E2E suite. */
function enterConstants(): Array<{ file: string; name: string; source: string }> {
  const out: Array<{ file: string; name: string; source: string }> = [];
  for (const file of globSync("e2e/**/*.ts", { cwd: ROOT })) {
    const src = readFileSync(join(ROOT, file), "utf8");
    for (const m of src.matchAll(/const\s+([A-Z_]*ENTER[A-Z_]*)\s*=\s*"([^"]*)"/g)) {
      out.push({ file, name: m[1], source: m[2] });
    }
  }
  return out;
}

describe("E2E Enter constants", () => {
  const found = enterConstants();

  it("finds the constants it is scoped to", () => {
    // Non-vacuity. A rename that made this sweep match nothing would otherwise
    // leave the file passing while checking no constant at all, which is the
    // exact shape the repo's guard notes keep catching.
    expect(
      found.length,
      "no ENTER constant found in e2e/**; if the convention moved, move this test with it",
    ).toBeGreaterThan(0);
  });

  for (const { file, name, source } of found) {
    it(`${file}: ${name} is U+E007`, () => {
      const resolved = resolveEscapes(source);
      expect(
        [...resolved].map((c) => c.codePointAt(0)),
        `${name} in ${file} resolves to ${JSON.stringify(resolved)} ` +
          `(${resolved.length} code point(s)), not the single U+E007 WebDriver ` +
          "delivers Enter as. An empty value here types the payload with no Enter " +
          "after it, which fails much later and looks like a broken feature.",
      ).toEqual([0xe007]);
    });
  }
});
