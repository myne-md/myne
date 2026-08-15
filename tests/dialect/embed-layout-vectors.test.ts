// Cross-implementation vector runner for the form-C embed layout segments
// (myne-md/myne#409 task 10).
//
// The grammar has TWO implementations and neither can detect drift from the
// other alone: the canonical parser is TypeScript in `@myne/dialect/embedLayout`
// (source-consumed by desktop, web and mobile), while the export transform is
// Rust in `myne-core`'s `rewrite_embeds_to_final_names`. This asserts the TS
// half against the shared vectors; `core/src/export_naming.rs` asserts the Rust
// half against the same file.
//
// The vectors live in the `myne-test-vectors` COMPANION repo, which is cloned
// beside this one by `workspace/setup.sh`. A clone that does not have it skips
// rather than fails: the companion is optional for a contributor who is not
// touching the dialect, and a hard failure there would be a false alarm about
// their environment rather than about the code.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEmbedAlias } from "@myne/dialect/embedLayout";
import { fromHex } from "./dialectSpans";

// Resolved against this file, not `process.cwd()`, matching every sibling
// vector runner: the skip-if-absent check must not depend on where vitest ran.
const VECTORS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/embed-layout/v0.1/cases.json",
);

interface VectorCase {
  vector_id: string;
  description: string;
  case_kind: string;
  input_alias_utf8_hex: string;
  informational_alias: string;
  expected_filename: string;
  expected_layout: {
    width_px: number | null;
    width_percent: number | null;
    height_px: number | null;
    align: string | null;
    alt: string | null;
  };
  expected_dropped: string[];
  expected_export_suffix: string;
}

const present = existsSync(VECTORS);
// `MYNE_VECTORS_REQUIRED=1` turns a missing companion into a loud failure
// instead of a green run that verified nothing, matching the Rust half and
// `protocol/tests/vectors.rs`. Without it this skips, because the companion is
// optional for a contributor not touching the dialect.
if (!present && process.env.MYNE_VECTORS_REQUIRED !== undefined) {
  throw new Error(`MYNE_VECTORS_REQUIRED is set but the embed-layout vectors are absent at ${VECTORS}`);
}
const cases: VectorCase[] = present
  ? (JSON.parse(readFileSync(VECTORS, "utf8")).cases as VectorCase[])
  : [];

describe.skipIf(!present)("embed-layout vectors (myne-test-vectors)", () => {
  it("loads a non-empty case set", () => {
    // A silently-empty vector file would make every assertion below vacuous,
    // which is the failure mode a vector runner is most prone to.
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.vector_id, c] as const))("%s", (_id, c) => {
    // The hex is the contract; the readable mirror is informational and is
    // cross-checked so a hand-edited case cannot drift from its own label.
    const alias = fromHex(c.input_alias_utf8_hex);
    expect(alias, `${c.vector_id}: informational_alias must mirror the hex`).toBe(
      c.informational_alias,
    );

    const parsed = parseEmbedAlias(alias);

    expect(parsed.filename, `${c.vector_id}: filename`).toBe(c.expected_filename);
    expect(parsed.layout.widthPx, `${c.vector_id}: width_px`).toBe(c.expected_layout.width_px);
    expect(parsed.layout.widthPercent, `${c.vector_id}: width_percent`).toBe(
      c.expected_layout.width_percent,
    );
    expect(parsed.layout.heightPx, `${c.vector_id}: height_px`).toBe(c.expected_layout.height_px);
    expect(parsed.layout.align, `${c.vector_id}: align`).toBe(c.expected_layout.align);
    expect(parsed.layout.alt, `${c.vector_id}: alt`).toBe(c.expected_layout.alt);
    expect(
      parsed.dropped.map((d) => d.source),
      `${c.vector_id}: dropped (reported segments only: an unrecognised key is silent)`,
    ).toEqual(c.expected_dropped);
  });
});
