/**
 * A recurring task keeps its cadence across a daylight-saving transition —
 * myne-md/myne#557, the `editor.tasks-inline` bullet:
 *
 *   > the recurrence arithmetic takes the day as a parameter and
 *   > `todayLocal(now, zone)` takes both clock and zone, so spring-forward is a
 *   > table-driven unit case.
 *
 * # The walk this retires
 *
 * The roster row asked someone to set a machine's clock to the night before a
 * DST change, make a daily recurring task, cross the boundary, and check the
 * next occurrence. Twice a year, per zone, and the interesting zones are not the
 * tester's own — the southern-hemisphere transitions run the opposite direction
 * and Lord Howe Island moves by thirty minutes rather than an hour.
 *
 * # The two failure modes, which are opposite and both silent
 *
 * A day is 23 or 25 hours long across a transition, so any arithmetic that adds
 * `86_400_000` milliseconds to a LOCAL instant lands an hour early or an hour
 * late, and one of those two crosses midnight:
 *
 *  - spring forward (23-hour day): "+1 day" arrives at 23:00 the SAME day, so a
 *    daily task recurs onto the day it was already on and the user sees it
 *    twice;
 *  - fall back (25-hour day): "+1 day" arrives at 01:00 of the day AFTER next,
 *    so a day is skipped entirely and a daily task silently misses one.
 *
 * Neither throws, neither logs, and both are invisible on the ~363 days a year
 * that are 24 hours long. A user in a zone that observes DST hits each once a
 * year, in opposite directions, and reports it as "the task didn't come back" —
 * which reproduces for nobody.
 *
 * # What actually protects it
 *
 * `dialect/src/civilDate.ts` never forms a local instant: `addDays` computes
 * over `Date.UTC`, where every day is exactly 86 400 000 ms by definition, and
 * the comment on `weekdayOf` says the `Date` there is "purely a civil-calendar
 * calculator". `todayLocal(now, zone)` goes the other way and formats an instant
 * through `Intl.DateTimeFormat` with an explicit `timeZone`, which is the one
 * API that gets a zone's civil date right without the caller doing arithmetic.
 *
 * Both are correct today and both are one plausible "simplification" away from
 * being wrong, which is what makes this worth pinning rather than trusting.
 *
 * The zones are chosen so that a UTC-anchored implementation and a
 * local-instant one give DIFFERENT answers — a table of European spring
 * transitions run on a European machine would agree either way.
 *
 * # How this was verified
 *
 * `addDays` was rewritten in the midnight-anchored local form. Five tests
 * failed by name, the sharpest being the fall-back walk, which reported
 * `2026-11-01` twice: a 25-hour day means midnight plus 86 400 000 ms is 23:00
 * of the SAME date, so a daily task recurs onto the day it was already on.
 *
 * The first run of that injection passed everything, which is the finding the
 * `beforeAll` below exists for — see its own note.
 *
 * # Why this exists next to `tests/dialect/civilDate.test.ts`
 *
 * That file has a three-line "DST independence" block, and the same injection
 * run against it — under `TZ=America/New_York`, so with the zone question
 * already answered — passed all 23 of its tests. Two reasons, and both are the
 * point of this file rather than a criticism of that one:
 *
 *  - it covers only Europe's SPRING transition, and spring-forward is the half
 *    a midnight-anchored implementation gets right by luck (midnight plus 24 h
 *    is 01:00 the next day, which is still the right date). Fall-back is the
 *    half that breaks, and there is no fall-back row;
 *  - it inherits the runner's zone, so on a machine with a fixed offset — this
 *    one, and any CI runner on UTC — a local-instant implementation and a
 *    civil-calendar one are indistinguishable.
 *
 * So the two files are not duplicates: that one states the invariant, this one
 * is the arrangement under which the invariant can actually fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  advanceOccurrence,
  formatCivilDate,
  nextOccurrence,
  parseCivilDate,
} from "../../src/dialect/civilDate";
import { parseRecurrenceSpec, type RecurrenceSpec } from "../../src/dialect/recurrence";
import { todayLocal } from "../../src/notes/taskFilters";

function civil(iso: string) {
  const d = parseCivilDate(iso);
  expect(d, `\`${iso}\` did not parse as a civil date`).not.toBeNull();
  return d!;
}

function spec(text: string) {
  const parsed = parseRecurrenceSpec(text);
  expect(parsed.ok, `\`${text}\` did not parse as a recurrence spec`).toBe(true);
  return (parsed as { ok: true; spec: RecurrenceSpec }).spec;
}

/**
 * Transitions worth testing, all of them real, in both hemispheres.
 *
 * `date` is the civil date the transition falls on in that zone; `kind` says
 * which way the clock moved. The southern entries matter because they are
 * "spring forward" in the local spring and therefore in the northern autumn —
 * an implementation that special-cased a month range would pass the northern
 * rows and fail these.
 */
