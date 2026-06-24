// Cross-implementation conformance runner over the `frontmatter-surgery` vector
// category in the `myne-test-vectors` companion. Each case hex-decodes a note
// plaintext, applies the case_kind's frontmatter field patcher (the live
// functions in src/dialect/surgery.ts), and asserts byte-exact output. Also
// re-checks the at-mint invariants (idempotency + purity) against the live code.
//
// Regenerate via `_genFrontmatterSurgeryVectors.test.ts` (GEN_FM_SURGERY=1).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  patchArchivedField,
  patchFolderField,
  patchFolderIndexField,
  patchFrontmatterField,
  patchTemplateField,
  patchTitleField,
  patchTrashedField,
  patchUpdatedField,
} from "../../src/dialect/surgery";

type Kind =
  | "updated"
  | "title"
  | "folder"
  | "trashed"
  | "archived"
  | "template"
  | "folder-index"
  | "generic";

type Case = {
  vector_id: string;
  case_kind: Kind;
  input_plaintext_utf8_hex: string;
  informational_plaintext: string;
  input_iso?: string;
  input_flag?: boolean;
  input_key?: string;
  input_value_utf8_hex?: string;
  expected_output_utf8_hex: string;
  informational_output: string;
};

const CASES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/frontmatter-surgery/v0.1/cases.json",
);

const fromHexBytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const fromHexStr = (h: string) => Buffer.from(h, "hex").toString("utf8");
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function apply(c: Case, bytes: Uint8Array): Uint8Array {
  // A nullable patcher gets `null` when input_value_utf8_hex is absent.
  const value = c.input_value_utf8_hex !== undefined ? fromHexStr(c.input_value_utf8_hex) : null;
  switch (c.case_kind) {
    case "updated":
      return patchUpdatedField(bytes, c.input_iso as string);
    case "title":
      return patchTitleField(bytes, value as string);
    case "folder":
      return patchFolderField(bytes, value);
    case "trashed":
      return patchTrashedField(bytes, value);
    case "archived":
      return patchArchivedField(bytes, value);
    case "template":
      return patchTemplateField(bytes, value);
    case "folder-index":
      return patchFolderIndexField(bytes, c.input_flag as boolean);
    case "generic":
      return patchFrontmatterField(bytes, c.input_key as string, value);
  }
}

const present = fs.existsSync(CASES_PATH);
if (!present) {
  console.warn(`[skip] frontmatter-surgery: companion repo fixture not present at ${CASES_PATH}`);
}
const dv = present ? describe : describe.skip;

dv("frontmatter-surgery golden vectors (src/dialect/surgery.ts)", () => {
  const doc = present
    ? (JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as { schema: string; cases: Case[] })
    : { schema: "frontmatter-surgery", cases: [] as Case[] };

  it("reads the category from the companion repo", () => {
    expect(doc.schema).toBe("frontmatter-surgery");
    expect(doc.cases.length).toBeGreaterThan(0);
  });

  for (const c of doc.cases) {
    it(`pins ${c.vector_id}`, () => {
      const input = fromHexBytes(c.input_plaintext_utf8_hex);
      // informational mirrors are byte-equal to the hex (the hex is the contract).
      expect(c.informational_plaintext).toBe(fromHexStr(c.input_plaintext_utf8_hex));
      expect(c.informational_output).toBe(fromHexStr(c.expected_output_utf8_hex));

      const snapshot = Uint8Array.from(input);
      const out = apply(c, input);
      expect(toHex(out)).toBe(c.expected_output_utf8_hex);
      // Purity: the input buffer is untouched.
      expect(toHex(input)).toBe(toHex(snapshot));
      // Idempotency: re-applying is a fixed point.
      expect(toHex(apply(c, out))).toBe(c.expected_output_utf8_hex);
    });
  }

  it("covers every patcher (all eight case kinds)", () => {
    const kinds = new Set(doc.cases.map((c) => c.case_kind));
    expect(kinds).toEqual(
      new Set([
        "updated",
        "title",
        "folder",
        "trashed",
        "archived",
        "template",
        "folder-index",
        "generic",
      ]),
    );
  });
});
