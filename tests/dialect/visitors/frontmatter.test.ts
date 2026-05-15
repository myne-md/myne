// Frontmatter visitor — fixture-driven tests.
//
// Each `<name>.md` is paired with a `<name>.expected.json`. Most fixtures
// use full deep equality (`toEqual`); the malformed-yaml fixture uses a
// partial match because js-yaml's error message/line/column are
// version-dependent and pinning them would couple the test suite to a
// specific js-yaml release.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "../../../src/dialect/visitors/frontmatter";
import { fixtureDir, listFixtureBasenames } from "../_helpers";

const FIXTURE_DIR = fixtureDir("frontmatter");
const fixtures = listFixtureBasenames("frontmatter");

describe("parseFrontmatter — fixtures", () => {
  for (const name of fixtures) {
    it(`fixture: ${name}`, () => {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, `${name}.md`),
        "utf-8",
      );
      const expected = JSON.parse(
        fs.readFileSync(
          path.join(FIXTURE_DIR, `${name}.expected.json`),
          "utf-8",
        ),
      );
      const actual = parseFrontmatter(source);

      if (name === "malformed-yaml") {
        // Partial match — js-yaml's error message/line/column are
        // version-dependent. Pin only the structural contract.
        expect(actual.raw).toBe(expected.raw);
        expect(actual.parsed).toBeNull();
        expect(actual.byteRange).toEqual(expected.byteRange);
        expect(actual.error).not.toBeNull();
        expect(actual.error?.kind).toBe("yaml");
        expect(actual.error?.severity).toBe("error");
        expect(typeof actual.error?.message).toBe("string");
        expect((actual.error as { line: number }).line).toBeGreaterThan(0);
        expect((actual.error as { column: number }).column).toBeGreaterThan(0);
        expect((actual.error as { byteOffset: number }).byteOffset)
          .toBeGreaterThanOrEqual(0);
      } else {
        expect(actual).toEqual(expected);
      }
    });
  }
});

describe("parseFrontmatter — invariants", () => {
  it("never throws on any input", () => {
    const adversarialInputs = [
      "",
      "\0",
      "---",
      "---\n",
      "---\n---",
      "---\n\0\n---\n",
      "---\nкyрилл: bad: nested: bad\n---\n",
      "x".repeat(10000),
    ];
    for (const input of adversarialInputs) {
      expect(() => parseFrontmatter(input)).not.toThrow();
    }
  });

  it("opener-without-closer is treated as no-FM (not as an error)", () => {
    const result = parseFrontmatter("---\nfoo: bar\n# heading\nbody\n");
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
    expect(result.byteRange).toBeNull();
    expect(result.error).toBeNull();
  });

  it("empty FM body produces empty parsed object, no error", () => {
    const result = parseFrontmatter("---\n---\n");
    expect(result.raw).toBe("");
    expect(result.parsed).toEqual({});
    expect(result.byteRange).toEqual({ start: 0, end: 8 });
    expect(result.error).toBeNull();
  });
});
