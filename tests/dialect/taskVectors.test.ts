// Cross-implementation conformance runner over the two TASK vector categories
// in the `myne-test-vectors` companion — `task-inline-format` (MYND-611 task 8)
// and `task-recurrence` (MYND-615 task 14).
//
// The runner re-derives every expected value from the LIVE implementation and
// asserts byte-exact equality, so a change to the parser, the writer, the rule
// vocabulary or the arithmetic reports itself here as a disagreement with the
// published contract rather than silently shipping.
//
// Skip-if-missing, like `dialectParse.test.ts`: the companion is a separate repo
// and is not cloned by every job. Worth stating plainly — **these vectors are a
// contract document, not a CI gate.** The vector step is commented out in CI and
// the unit-test job does not clone the companion, so real coverage comes from
// the local suites (`taskFields.test.ts`, `taskFieldWriter.test.ts`,
// `recurrence.test.ts`, `recurrenceAdvance.test.ts`, `civilDate.test.ts`).
//
// Regenerate via `_genTaskVectors.test.ts` (GEN_TASK_VECTORS=1).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTaskFields } from "../../src/dialect/taskFields";
import {
  formatRecurrenceSpec,
  parseRecurrenceSpec,
  recurrenceFamily,
} from "../../src/dialect/recurrence";
import {
  advancePair,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "../../src/dialect/civilDate";
import { parseTaskQuery } from "../../src/notes/taskQuery";
import {
  emittedLine,
  fromHex,
  taskFieldSpans,
  toVectorFields,
  type InlineFormatCase,
  type QueryVectorCase,
  type RecurrenceCase,
} from "./taskVectorCases";

const VECTORS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors",
);

function load<T>(category: string): { present: boolean; doc: { schema: string; cases: T[] } } {
  const casesPath = path.join(VECTORS_DIR, category, "v0.1", "cases.json");
  if (!fs.existsSync(casesPath)) {
    console.warn(`[skip] ${category}: companion repo fixture not present at ${casesPath}`);
    return { present: false, doc: { schema: category, cases: [] } };
  }
  return {
    present: true,
    doc: JSON.parse(fs.readFileSync(casesPath, "utf-8")) as { schema: string; cases: T[] },
  };
}

function civil(value: string): CivilDate {
  const parsed = parseCivilDate(value);
  if (parsed === null) throw new Error(`vector carries an impossible date: ${value}`);
  return parsed;
}

// --- task-inline-format ------------------------------------------------------

{
  const { present, doc } = load<InlineFormatCase>("task-inline-format");
  const dv = present ? describe : describe.skip;

  dv("task-inline-format vectors", () => {
    it("reads the category from the companion repo", () => {
      expect(doc.schema).toBe("task-inline-format");
      expect(doc.cases.length).toBeGreaterThan(0);
    });

    for (const c of doc.cases) {
      it(`pins ${c.vector_id}`, () => {
        const src = fromHex(c.input_markdown_utf8_hex);
        // The hex IS the contract; the informational mirror must agree with it.
        expect(c.informational_markdown).toBe(src);
        expect(c.informational_emitted).toBe(fromHex(c.expected_emitted_utf8_hex));

        // 1. Recognition — which byte ranges are which node.
        expect(taskFieldSpans(src)).toEqual(c.expected_dialect_spans);
        // 2. Typing — the record the three dialects all collapse into.
        expect(toVectorFields(parseTaskFields(src))).toEqual(c.expected_fields);
        // 3. Emission — the one form Myne writes.
        expect(emittedLine(src)).toBe(c.informational_emitted);

        if (c.case_kind === "inert") expect(c.expected_dialect_spans).toHaveLength(0);
      });
    }

    it("covers all three read dialects, the emitted form, preservation and near-misses", () => {
      const kinds = new Set(doc.cases.map((c) => c.case_kind));
      for (const required of ["dataview", "emoji", "myne", "mixed", "preserve", "malformed", "inert"]) {
        expect(kinds.has(required as InlineFormatCase["case_kind"])).toBe(true);
      }
    });

    it("pins the emitted form as a FIXED POINT — re-emitting changes nothing", () => {
      // §6 C1: opening a vault must not dirty its task lines. Every emitted line
      // in the corpus is fed back through the writer and must come out identical.
      for (const c of doc.cases) {
        const once = c.informational_emitted;
        expect(emittedLine(once)).toBe(once);
      }
    });

    it("never loses a recognized field across the rewrite", () => {
      // The preservation obligation, checked over the whole corpus rather than
      // case by case: every preserved key present before the rewrite is present
      // after it. This is what stops a whole-line rewrite from destroying data
      // Myne did not understand.
      for (const c of doc.cases) {
        const before = parseTaskFields(fromHex(c.input_markdown_utf8_hex));
        const after = parseTaskFields(c.informational_emitted);
        expect(after.preserved.map((f) => f.key).sort()).toEqual(
          before.preserved.map((f) => f.key).sort(),
        );
        expect(after.malformed.map((f) => f.key).sort()).toEqual(
          before.malformed.map((f) => f.key).sort(),
        );
      }
    });
  });
}

// --- task-recurrence ---------------------------------------------------------

