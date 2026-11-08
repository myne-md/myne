// Inline-tag visitor — fixture-driven tests + invariants.
//
// 4 grammar fixtures (boundary, numeric-only, nested-slash, unicode)
// plus 8 exclusion-zone fixtures (each expected to produce []).
// Spec: agent-tooling/docs/spec/markdown-dialect.md §3.7; grammar grounded in
// agent-tooling/researches/2026-05-09-obsidian-inline-tag-behavior.md.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractInlineTags } from "../../../src/dialect/visitors/inlineTags";
import { fixtureDir, listFixtureBasenames } from "../_helpers";

const FIXTURE_DIR = fixtureDir("inline-tags");
const fixtures = listFixtureBasenames("inline-tags");

describe("extractInlineTags — fixtures", () => {
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
      expect(extractInlineTags(source)).toEqual(expected);
    });
  }
});

describe("extractInlineTags — invariants", () => {
  it("source.substring(byteRange) === raw for every emitted tag", () => {
    for (const name of fixtures) {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, `${name}.md`),
        "utf-8",
      );
      for (const tag of extractInlineTags(source)) {
        expect(source.substring(tag.byteRange.start, tag.byteRange.end))
          .toBe(tag.raw);
      }
    }
  });

  it("returns empty array for source with no tags", () => {
    expect(extractInlineTags("")).toEqual([]);
    expect(extractInlineTags("plain paragraph")).toEqual([]);
    expect(extractInlineTags("# heading")).toEqual([]);
  });

  it("preserves source order", () => {
    const source = "first #a then #b then #c";
    const tags = extractInlineTags(source);
    expect(tags.map((t) => t.tag)).toEqual(["a", "b", "c"]);
  });

  it("never throws on adversarial input", () => {
    const inputs = [
      "#",
      "##",
      "###### heading",
      "#\n",
      "abc#nope",
      "#tag.",
      "#tag,",
      "#tag;",
      "#tag!",
    ];
    for (const input of inputs) {
      expect(() => extractInlineTags(input)).not.toThrow();
    }
  });

  it("tag string is verbatim un-normalized (no NFC, no case-fold)", () => {
    const source = "#Café";
    const tags = extractInlineTags(source);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("Café");
  });
});
