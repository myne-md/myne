// d1-clip-serializer golden vectors (capture-extraction task 11).
//
// Cross-implementation conformance runner over the `d1-clip-serializer` golden
// vectors in the `myne-test-vectors` companion — a TS-side vector runner (after
// `property-coercion` + `markdown-comment`; the serializer lives TS-side, so
// there is no Rust generator). Each case hex-decodes a Defuddle-style markdown
// source and pins the byte-exact canonical-D1 output the live
// `serializeClipMarkdown` (src/dialect/clip.ts) emits. A clip is AUTHORED
// canonical-D1 (SYNC-7), so the serializer re-authors recognized-on-parse
// non-canonical forms (Setext→ATX, ref-link→inline, etc.) rather than preserving
// them — the divergence-prone behavior these vectors guard.
// Spec: agent-tooling/docs/spec/markdown-dialect.md §5 (canonical emit forms) / §6 (round-trip).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializeClipMarkdown } from "../../src/dialect/clip";
import { parser } from "../../src/dialect/lezer/parser";

const CASES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/d1-clip-serializer/v0.1/cases.json",
);

type Kind = "floor" | "wedge" | "normalize" | "degrade" | "math";

type Case = {
  vector_id: string;
  case_kind: Kind;
  input_markdown_utf8_hex: string;
  informational_markdown: string;
  expected_canonical_d1_utf8_hex: string;
  informational_canonical_d1?: string;
};

const ALL_KINDS: ReadonlySet<Kind> = new Set([
  "floor",
  "wedge",
  "normalize",
  "degrade",
  "math",
]);

function fromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}
function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}

// Skip-if-missing discipline, mirroring `tests/dialect/markdownComment.test.ts`:
// the `myne-test-vectors` companion repo is not checked out in main-repo CI, so
// the runner skips with an explanatory line rather than failing on ENOENT.
const VECTORS_PRESENT = fs.existsSync(CASES_PATH);
if (!VECTORS_PRESENT) {
  console.warn(
    `[skip] d1-clip-serializer: companion repo fixture not present at ${CASES_PATH}`,
  );
}
const describeVectors = VECTORS_PRESENT ? describe : describe.skip;