{
  const { present, doc } = load<RecurrenceCase>("task-recurrence");
  const dv = present ? describe : describe.skip;

  dv("task-recurrence vectors", () => {
    it("reads the category from the companion repo", () => {
      expect(doc.schema).toBe("task-recurrence");
      expect(doc.cases.length).toBeGreaterThan(0);
    });

    for (const c of doc.cases) {
      it(`pins ${c.vector_id}`, () => {
        const parsed = parseRecurrenceSpec(c.rule);
        expect(parsed.ok).toBe(c.expected_rule_recognized);

        if (!parsed.ok) {
          // The load-bearing negative: an unrecognized rule resolves to NOTHING.
          // A port that quietly falls back to "every day" fails right here.
          expect(c.case_kind).toBe("unrecognized");
          expect(c.expected_due).toBeUndefined();
          expect(c.expected_remind).toBeUndefined();
          return;
        }

        expect(formatRecurrenceSpec(parsed.spec)).toBe(c.expected_canonical_rule);
        expect(parsed.spec.mode).toBe(c.expected_mode);
        expect(recurrenceFamily(parsed.spec.rule)).toBe(c.expected_family);

        const advanced = advancePair(parsed.spec, {
          due: c.due === undefined ? undefined : civil(c.due),
          remind: c.remind === undefined ? undefined : civil(c.remind),
          today: civil(c.today),
        });
        expect(advanced.due === undefined ? undefined : formatCivilDate(advanced.due)).toBe(
          c.expected_due,
        );
        expect(advanced.remind === undefined ? undefined : formatCivilDate(advanced.remind)).toBe(
          c.expected_remind,
        );
      });
    }

    it("covers both anchoring modes", () => {
      const modes = new Set(doc.cases.map((c) => c.expected_mode).filter(Boolean));
      expect(modes.has("due")).toBe(true);
      expect(modes.has("completion")).toBe(true);
    });

    it("covers both rule families", () => {
      const families = new Set(doc.cases.map((c) => c.expected_family).filter(Boolean));
      expect(families.has("interval")).toBe(true);
      expect(families.has("calendar")).toBe(true);
    });

    it("covers month-end, the leap day, the stale catch-up and the reminder co-advance", () => {
      const ids = doc.cases.map((c) => c.vector_id).join(" ");
      expect(ids).toContain("interval-monthly-clamps-into-february");
      expect(ids).toContain("calendar-day-of-month-returns-to-nominal");
      expect(ids).toContain("interval-yearly-leap-day-clamps");
      expect(ids).toContain("advance-stale-monthly-keeps-the-anchor");
      expect(ids).toContain("reminder-gap-is-carried");
      expect(doc.cases.some((c) => c.case_kind === "unrecognized")).toBe(true);
    });

    it("every advance lands strictly after today", () => {
      // Nothing may resolve to today or to the past: the advance rule's own
      // guarantee, checked over the whole corpus rather than argued for.
      for (const c of doc.cases) {
        if (c.case_kind !== "advance") continue;
        const anchor = c.expected_due ?? c.expected_remind;
        if (anchor === undefined) continue;
        expect(anchor > c.today).toBe(true);
      }
    });
  });
}

// --- task-query-grammar ------------------------------------------------------

{
  const { present, doc } = load<QueryVectorCase>("task-query-grammar");
  const dv = present ? describe : describe.skip;

  dv("task-query-grammar vectors", () => {
    it("reads the category from the companion repo", () => {
      expect(doc.schema).toBe("task-query-grammar");
      expect(doc.cases.length).toBeGreaterThan(0);
    });

    for (const c of doc.cases) {
      it(`pins ${c.vector_id}`, () => {
        const parsed = parseTaskQuery(c.query);
        expect(parsed.clauses.map((clause) => clause.kind)).toEqual(c.expected_clause_kinds);
        expect(parsed.warnings.map((w) => ({ text: w.text, reason: w.reason }))).toEqual(
          c.expected_dropped,
        );
        expect(parsed.refused).toBe(c.expected_refused);
      });
    }

    it("covers every roster clause kind", () => {
      const kinds = new Set(doc.cases.flatMap((c) => c.expected_clause_kinds));
      for (const kind of [
        "done",
        "dueCompare",
        "noDueDate",
        "pathIncludes",
        "tagIncludes",
        "priorityIs",
        "sortBy",
        "limit",
      ]) {
        expect(kinds.has(kind), `no vector covers the ${kind} clause`).toBe(true);
      }
    });

    it("covers all three function-valued forms", () => {
      // Naming only one and silently accepting the others would break the
      // closedness claim; the vectors have to say so too.
      const ids = doc.cases.map((c) => c.vector_id).join(" ");
      expect(ids).toContain("drop-function-filter");
      expect(ids).toContain("drop-function-sort");
      expect(ids).toContain("drop-function-group");
    });

    it("covers the boundary rule and the widen guard", () => {
      const ids = doc.cases.map((c) => c.vector_id).join(" ");
      expect(ids).toContain("drop-field-in-value-position");
      expect(ids).toContain("refuse-all-dropped");
      expect(ids).toContain("empty-is-unfiltered");
    });

    it("no refuse case carries a surviving clause, and no parse case refuses", () => {
      for (const c of doc.cases) {
        if (c.case_kind === "refuse") {
          expect(c.expected_refused).toBe(true);
          expect(c.expected_clause_kinds).toHaveLength(0);
        }
        if (c.case_kind === "parse") {
          expect(c.expected_refused).toBe(false);
          expect(c.expected_dropped).toHaveLength(0);
        }
      }
    });
  });
}
