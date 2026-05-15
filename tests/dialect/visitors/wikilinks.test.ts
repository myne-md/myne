// Wikilink visitor — fixture-driven tests + invariant checks.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractWikilinks } from "../../../src/dialect/visitors/wikilinks";
import { fixtureDir, listFixtureBasenames } from "../_helpers";

const FIXTURE_DIR = fixtureDir("wikilinks");
const fixtures = listFixtureBasenames("wikilinks");

describe("extractWikilinks — fixtures", () => {
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
      expect(extractWikilinks(source)).toEqual(expected);
    });
  }
});

describe("extractWikilinks — invariants", () => {
  it("source.substring(byteRange) === raw for every emitted wikilink", () => {
    for (const name of fixtures) {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, `${name}.md`),
        "utf-8",
      );
      const refs = extractWikilinks(source);
      for (const ref of refs) {
        expect(source.substring(ref.byteRange.start, ref.byteRange.end))
          .toBe(ref.raw);
      }
    }
  });

  it("returns empty array for source with no wikilinks", () => {
    expect(extractWikilinks("just paragraph text")).toEqual([]);
    expect(extractWikilinks("")).toEqual([]);
    expect(extractWikilinks("[single bracket](url)")).toEqual([]);
  });

  it("does not match wikilinks that span line breaks", () => {
    const source = "[[Note\nwrapped]]";
    expect(extractWikilinks(source)).toEqual([]);
  });

  it("preserves source order", () => {
    const source = "Z [[A]] then [[B]] then [[C]]";
    const refs = extractWikilinks(source);
    expect(refs.map((r) => r.target)).toEqual(["A", "B", "C"]);
  });

  it("never throws on adversarial input", () => {
    const inputs = [
      "[[",
      "[[]]",
      "[[no closer",
      "[[Note|]]",
      "[[Note|||extra pipes]]",
      "[[Note##multiple-hash]]",
      "[[Note^^multiple-caret]]",
      "![",
      "![[",
      "![]]",
    ];
    for (const input of inputs) {
      expect(() => extractWikilinks(input)).not.toThrow();
    }
  });
});
