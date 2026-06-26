// Cross-implementation conformance runner over the six dialect
// parse-recognition vector categories (footnote / highlight / wikilink /
// definition-list / inline-tag / math) in the `myne-test-vectors` companion.
//
// Each case hex-decodes a markdown source and pins the byte ranges (UTF-8
// offsets) the Myne dialect parser recognizes as that construct's nodes. A
// recognize case carries the spans; an inert case carries an empty list (a
// near-miss the parser must NOT recognize). The runner re-derives the spans
// from the live parser (`src/dialect/lezer/parser.ts`) via the shared
// `extractSpans` helper and asserts byte-exact equality.
//
// Regenerate via `_genDialectVectors.test.ts` (GEN_DIALECT_VECTORS=1).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSpans, fromHex, NODE_SETS, type DialectSpan } from "./dialectSpans";

type Case = {
  vector_id: string;
  case_kind: "recognize" | "inert";
  input_markdown_utf8_hex: string;
  informational_markdown: string;
  expected_dialect_spans: DialectSpan[];
};

const VECTORS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors",
);

for (const category of Object.keys(NODE_SETS)) {
  const casesPath = path.join(VECTORS_DIR, category, "v0.1", "cases.json");
  const present = fs.existsSync(casesPath);
  if (!present) {
    console.warn(`[skip] ${category}: companion repo fixture not present at ${casesPath}`);
  }
  const dv = present ? describe : describe.skip;

  dv(`${category} dialect parse-recognition vectors`, () => {
    const doc = present
      ? (JSON.parse(fs.readFileSync(casesPath, "utf-8")) as { schema: string; cases: Case[] })
      : { schema: category, cases: [] as Case[] };

    it("reads the category from the companion repo", () => {
      expect(doc.schema).toBe(category);
      expect(doc.cases.length).toBeGreaterThan(0);
    });

    for (const c of doc.cases) {
      it(`pins ${c.vector_id}`, () => {
        const src = fromHex(c.input_markdown_utf8_hex);
        // informational mirror is byte-equal to the hex (the hex is the contract).
        expect(c.informational_markdown).toBe(src);
        const actual = extractSpans(src, category);
        expect(actual).toEqual(c.expected_dialect_spans);
        // inert cases must recognize nothing.
        if (c.case_kind === "inert") {
          expect(actual).toHaveLength(0);
        } else {
          expect(actual.length).toBeGreaterThan(0);
        }
      });
    }

    it("covers both recognize and inert case kinds", () => {
      const kinds = new Set(doc.cases.map((c) => c.case_kind));
      expect(kinds.has("recognize")).toBe(true);
      expect(kinds.has("inert")).toBe(true);
    });
  });
}
