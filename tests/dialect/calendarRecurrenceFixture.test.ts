// The calendar's recurrence projection, driven from the SHARED fixture
// (myne-md/myne#1037).
//
// The closed §3.8.7 vocabulary is parsed twice in this tree, and this file is
// half of why that is safe. `myne-core` reads it for the range query the fifth
// agent tool depends on (a tool runs in the host process and cannot call
// TypeScript); this side already owned it for line-tasks. Both suites read
// `core/tests/fixtures/calendar/recurrence_projection.json`, which is
// hand-written from the spec's own worked examples, so a change to either side's
// advance fails the other.
//
// The expectation is NOT generated from either implementation on purpose: a
// fixture produced by the code it checks agrees with that code by construction,
// which is the vacuous-test shape `AGENTS.md` names.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareCivilDates,
  formatCivilDate,
  nextOccurrence,
  parseCivilDate,
  type CivilDate,
} from "../../src/dialect/civilDate";
import { parseRecurrenceSpec } from "../../src/dialect/recurrence";

type Case = {
  rule: string;
  start: string;
  until: string;
  occurrences: string[] | null;
};

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../core/tests/fixtures/calendar/recurrence_projection.json",
);

/** The guard the Rust walk also carries, so neither side can spin on a bad rule. */
const MAX_OCCURRENCES = 10_000;

function project(ruleText: string, start: string, until: string): string[] | null {
  const parsed = parseRecurrenceSpec(ruleText);
  if (!parsed.ok) return null;
  const from = parseCivilDate(start);
  const stop = parseCivilDate(until);
  if (from === null || stop === null) throw new Error(`bad fixture date ${start}/${until}`);
  const out: string[] = [];
  let cursor: CivilDate = from;
  for (let steps = 0; steps < MAX_OCCURRENCES; steps++) {
    if (compareCivilDates(cursor, stop) > 0) break;
    out.push(formatCivilDate(cursor));
    cursor = nextOccurrence(parsed.spec.rule, cursor);
  }
  return out;
}

describe("the calendar recurrence fixture", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { cases: Case[] };

  it("has cases to run", () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
  });

  for (const testCase of fixture.cases) {
    it(`projects ${testCase.rule}`, () => {
      const got = project(testCase.rule, testCase.start, testCase.until);
      if (testCase.occurrences === null) {
        expect(got, `${testCase.rule} must stay unrecognized`).toBeNull();
        return;
      }
      expect(got).toEqual(testCase.occurrences);
    });
  }
});
