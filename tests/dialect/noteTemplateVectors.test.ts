// Cross-implementation conformance runner over the `note-template` category in
// the `myne-test-vectors` companion.
//
// The category existed with a Rust runner only (`protocol/tests/vectors.rs`,
// `note_template_vectors`), which pins `protocol/src/template.rs`. That engine
// serves exactly one shipped call site — the `myne daily` CLI path in
// `src-tauri/src/cli_bridge/daily.rs`. Every other render goes through the
// TypeScript twin in `dialect/src/templateEngine.ts`: new-note-from-template on
// desktop and web (`src/notes/newNoteFromTemplate.ts`) and the mobile daily-note
// path. The engine that renders most notes was the unvectored one.
//
// The two agree today — same single left-to-right pass, same first-`}}` lookup,
// same unknown-token-stays-literal rule, same five-token registry in the same
// order. This runner is what makes that a checked property instead of a
// coincidence, so a one-sided change reports itself as a disagreement with the
// published contract rather than shipping note bodies whose bytes depend on
// which client created them.
//
// Registry ORDER matters as well as membership: `editor/src/template-tokens`
// builds the `{{` autocomplete vocabulary from `SUPPORTED_TOKENS`, so the order
// is a user-visible contract on this side.
//
// Skip-if-missing, like the sibling runners: the companion is a separate repo
// and is not cloned by every job. These vectors are a contract document, not a
// CI gate — real local coverage is `tests/dialect/templateEngine.test.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  SUPPORTED_TOKENS,
  type RenderContext,
} from "../../dialect/src/templateEngine";

type RenderCase = {
  vector_id: string;
  case_kind: "render";
  input_template_utf8_hex: string;
  input_ctx_title_utf8_hex: string;
  input_ctx_date_utf8_hex: string;
  input_ctx_time_utf8_hex: string;
  input_ctx_datetime_utf8_hex: string;
  input_ctx_weekday_utf8_hex: string;
  // myne#177. Optional in the type because a case minted before the period
  // tokens existed carries neither field and uses neither token; the guard
  // below is what stops that leniency from covering a case that DOES use one.
  input_ctx_period_start_utf8_hex?: string;
  input_ctx_period_end_utf8_hex?: string;
  expected_output_utf8_hex: string;
};

type RegistryCase = {
  vector_id: string;
  case_kind: "token_registry";
  expected_tokens: string[];
};

type TemplateCase = RenderCase | RegistryCase;

const CASES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors/note-template/v0.1/cases.json",
);

// Hex → UTF-8. Every string in this category travels as hex precisely so a
// case carrying a non-ASCII byte, a lone `{`, or trailing whitespace cannot be
// mangled by an editor between the two runners.
function fromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function contextOf(c: RenderCase): RenderContext {
  return {
    title: fromHex(c.input_ctx_title_utf8_hex),
    date: fromHex(c.input_ctx_date_utf8_hex),
    time: fromHex(c.input_ctx_time_utf8_hex),
    datetime: fromHex(c.input_ctx_datetime_utf8_hex),
    weekday: fromHex(c.input_ctx_weekday_utf8_hex),
    periodStart: fromHex(c.input_ctx_period_start_utf8_hex ?? ""),
    periodEnd: fromHex(c.input_ctx_period_end_utf8_hex ?? ""),
  };
}

/** A case that USES a period token must PIN it, or the vector would be
 *  asserting against an empty string this runner invented rather than against
 *  published bytes (myne#177). */
function pinsEveryTokenItUses(c: RenderCase): string | null {
  const template = fromHex(c.input_template_utf8_hex);
  for (const [token, pinned] of [
    ["{{period_start}}", c.input_ctx_period_start_utf8_hex !== undefined],
    ["{{period_end}}", c.input_ctx_period_end_utf8_hex !== undefined],
  ] as const) {
    if (template.includes(token) && !pinned) return token;
  }
  return null;
}

const present = fs.existsSync(CASES_PATH);
if (!present) {
  console.warn(`[skip] note-template: companion repo fixture not present at ${CASES_PATH}`);
}
const doc: { schema: string; cases: TemplateCase[] } = present
  ? (JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as { schema: string; cases: TemplateCase[] })
  : { schema: "note-template", cases: [] };

const dv = present ? describe : describe.skip;

dv("note-template vectors", () => {
  it("reads the category from the companion repo", () => {
    expect(doc.schema).toBe("note-template");
    expect(doc.cases.length).toBeGreaterThan(0);
  });

  const renders = doc.cases.filter((c): c is RenderCase => c.case_kind === "render");
  const registries = doc.cases.filter(
    (c): c is RegistryCase => c.case_kind === "token_registry",
  );

  it("covers both case kinds", () => {
    expect(renders.length).toBeGreaterThan(0);
    expect(registries.length).toBeGreaterThan(0);
  });

  for (const c of renders) {
    it(`renders ${c.vector_id}`, () => {
      expect(pinsEveryTokenItUses(c)).toBeNull();
      expect(renderTemplate(fromHex(c.input_template_utf8_hex), contextOf(c))).toBe(
        fromHex(c.expected_output_utf8_hex),
      );
    });
  }

  for (const c of registries) {
    it(`advertises the registry in order — ${c.vector_id}`, () => {
      // Array equality, not set equality: the `{{` autocomplete lists tokens in
      // this order, so a reordering is a user-visible divergence even though
      // every render still agrees.
      expect([...SUPPORTED_TOKENS]).toEqual(c.expected_tokens);
    });
  }
});
