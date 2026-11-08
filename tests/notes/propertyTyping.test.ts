// Property value-typing tests (MYND-271, property-index #1). The bulk is a
// cross-implementation conformance runner over the `property-coercion` golden
// vectors in the `myne-test-vectors` companion — the FIRST TS-side vector
// runner (the coercion is Build-B TS, so there is no Rust generator/runner for
// this category). Plus unit coverage of `extractProperties` over raw
// frontmatter. Spec: `myne-agents/docs/spec/markdown-dialect.md` §3.6.4.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SCHEMA, load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  coerceValue,
  extractProperties,
  type ScalarProperty,
} from "../../src/notes/propertyTyping";

const CASES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/property-coercion/v0.1/cases.json",
);

type ScalarCase = {
  vector_id: string;
  case_kind: "scalar";
  input_yaml_utf8_hex: string;
  expected_type: ScalarProperty["type"];
  expected_normalized_utf8_hex: string;
};
type ListElement = { element_type: ScalarProperty["type"]; element_normalized_utf8_hex: string };
type ListCase = {
  vector_id: string;
  case_kind: "list";
  input_yaml_utf8_hex: string;
  expected_elements: ListElement[];
};
type Case = ScalarCase | ListCase;

function fromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}

/** Parse the case's one-key `prop: <value>` YAML (CORE schema, exactly as the
 *  production extractor does) and return the coerced value of `prop`. */
function coerceCaseInput(inputYamlHex: string): ReturnType<typeof coerceValue> {
  const doc = loadYaml(fromHex(inputYamlHex), { schema: CORE_SCHEMA }) as Record<
    string,
    unknown
  >;
  return coerceValue(doc.prop);
}

// Skip-if-missing discipline, mirroring `protocol/tests/vectors.rs`: the
// `myne-test-vectors` companion repo is not checked out in main-repo CI, so the
// runner skips with an explanatory line rather than failing the suite on ENOENT.
const VECTORS_PRESENT = fs.existsSync(CASES_PATH);
if (!VECTORS_PRESENT) {
  console.warn(
    `[skip] property-coercion: companion repo fixture not present at ${CASES_PATH}`,
  );
}
const describeVectors = VECTORS_PRESENT ? describe : describe.skip;

describeVectors("property-coercion golden vectors (markdown-dialect §3.6.4)", () => {
  const doc = VECTORS_PRESENT
    ? (JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as {
        schema: string;
        cases: Case[];
      })
    : { schema: "property-coercion", cases: [] as Case[] };

  it("reads the property-coercion category from the companion repo", () => {
    expect(doc.schema).toBe("property-coercion");
    // Coverage floor — the load-bearing tie-breaks must all be present.
    expect(doc.cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const c of doc.cases) {
    it(`pins ${c.vector_id}`, () => {
      const coerced = coerceCaseInput(c.input_yaml_utf8_hex);
      if (c.case_kind === "scalar") {
        expect(coerced.type).toBe(c.expected_type);
        // Narrow to ScalarProperty (mirrors the list branch's guard) so a
        // type drift fails loudly rather than degrading to a null comparison.
        if (coerced.type === "list") {
          throw new Error(`${c.vector_id}: expected a scalar, got a list`);
        }
        expect(coerced.value).toBe(fromHex(c.expected_normalized_utf8_hex));
      } else {
        expect(coerced.type).toBe("list");
        if (coerced.type !== "list") return; // type-narrow for TS
        expect(coerced.elements.length).toBe(c.expected_elements.length);
        c.expected_elements.forEach((expected, i) => {
          expect(coerced.elements[i].type).toBe(expected.element_type);
          expect(coerced.elements[i].value).toBe(
            fromHex(expected.element_normalized_utf8_hex),
          );
        });
      }
    });
  }

  it("covers every scalar type + list across the set", () => {
    const types = new Set<string>();
    for (const c of doc.cases) {
      if (c.case_kind === "scalar") types.add(c.expected_type);
      else types.add("list");
    }
    expect(types).toEqual(new Set(["string", "number", "date", "checkbox", "list"]));
  });
});

describe("extractProperties (raw frontmatter → typed entries)", () => {
  it("returns [] for absent / empty / non-mapping / malformed frontmatter", () => {
    expect(extractProperties(null)).toEqual([]);
    expect(extractProperties("")).toEqual([]);
    expect(extractProperties("- just\n- a\n- list")).toEqual([]); // top-level seq
    expect(extractProperties("just a scalar")).toEqual([]); // top-level scalar
    expect(extractProperties("key: : : broken")).toEqual([]); // YAML error
  });

  it("types every arbitrary key, including the five managed fields (observed, not excluded)", () => {
    const fm = [
      "title: My Note",
      "folder: Projects/",
      "status: in-progress",
      "rating: 4",
      "done: true",
      "due: 2026-06-14",
      "tags: [a, b]",
      'trashed: "2026-06-01T00:00:00Z"',
      "template: true",
    ].join("\n");
    const props = extractProperties(fm);
    const byKey = Object.fromEntries(props.map((p) => [p.key, p]));
    expect(byKey.status).toMatchObject({ type: "string", value: "in-progress" });
    expect(byKey.rating).toMatchObject({ type: "number", value: "4" });
    expect(byKey.done).toMatchObject({ type: "checkbox", value: "true" });
    expect(byKey.due).toMatchObject({ type: "date", value: "2026-06-14" });
    expect(byKey.tags).toMatchObject({ type: "list" });
    // Managed fields are observed with value-strict semantics intact.
    expect(byKey.template).toMatchObject({ type: "checkbox", value: "true" });
    expect(byKey.trashed).toMatchObject({ type: "date" }); // RFC 3339 → date
    expect(byKey.title).toMatchObject({ type: "string", value: "My Note" });
  });

  it("does not unicode-normalize string values (NFD preserved)", () => {
    // 'cafe' + combining acute (NFD) — must round-trip byte-for-byte.
    const nfd = "café";
    const props = extractProperties(`place: ${nfd}`);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ key: "place", type: "string", value: nfd });
  });
});
