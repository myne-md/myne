// The E2E suite's hand-copied user-facing strings, against the catalog they
// were copied FROM.
//
// **The duplication is deliberate and the drift is not.** `e2e/clipboard-copy.
// e2e.ts` explains why it does not import the catalog: the suite drives the
// production BUNDLE, so importing the same value the app renders would assert
// the test's copy against itself and prove nothing about what shipped. That
// reasoning is right, and it is exactly what makes the literal go stale, because
// nothing then compares the two.
//
// It went stale. `PHRASE_COPIED` still read "Copied to the clipboard. It clears
// itself in 30 seconds, even if you move on." long after the shipped string
// became "Copied. Myne clears it in 30 seconds, even if you move on, as long as
// the app keeps running." The scenario asserts by EQUALITY on purpose (the
// feature under test is that a failed copy and a successful one are
// distinguishable, and a non-empty check passes for both), so the stale literal
// turned into a 10-second timeout in CI, on develop and on every branch, that
// read like a broken clipboard rather than a renamed string.
//
// This test is the missing comparison, and it runs in `pnpm test` rather than
// in the 40-minute E2E lane: a copy edit fails here, at commit time, naming the
// literal to update.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

/** The English catalog, read as data rather than through i18n's loader. */
function catalog(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, "locales", "en", "common.json"), "utf8"));
}

/** A dotted key path out of the catalog, or `undefined`. */
function at(path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
      catalog(),
    );
}

/** The literal assigned to `name` in an E2E spec, with its quotes removed. */
function literalIn(specPath: string, name: string): string {
  const src = readFileSync(join(ROOT, specPath), "utf8");
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\n?\\s*"([^"]*)"`));
  if (m === null) {
    throw new Error(
      `${name} not found in ${specPath}. If it was renamed or removed, update this ` +
        "test in the same change rather than deleting the comparison: the whole " +
        "point is that the duplication has an owner.",
    );
  }
  return m[1];
}

/** Every hand-copied string in the E2E suite, with the key it was copied from. */
const PAIRS: ReadonlyArray<{ spec: string; name: string; key: string }> = [
  {
    spec: "e2e/clipboard-copy.e2e.ts",
    name: "PHRASE_COPIED",
    key: "vaultCreation.phrase.copied",
  },
  {
    spec: "e2e/clipboard-copy.e2e.ts",
    name: "NOTE_COPIED",
    key: "export.note.modal.copied",
  },
];

describe("E2E copy literals track the catalog", () => {
  for (const { spec, name, key } of PAIRS) {
    it(`${name} equals ${key}`, () => {
      const shipped = at(key);
      expect(
        typeof shipped,
        `${key} is missing from locales/en/common.json, so ${name} in ${spec} is ` +
          "asserting against a string the app no longer has a source for.",
      ).toBe("string");
      expect(
        literalIn(spec, name),
        `${name} in ${spec} has drifted from ${key}. The scenario asserts by ` +
          "equality on purpose, so a stale literal is a timeout in the E2E lane " +
          "rather than a readable diff. Update the literal to the catalog value.",
      ).toBe(shipped);
    });
  }

  it("covers every copy-outcome literal the spec declares", () => {
    // Non-vacuity: a new `const X_COPIED = "..."` added to the spec without a
    // row above would otherwise be unchecked, and this file would still pass
    // while the thing it exists to prevent came back.
    //
    // Scoped to `*_COPIED` rather than every SCREAMING_CASE string const,
    // because the spec also holds test INPUTS (a fixture password), and a
    // sweep that demanded a catalog key for those would be a check nobody could
    // satisfy. The first version did exactly that and failed on `PASSWORD`,
    // which is how this scope got argued for rather than assumed.
    const src = readFileSync(join(ROOT, "e2e/clipboard-copy.e2e.ts"), "utf8");
    const declared = [...src.matchAll(/const\s+([A-Z][A-Z0-9_]*_COPIED)\s*=\s*\n?\s*"/g)].map(
      (m) => m[1],
    );
    expect(declared.length, "the sweep must find the literals it is scoped to").toBeGreaterThan(0);
    const covered = new Set(PAIRS.map((p) => p.name));
    expect(
      declared.filter((n) => !covered.has(n)),
      "a copy literal in clipboard-copy.e2e.ts has no row in PAIRS, so nothing " +
        "compares it to the catalog",
    ).toEqual([]);
  });
});
