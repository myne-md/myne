// The desktop half of the period-title cross-implementation check (myne#177).
//
// `core/src/plugins/notes/period-title-cases.json` is the ONE table the three
// implementations of this grammar are checked against: the Rust one in
// `core/src/plugins/notes/daily_match.rs`, this tree's `src/notes/dailyNote.ts`,
// and `mobile/src/lib/daily.ts`. Before it, all that held them together was
// three hand-copied expected values in three test files and a comment in each
// saying they agreed.
//
// The table is minted BY the Rust implementation and asserted byte-identical to
// it there, so this file is genuinely checking one implementation against
// another rather than restating an opinion. A divergence between any two of the
// three would file one week under two titles, which is one week with two notes,
// since a period note is matched by folder plus title and nothing else.
//
// It is in this repo rather than in `myne-test-vectors` because every
// implementation is in this repo and the companion's runners skip when the
// fixture is absent while `vector-verification` is commented out in CI. Here it
// runs on the `vitest` step.

import { describe, it, expect } from "vitest";
import cases from "../../core/src/plugins/notes/period-title-cases.json";
import {
  formatDailyDate,
  periodRange,
  PERIODS,
  PERIOD_DEFAULTS,
  type Period,
} from "../../src/notes/dailyNote";

interface Case {
  id: string;
  date: [number, number, number];
  period: string;
  format: string;
  anchor: [number, number, number];
  start: [number, number, number];
  end: [number, number, number];
  title: string;
}

/** A civil date as a local Date at noon, matching what the resolver is handed. */
const at = ([y, m, d]: [number, number, number]): Date => new Date(y, m - 1, d, 12, 0, 0, 0);

/** A Date back to a civil triple, so a mismatch reads as a date, not a ms count. */
const civil = (d: Date): [number, number, number] => [
  d.getFullYear(),
  d.getMonth() + 1,
  d.getDate(),
];

const CASES = cases.cases as Case[];
const DEFAULTS = cases.defaults as Record<string, { folder: string; format: string }>;

describe("period title cases (shared with the Rust and mobile implementations)", () => {
  it("agrees on PERIOD_DEFAULTS, folder included", () => {
    // The half the table used to omit. A folder divergence files one period in
    // two folders across two clients of one vault, which is what
    // `Period::defaults`' own doc comment says it exists to prevent, and it is
    // invisible to every title assertion below.
    for (const period of PERIODS) {
      const want = DEFAULTS[period];
      expect(want, `no default recorded for ${period}`).toBeDefined();
      expect(PERIOD_DEFAULTS[period].folder).toBe(want!.folder);
      expect(PERIOD_DEFAULTS[period].format).toBe(want!.format);
    }
    // Both directions: a period recorded in the table and absent from the
    // client is the same drift wearing the other face.
    expect(Object.keys(DEFAULTS).sort()).toEqual([...PERIODS].sort());
  });

  it("carries every case the table declares", () => {
    // A non-vacuity floor: a runner that silently iterated an empty array would
    // report green having asserted nothing, which is the exact shape the repo's
    // vector lanes already fail on.
    expect(CASES.length).toBeGreaterThanOrEqual(18);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(PERIODS).toContain(c.period as Period);
    const range = periodRange(at(c.date), c.period as Period);
    expect(civil(range.anchor)).toEqual(c.anchor);
    expect(civil(range.start)).toEqual(c.start);
    expect(civil(range.end)).toEqual(c.end);
    // A `*-default` case formats with the CLIENT's constant, so the
    // default string itself is under test rather than merely echoed.
    const format = c.id.endsWith("-default")
      ? PERIOD_DEFAULTS[c.period as Period].format
      : c.format;
    expect(formatDailyDate(range.anchor, format)).toBe(c.title);
  });
});
