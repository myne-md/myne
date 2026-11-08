// markdown-comment golden vectors (MYND-315, editor-comments task 4).
//
// Cross-implementation conformance runner over the `markdown-comment` golden
// vectors in the `myne-test-vectors` companion — the second TS-side vector
// runner (after `property-coercion`; the `%%` recognizer + strip live TS-side,
// so there is no Rust generator). Each case hex-decodes a markdown source and
// pins (a) whether a `%%…%%` comment is recognized and (b) the canonical
// strip output (the byte ranges a lossy projection drops). Spec:
// agent-tooling/docs/spec/markdown-dialect.md §3.1 / §3.2 / §3.7.5 / §6.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasDialectComment,
  stripDialectComments,
} from "../../src/dialect/stripComments";

const CASES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/markdown-comment/v0.1/cases.json",
);

type Case = {
  vector_id: string;
  case_kind: "recognize" | "inert" | "exclusion";
  input_markdown_utf8_hex: string;
  informational_markdown: string;
  expected_has_comment: boolean;
  expected_stripped_utf8_hex: string;
  informational_stripped: string;
};

function fromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}
function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

// Skip-if-missing discipline, mirroring `protocol/tests/vectors.rs`: the
// `myne-test-vectors` companion repo is not checked out in main-repo CI, so the
// runner skips with an explanatory line rather than failing the suite on ENOENT.
const VECTORS_PRESENT = fs.existsSync(CASES_PATH);
if (!VECTORS_PRESENT) {
  console.warn(
    `[skip] markdown-comment: companion repo fixture not present at ${CASES_PATH}`,
  );
}
const describeVectors = VECTORS_PRESENT ? describe : describe.skip;

describeVectors("markdown-comment golden vectors (markdown-dialect §3.1/§3.2/§3.7.5/§6)", () => {
  const doc = VECTORS_PRESENT
    ? (JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as {
        schema: string;
        cases: Case[];
      })
    : { schema: "markdown-comment", cases: [] as Case[] };

  it("reads the markdown-comment category from the companion repo", () => {
    expect(doc.schema).toBe("markdown-comment");
    expect(doc.cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const c of doc.cases) {
    it(`pins ${c.vector_id}`, () => {
      const src = fromHex(c.input_markdown_utf8_hex);
      // informational mirror is byte-equal to the hex (the hex is the contract).
      expect(c.informational_markdown).toBe(src);
      // (a) recognition
      expect(hasDialectComment(src)).toBe(c.expected_has_comment);
      // (b) canonical strip output, byte-for-byte
      const stripped = stripDialectComments(src);
      expect(toHex(stripped)).toBe(c.expected_stripped_utf8_hex);
      expect(c.informational_stripped).toBe(fromHex(c.expected_stripped_utf8_hex));
    });
  }

  it("covers every case kind across the set", () => {
    const kinds = new Set(doc.cases.map((c) => c.case_kind));
    expect(kinds).toEqual(new Set(["recognize", "inert", "exclusion"]));
  });

  it("an inert / exclusion case never strips (output equals input)", () => {
    for (const c of doc.cases) {
      if (c.case_kind === "inert" || c.case_kind === "exclusion") {
        expect(c.expected_has_comment).toBe(false);
        expect(c.expected_stripped_utf8_hex).toBe(c.input_markdown_utf8_hex);
      }
    }
  });
});