const TRANSITIONS = [
  { zone: "America/New_York", date: "2026-03-08", kind: "forward" },
  { zone: "America/New_York", date: "2026-11-01", kind: "back" },
  { zone: "Europe/Berlin", date: "2026-03-29", kind: "forward" },
  { zone: "Europe/Berlin", date: "2026-10-25", kind: "back" },
  { zone: "Australia/Sydney", date: "2026-10-04", kind: "forward" },
  { zone: "Australia/Sydney", date: "2026-04-05", kind: "back" },
  // Half-hour shift, and the only inhabited place that uses one for DST. An
  // implementation that assumed transitions are whole hours passes everything
  // above and fails here.
  { zone: "Australia/Lord_Howe", date: "2026-10-04", kind: "forward" },
  // Southern-hemisphere zone with no DST at all — the control row.
  { zone: "Asia/Tokyo", date: "2026-03-29", kind: "none" },
] as const;

/**
 * The runner's own zone is pinned to one that observes DST, and that is a
 * correction rather than belt-and-braces.
 *
 * Verified by replacing `addDays`'s `Date.UTC` arithmetic with the
 * midnight-anchored local form — the plausible "simplification". Under
 * `TZ=America/New_York` five tests failed by name. Under the machine's own zone
 * they all PASSED, because Turkey abolished DST in 2016 and its offset never
 * moves; a CI runner on UTC would have been just as blind.
 *
 * So a DST test that inherits the runner's zone is a test that measures the
 * runner. New York is chosen because it observes DST, has a whole-hour shift,
 * and is far enough from UTC that a UTC-anchored implementation and a
 * local-instant one visibly disagree.
 *
 * Restored afterwards, since the value is process-global and other files in the
 * same worker read it.
 */
const REAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (REAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = REAL_TZ;
});