describeVectors("d1-clip-serializer golden vectors (markdown-dialect §5/§6)", () => {
  const doc = VECTORS_PRESENT
    ? (JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as {
        schema: string;
        cases: Case[];
      })
    : { schema: "d1-clip-serializer", cases: [] as Case[] };

  it("reads the d1-clip-serializer category from the companion repo", () => {
    expect(doc.schema).toBe("d1-clip-serializer");
    expect(doc.cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of doc.cases) {
    it(`pins ${c.vector_id}`, () => {
      const src = fromHex(c.input_markdown_utf8_hex);
      // informational mirror is byte-equal to the hex (the hex is the contract).
      expect(c.informational_markdown).toBe(src);
      // The live serializer's output bytes must equal the pinned canonical-D1.
      const out = serializeClipMarkdown(src);
      expect(toHex(out)).toBe(c.expected_canonical_d1_utf8_hex);
      if (c.informational_canonical_d1 !== undefined) {
        expect(c.informational_canonical_d1).toBe(
          fromHex(c.expected_canonical_d1_utf8_hex),
        );
      }
    });
  }

  it("covers every case kind across the set", () => {
    const kinds = new Set(doc.cases.map((c) => c.case_kind));
    expect(kinds).toEqual(new Set(ALL_KINDS));
  });

  it("covers the fidelity floor (table + code + math) and the math subset", () => {
    // The floor is the hard pin (PRD: faithful tables/code/math); the `math`
    // subset is the seed task 12 extends with the dedicated `$`-tokenizer cases.
    expect(doc.cases.some((c) => c.case_kind === "floor")).toBe(true);
    expect(doc.cases.some((c) => c.case_kind === "math")).toBe(true);
    expect(doc.cases.some((c) => c.vector_id.includes("table"))).toBe(true);
    expect(doc.cases.some((c) => c.vector_id.includes("code"))).toBe(true);
    expect(
      doc.cases.some((c) => c.case_kind === "math" && c.vector_id.includes("math")),
    ).toBe(true);
  });

  // Task-12 math coverage guard: the dedicated `$`-tokenizer subset must stay
  // present. This fails if a math vector is DROPPED (the whole point of the pin
  // — a regression that stops emitting tokenizer-legal `$…$` must surface as a
  // failing vector, not as a user whose equations render as literal dollars).
  // The guard asserts both a floor on the math case count AND the presence of
  // each load-bearing shape the subset exists to pin (§3.2 / §5, story 11).
  it("pins the dedicated `$`-tokenizer math subset (task-12 coverage guard)", () => {
    const math = doc.cases.filter((c) => c.case_kind === "math");
    // 3 seed (task 11) + 12 dedicated (task 12) = 15; a drop trips this floor.
    expect(math.length).toBeGreaterThanOrEqual(15);

    const id = (slug: string): boolean =>
      math.some((c) => c.vector_id === `d1-clip-serializer/v0.1/${slug}`);

    // Tokenizer-legal inline `$…$` round-trips (opener not whitespace/digit,
    // closer not space-preceded, single-line).
    expect(id("math-inline-legal-pythagorean")).toBe(true);
    expect(id("math-inline-legal-fraction")).toBe(true);
    // The §3.2 disambiguation illegality cases (opener-space, opener-digit,
    // closer-space) stay literal text, never a mis-parseable span.
    expect(id("math-inline-opener-space-literal")).toBe(true);
    expect(id("math-inline-opener-digit-literal")).toBe(true);
    expect(id("math-inline-closer-space-literal")).toBe(true);
    // Line-crossing inline cannot form math (§3.2).
    expect(id("math-inline-line-cross-collapsed")).toBe(true);
    // Block `$$…$$` round-trips through the D1 tokenizer.
    expect(id("math-block-sum-roundtrip")).toBe(true);
    expect(id("math-block-aligned-multiline")).toBe(true);
    // Currency in prose never opens math (the load-bearing `$5`/`$ 5`/`$10.00`
    // guard).
    expect(id("math-currency-dollar-digit-literal")).toBe(true);
    expect(id("math-currency-space-digit-literal")).toBe(true);
    expect(id("math-currency-decimal-literal")).toBe(true);
    // The degrade-to-inert path: un-representable math → backslash-escaped `\$`
    // literal text that re-parses as text, never a `$…$` span (story 11).
    expect(id("math-inline-interior-dollar-degraded")).toBe(true);

    // Every degrade/inert math case must re-parse to ZERO `InlineMath` nodes —
    // the bytes are literal text, never a tokenizer-illegal span a reader would
    // mis-render as dollar-text. (Legal cases are covered by the per-case pins.)
    const inertSlugs = [
      "math-inline-opener-space-literal",
      "math-inline-opener-digit-literal",
      "math-inline-closer-space-literal",
      "math-currency-dollar-digit-literal",
      "math-currency-space-digit-literal",
      "math-currency-decimal-literal",
      "math-inline-interior-dollar-degraded",
    ];
    for (const slug of inertSlugs) {
      const c = math.find(
        (m) => m.vector_id === `d1-clip-serializer/v0.1/${slug}`,
      );
      expect(c, `missing math case ${slug}`).toBeDefined();
      const out = fromHex(c!.expected_canonical_d1_utf8_hex);
      let inlineMath = 0;
      parser.parse(out).topNode.cursor().iterate((node) => {
        if (node.name === "InlineMath") inlineMath++;
      });
      expect(inlineMath, `${slug} must emit no InlineMath span`).toBe(0);
    }
  });

  it("every pinned output is a serializer fixed point (idempotent)", () => {
    // A clip's canonical-D1 output is, by construction, a fixed point of the
    // serializer — re-serializing it yields the same bytes (story 18).
    for (const c of doc.cases) {
      const once = fromHex(c.expected_canonical_d1_utf8_hex);
      expect(serializeClipMarkdown(once)).toBe(once);
    }
  });
});
