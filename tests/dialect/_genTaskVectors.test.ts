// Generator for the two TASK vector categories in the `myne-test-vectors`
// companion — `task-inline-format` (MYND-611 task 8) and `task-recurrence`
// (MYND-615 task 14).
//
// The TS-side analogue of the protocol crate's `#[ignore]`-gated generators, and
// the twin of `_genDialectVectors.test.ts`: regenerating vectors is a deliberate
// act, so the body only runs with GEN_TASK_VECTORS=1 in the environment.
//
//   GEN_TASK_VECTORS=1 pnpm vitest run tests/dialect/_genTaskVectors.test.ts
//
// Every case self-validates at mint — an `inert` case that produced spans, or a
// recognized rule that advanced nothing, throws here rather than shipping a
// vector that asserts the wrong thing. The live runner is `taskVectors.test.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  buildInlineFormatCase,
  buildQueryVectorCase,
  buildRecurrenceCase,
  INLINE_FORMAT_SPECS,
  QUERY_VECTOR_SPECS,
  RECURRENCE_SPECS,
} from "./taskVectorCases";

const VECTORS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors",
);

const INLINE_FORMAT_DESCRIPTION =
  "Pins the Myne dialect task-field extension (dialect/src/lezer/task-field.ts + taskFields.ts + " +
  "taskFieldWriter.ts) across all THREE read dialects and the ONE emitted form. Each case carries " +
  "the recognized spans (UTF-8 byte offsets, pre-order), the typed record, and the line as Myne " +
  "would write it. Emoji markers are surrogate pairs in UTF-16 and four bytes in UTF-8, so the " +
  "byte-offset convention is load-bearing rather than cosmetic. `inert` cases are near-misses the " +
  "recognizer must NOT claim. TS-runner category (no Rust generator).";

const QUERY_DESCRIPTION =
  "Pins the closed task-query grammar (src/notes/taskQuery.ts) — BOTH what it accepts and what it " +
  "refuses. A parse-only vector set would still pass for a port that accepted one extra clause, so " +
  "the drop cases carry the closedness claim: all three function-valued forms, a field name in a " +
  "value position (the boundary rule — a field name may never appear where a value goes), " +
  "arithmetic over a field, and out-of-roster words. The `refuse` cases pin the widen guard: an " +
  "all-dropped query must NOT collapse to matching everything, while a genuinely empty query is " +
  "legitimately unfiltered. TS-runner category (no Rust generator).";

const RECURRENCE_DESCRIPTION =
  "Pins the recurrence vocabulary and its civil-date arithmetic (dialect/src/recurrence.ts + " +
  "civilDate.ts) so every client computes identical next dates. Covers both anchoring modes, both " +
  "rule families, month-end clamping, the leap day, the stale-date catch-up, the reminder " +
  "co-advance, and unrecognized rules. All arithmetic is over civil year/month/day fields anchored " +
  "to UTC and is therefore DST-independent — a port that forms a local instant will disagree on " +
  "the transition cases. TS-runner category (no Rust generator).";

function writeCategory(category: string, specSection: string, description: string, cases: unknown[]) {
  const dir = path.join(VECTORS_DIR, category, "v0.1");
  fs.mkdirSync(dir, { recursive: true });
  const doc = {
    schema: category,
    protocol_version: "v0.1",
    spec_section: specSection,
    description,
    cases,
  };
  fs.writeFileSync(path.join(dir, "cases.json"), `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  return doc.cases.length;
}

const gen = process.env.GEN_TASK_VECTORS === "1" ? describe : describe.skip;

gen("generate task vector categories", () => {
  it("writes task-inline-format/v0.1/cases.json", () => {
    const cases = INLINE_FORMAT_SPECS.map((spec) => {
      const c = buildInlineFormatCase(spec);
      // Self-validation at mint, mirroring the Rust generators.
      if (c.case_kind === "inert" && c.expected_dialect_spans.length !== 0) {
        throw new Error(`[${c.vector_id}] inert case produced spans`);
      }
      if (c.case_kind !== "inert" && c.expected_dialect_spans.length === 0) {
        throw new Error(`[${c.vector_id}] non-inert case produced no spans`);
      }
      if (c.case_kind === "malformed" && c.expected_fields.malformed.length === 0) {
        throw new Error(`[${c.vector_id}] malformed case typed cleanly`);
      }
      if (c.case_kind === "preserve" && c.expected_fields.preserved.length === 0) {
        throw new Error(`[${c.vector_id}] preserve case preserved nothing`);
      }
      return c;
    });
    const n = writeCategory(
      "task-inline-format",
      "markdown-dialect.md §3.8 (inline task fields)",
      INLINE_FORMAT_DESCRIPTION,
      cases,
    );
    console.warn(`[gen] task-inline-format: ${n} cases`);
  });

  it("writes task-recurrence/v0.1/cases.json", () => {
    const cases = RECURRENCE_SPECS.map((spec) => {
      const c = buildRecurrenceCase(spec);
      if (c.case_kind === "advance" && c.expected_due === undefined && c.expected_remind === undefined) {
        throw new Error(`[${c.vector_id}] recognized rule advanced nothing`);
      }
      if (c.case_kind === "unrecognized" && c.expected_rule_recognized) {
        throw new Error(`[${c.vector_id}] unrecognized case parsed`);
      }
      return c;
    });
    const n = writeCategory(
      "task-recurrence",
      "markdown-dialect.md §3.8.7 (recurrence rule vocabulary)",
      RECURRENCE_DESCRIPTION,
      cases,
    );
    console.warn(`[gen] task-recurrence: ${n} cases`);
  });

  it("writes task-query-grammar/v0.1/cases.json", () => {
    const cases = QUERY_VECTOR_SPECS.map((spec) => {
      const c = buildQueryVectorCase(spec);
      // Self-validation at mint. Each case_kind carries a claim; a case that
      // does not exhibit it would ship a vector asserting the wrong thing.
      if (c.case_kind === "parse" && c.expected_dropped.length > 0) {
        throw new Error(`[${c.vector_id}] parse case dropped a clause`);
      }
      if (c.case_kind === "drop" && c.expected_dropped.length === 0) {
        throw new Error(`[${c.vector_id}] drop case dropped nothing`);
      }
      if (c.case_kind === "drop" && c.expected_refused) {
        throw new Error(`[${c.vector_id}] drop case refused — it should keep working`);
      }
      if (c.case_kind === "refuse" && !c.expected_refused) {
        throw new Error(`[${c.vector_id}] refuse case did not refuse`);
      }
      return c;
    });
    const n = writeCategory(
      "task-query-grammar",
      "markdown-dialect.md §3.9 (task-query block roster)",
      QUERY_DESCRIPTION,
      cases,
    );
    console.warn(`[gen] task-query-grammar: ${n} cases`);
  });
});