describe("recurrence arithmetic is civil-calendar, so DST cannot move it", () => {
  it("the runner really is in a DST zone, so this file can see the failure at all", () => {
    // Non-vacuity for everything below. Without a moving offset a
    // local-instant implementation is indistinguishable from a correct one, and
    // every assertion in this file passes on both.
    const january = new Date(2026, 0, 15).getTimezoneOffset();
    const july = new Date(2026, 6, 15).getTimezoneOffset();
    expect(
      january,
      `the process timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}) has a ` +
        `constant UTC offset, so nothing in this file can distinguish civil-calendar ` +
        `arithmetic from local-instant arithmetic`,
    ).not.toBe(july);
  });

  it.each(TRANSITIONS)("+1 day steps exactly one calendar day around $zone $date", (t) => {
    // The civil arithmetic takes no zone at all, which IS the property. Running
    // it on the transition date is what would catch an implementation that
    // started reaching for a local instant.
    const day = civil(t.date);
    const next = addDays(day, 1);
    const prev = addDays(day, -1);

    expect(formatCivilDate(addDays(prev, 1))).toBe(t.date);
    expect(formatCivilDate(addDays(next, -1))).toBe(t.date);
    // …and the step is neither zero nor two.
    expect(formatCivilDate(next)).not.toBe(t.date);
    expect(formatCivilDate(addDays(day, 2))).not.toBe(formatCivilDate(next));
  });

  it("a daily rule produces every calendar day across a spring-forward with none repeated or skipped", () => {
    // The failure this is named for: a 23-hour day makes "+1 day" land back on
    // the same date, so the same task appears twice and one date never comes.
    const seen: string[] = [];
    let cursor = civil("2026-03-06");
    for (let i = 0; i < 6; i += 1) {
      cursor = nextOccurrence(spec("every day").rule, cursor);
      seen.push(formatCivilDate(cursor));
    }
    expect(seen).toEqual([
      "2026-03-07",
      "2026-03-08", // US spring forward
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);
    expect(new Set(seen).size, "a date recurred twice").toBe(seen.length);
  });

  it("a daily rule skips nothing across a fall-back either", () => {
    // The opposite failure: a 25-hour day makes "+1 day" overshoot into the day
    // after next, so a date is silently missed.
    const seen: string[] = [];
    let cursor = civil("2026-10-30");
    for (let i = 0; i < 5; i += 1) {
      cursor = nextOccurrence(spec("every day").rule, cursor);
      seen.push(formatCivilDate(cursor));
    }
    expect(seen).toEqual([
      "2026-10-31",
      "2026-11-01", // US fall back
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
  });

  it("a weekly rule lands on the same weekday through both transitions", () => {
    // Seven "+1 day" steps, each of which could be off by an hour, compound
    // into a whole-day error if any one of them crosses midnight wrongly.
    for (const start of ["2026-03-01", "2026-10-25", "2026-03-25"]) {
      let cursor = civil(start);
      for (let week = 0; week < 8; week += 1) {
        const next = nextOccurrence(spec("every week").rule, cursor);
        const gap =
          (Date.UTC(next.year, next.month - 1, next.day) -
            Date.UTC(cursor.year, cursor.month - 1, cursor.day)) /
          86_400_000;
        expect(gap, `week ${week} from ${start} moved ${gap} days, not 7`).toBe(7);
        cursor = next;
      }
    }
  });

  it("a stale due-anchored rule catches up to a date strictly after today", () => {
    // The catch-up loop runs `nextOccurrence` many times, so a per-step drift of
    // an hour accumulates. Anchored across a transition on purpose.
    const next = advanceOccurrence(spec("every day"), {
      from: civil("2026-03-01"),
      today: civil("2026-03-20"),
    });
    expect(formatCivilDate(next)).toBe("2026-03-21");
  });
});

describe("todayLocal answers one civil date per local day, whatever the zone does", () => {
  /** The civil dates `todayLocal` reports over `hours` hourly instants. */
  function walk(startIso: string, hours: number, zone: string): string[] {
    const out: string[] = [];
    const start = Date.parse(startIso);
    for (let h = 0; h < hours; h += 1) out.push(todayLocal(new Date(start + h * 3_600_000), zone));
    return out;
  }

  it.each(TRANSITIONS.filter((t) => t.kind !== "none"))(
    "reports consecutive dates with no gap and no repeat across $zone $date",
    (t) => {
      // 72 hourly instants either side of the transition. What is asserted is
      // the SHAPE of the sequence rather than any particular date: each distinct
      // value appears in one unbroken run (no date comes back after another
      // started), and consecutive distinct values are consecutive calendar days
      // (nothing skipped).
      const dates = walk(`${t.date}T00:00:00Z`, 72, t.zone);
      const runs: string[] = [];
      for (const d of dates) if (runs[runs.length - 1] !== d) runs.push(d);

      expect(new Set(runs).size, `a date reappeared after another started: ${runs.join(" ")}`).toBe(
        runs.length,
      );
      for (let i = 1; i < runs.length; i += 1) {
        expect(
          formatCivilDate(addDays(civil(runs[i - 1]!), 1)),
          `${runs[i - 1]} is followed by ${runs[i]} in ${t.zone}, so a calendar day ` +
            `has no instant that reports it — every task due that day is invisible`,
        ).toBe(runs[i]);
      }
    },
  );

  it("gives the zone's date, not the machine's, at an hour where they differ", () => {
    // Non-vacuity for the whole second block. If `todayLocal` ignored its zone
    // argument, every assertion above would still hold — the sequence would be
    // perfectly well-formed, just in the wrong calendar.
    const instant = new Date("2026-03-08T04:00:00Z");
    expect(todayLocal(instant, "Pacific/Kiritimati")).toBe("2026-03-08");
    expect(todayLocal(instant, "America/Los_Angeles")).toBe("2026-03-07");
  });

  it("falls back to the machine's calendar on a zone it cannot resolve", () => {
    // The pref carries a free string, and "what day is it" may not throw. Only
    // that it answers a well-formed date is asserted: which one depends on the
    // runner's own zone, and pinning that would make this file fail on a
    // machine set to anything else.
    expect(todayLocal(new Date("2026-03-08T12:00:00Z"), "Not/AZone")).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
