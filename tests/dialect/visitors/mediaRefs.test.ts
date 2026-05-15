// MediaRef visitor — fixture-driven tests + invariants.
//
// Covers ONLY the markdown `![alt](src)` form. The `![[image.png]]`
// wikilink-embed form lives under `wikilinks` (Task 8) with
// `embed: true` and is NOT duplicated here.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractMediaRefs } from "../../../src/dialect/visitors/mediaRefs";
import { fixtureDir, listFixtureBasenames } from "../_helpers";

const FIXTURE_DIR = fixtureDir("media-refs");
const fixtures = listFixtureBasenames("media-refs");

describe("extractMediaRefs — fixtures", () => {
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
      expect(extractMediaRefs(source)).toEqual(expected);
    });
  }
});

describe("extractMediaRefs — invariants", () => {
  it("source.substring(byteRange) === raw for every emitted ref", () => {
    for (const name of fixtures) {
      const source = fs.readFileSync(
        path.join(FIXTURE_DIR, `${name}.md`),
        "utf-8",
      );
      for (const ref of extractMediaRefs(source)) {
        expect(source.substring(ref.byteRange.start, ref.byteRange.end))
          .toBe(ref.raw);
      }
    }
  });

  it("returns empty array for source with no media refs", () => {
    expect(extractMediaRefs("")).toEqual([]);
    expect(extractMediaRefs("plain text")).toEqual([]);
    expect(extractMediaRefs("[just a link](url)")).toEqual([]);
  });

  it("preserves source order", () => {
    const source = "![a](1.png) text ![b](2.png) more ![c](3.png)";
    const refs = extractMediaRefs(source);
    expect(refs.map((r) => r.alt)).toEqual(["a", "b", "c"]);
  });

  it("never throws on adversarial input", () => {
    const inputs = [
      "![",
      "![]",
      "![](",
      "![](url",
      "![alt]",
      "![alt](",
      "![[not-a-markdown-image]]",
    ];
    for (const input of inputs) {
      expect(() => extractMediaRefs(input)).not.toThrow();
    }
  });

  it("ignores LinkTitle component (src is the URL only)", () => {
    const source = '![alt](url "title here")';
    const refs = extractMediaRefs(source);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.src).toBe("url");
  });
});
