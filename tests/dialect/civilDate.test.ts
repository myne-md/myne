// Civil-date arithmetic (MYND-615, tasks 2–3).
//
// Every assertion is UTC-anchored and DST-independent by construction: nothing
// here forms a local-time instant, so there is no gap or repeated hour for the
// arithmetic to land in. That is the whole reason this is hand-rolled rather than
// delegated — the existing backup scheduler adds milliseconds to a locally
// anchored instant and documents itself as having no DST model, which is the
// precedent being avoided.

import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  formatCivilDate,
  isLeapYear,
  nextOccurrence,
  ordinalWeekdayOf,
  parseCivilDate,
  weekdayOf,
} from "../../src/dialect/civilDate";
import { parseRecurrenceRule, type RecurrenceRule } from "../../src/dialect/recurrence";

function d(iso: string) {
  const parsed = parseCivilDate(iso);
  if (parsed === null) throw new Error(`bad fixture date ${iso}`);
  return parsed;
}

function rule(text: string): RecurrenceRule {
  const parsed = parseRecurrenceRule(text);
  if (!parsed.ok) throw new Error(`bad fixture rule ${text}`);
  return parsed.rule;
}

/** Apply a rule once and return the ISO string. */
function next(text: string, from: string): string {
  return formatCivilDate(nextOccurrence(rule(text), d(from)));
}

describe("calendar primitives", () => {
  it("knows leap years, including the century rules", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false); // divisible by 100, not 400
    expect(isLeapYear(2000)).toBe(true); // divisible by 400
  });

  it("knows month lengths, February included", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("rejects an impossible date rather than rolling it", () => {
    expect(parseCivilDate("2026-02-31")).toBeNull();
    expect(parseCivilDate("2026-13-01")).toBeNull();
    expect(parseCivilDate("not-a-date")).toBeNull();
  });

  it("computes weekdays UTC-anchored", () => {
    expect(weekdayOf(d("2026-07-28"))).toBe("tuesday");
    expect(weekdayOf(d("2026-08-01"))).toBe("saturday");
  });
});

describe("interval family: day and week", () => {
  it("advances by days across a month boundary", () => {
    expect(next("every day", "2026-07-31")).toBe("2026-08-01");
    expect(next("every 3 days", "2026-07-30")).toBe("2026-08-02");
  });

  it("advances by weeks", () => {
    expect(next("every week", "2026-07-28")).toBe("2026-08-04");
    expect(next("every 2 weeks", "2026-07-28")).toBe("2026-08-11");
  });

  it("crosses a year boundary", () => {
    expect(next("every day", "2026-12-31")).toBe("2027-01-01");
  });
});

describe("interval family: month clamping and the drift it causes", () => {
  it("a monthly rule from the 31st clamps into February", () => {
    expect(next("every month", "2026-01-31")).toBe("2026-02-28");
  });

  it("and then DRIFTS — the next step counts from the clamped day", () => {
    // This is the accepted cost of the stateless option: nothing remembers that
    // the user started on the 31st. A user who wants the 31st back says so with
    // a calendar-family rule instead.
    expect(next("every month", "2026-02-28")).toBe("2026-03-28");
  });

  it("clamps into a leap February too", () => {
    expect(next("every month", "2024-01-31")).toBe("2024-02-29");
  });

  it("advances parameterized month intervals", () => {
    expect(next("every 6 months", "2026-01-15")).toBe("2026-07-15");
    expect(next("every 2 months", "2026-11-30")).toBe("2027-01-30");
  });
});

describe("interval family: year clamping", () => {
  it("a yearly rule from 29 February clamps in a non-leap year", () => {
    expect(next("every year", "2024-02-29")).toBe("2025-02-28");
  });

  it("an ordinary yearly rule keeps its day", () => {
    expect(next("every year", "2026-07-28")).toBe("2027-07-28");
  });
});

describe("weekday sets resolve to the next matching weekday", () => {
  it("single weekday", () => {
    // 2026-07-28 is a Tuesday.
    expect(next("every monday", "2026-07-28")).toBe("2026-08-03");
  });

  it("multi-day set picks the nearest, not the first listed", () => {
    expect(next("every tuesday and thursday", "2026-07-28")).toBe("2026-07-30");
    expect(next("every tuesday and thursday", "2026-07-30")).toBe("2026-08-04");
  });

  it("is strictly after the given date, never the same day", () => {
    expect(next("every tuesday", "2026-07-28")).toBe("2026-08-04");
  });
});

describe("calendar family: ordinal weekday", () => {
  it("resolves the nth weekday of a month", () => {
    expect(formatCivilDate(ordinalWeekdayOf(2026, 8, "first", "monday"))).toBe("2026-08-03");
    expect(formatCivilDate(ordinalWeekdayOf(2026, 8, "second", "monday"))).toBe("2026-08-10");
  });

  it("resolves 'last' from the end of the month", () => {
    expect(formatCivilDate(ordinalWeekdayOf(2026, 8, "last", "monday"))).toBe("2026-08-31");
    expect(formatCivilDate(ordinalWeekdayOf(2026, 2, "last", "friday"))).toBe("2026-02-27");
  });

  it("clamps back a week when a month has only four of a weekday", () => {
    // February 2026 starts on a Sunday; it has four Mondays, so "fourth" is the
    // last one and a naive +21 would spill into March.
    const fourth = ordinalWeekdayOf(2026, 2, "fourth", "monday");
    expect(fourth.month).toBe(2);
  });

  it("does not drift across months", () => {
    let cursor = "2026-01-01";
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      cursor = next("first monday of every month", cursor);
      seen.push(cursor);
    }
    expect(seen).toEqual(["2026-01-05", "2026-02-02", "2026-03-02", "2026-04-06"]);
  });
});

describe("calendar family: day of month", () => {
  it("holds the nominal day across months — no drift", () => {
    // The point of this family: after clamping into February, March returns to
    // the 31st rather than counting from the 28th.
    let cursor = "2026-01-31";
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      cursor = next("day 31 of every month", cursor);
      seen.push(cursor);
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("resolves 'last day of every month'", () => {
    expect(next("last day of every month", "2026-01-31")).toBe("2026-02-28");
    expect(next("last day of every month", "2026-02-28")).toBe("2026-03-31");
    expect(next("last day of every month", "2024-01-31")).toBe("2024-02-29");
  });
});

describe("DST independence", () => {
  it("advances identically regardless of the host timezone offset", () => {
    // The arithmetic never forms a local instant, so a date spanning a DST
    // transition advances by whole calendar days either way. Europe's spring
    // transition in 2026 is 29 March.
    expect(next("every day", "2026-03-28")).toBe("2026-03-29");
    expect(next("every day", "2026-03-29")).toBe("2026-03-30");
    expect(next("every week", "2026-03-25")).toBe("2026-04-01");
  });
});
