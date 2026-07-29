// Advance policy, calculation modes, reminder co-advance (MYND-615, tasks 4–6).
//
// The contested item was the advance rule. The auto-grill framed it as a binary —
// advance one interval (fabricating a catch-up completion for every missed
// period) or advance from today (drifting a calendar obligation off the 1st).
// Adding whole intervals until strictly after today keeps the anchor AND yields
// exactly one pending occurrence. These tests pin that third option, including
// the property the notification slices depend on.

import { describe, expect, it } from "vitest";
import {
  advanceOccurrence,
  advancePair,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "../../src/dialect/civilDate";
import {
  formatRecurrenceSpec,
  parseRecurrenceSpec,
  type RecurrenceSpec,
} from "../../src/dialect/recurrence";

function d(iso: string): CivilDate {
  const parsed = parseCivilDate(iso);
  if (parsed === null) throw new Error(`bad fixture ${iso}`);
  return parsed;
}

function spec(text: string): RecurrenceSpec {
  const parsed = parseRecurrenceSpec(text);
  if (!parsed.ok) throw new Error(`bad fixture rule ${text}`);
  return parsed.spec;
}

function advance(text: string, from: string, today: string): string {
  return formatCivilDate(advanceOccurrence(spec(text), { from: d(from), today: d(today) }));
}

describe("advance policy (task 4)", () => {
  it("a non-stale rule advances by exactly one interval", () => {
    expect(advance("every month", "2026-07-01", "2026-07-15")).toBe("2026-08-01");
    expect(advance("every day", "2026-07-28", "2026-07-28")).toBe("2026-07-29");
  });

  it("a stale rule advances until strictly after today", () => {
    // Rent due on the 1st, untouched for four months. One interval would land in
    // the past; advancing from today would move it off the 1st.
    expect(advance("every month", "2026-03-01", "2026-07-15")).toBe("2026-08-01");
  });

  it("preserves the calendar anchor in every stale case", () => {
    // The day-of-month survives no matter how stale the rule is.
    for (const today of ["2026-04-10", "2026-05-20", "2026-11-30"]) {
      expect(advance("every month", "2026-01-01", today).endsWith("-01")).toBe(true);
    }
  });

  it("produces exactly ONE pending occurrence, never a backlog", () => {
    // The property the notification slices' capacity argument rests on: a task
    // three years stale yields one date, not 1000 catch-up occurrences.
    const result = advance("every day", "2023-01-01", "2026-07-28");
    expect(result).toBe("2026-07-29");
  });

  it("advances nothing on its own — the result is strictly after today, not today", () => {
    // A task due today and completed today schedules tomorrow; a task due today
    // and NOT completed is simply not passed to this function at all.
    expect(advance("every day", "2026-07-28", "2026-07-28")).toBe("2026-07-29");
  });

  it("keeps calendar-family rules on their nominal day when stale", () => {
    expect(advance("day 31 of every month", "2026-01-31", "2026-05-10")).toBe("2026-05-31");
  });
});

describe("two calculation modes (task 5)", () => {
  it("due-anchored is the default", () => {
    expect(spec("every 3 days").mode).toBe("due");
  });

  it("completion-anchored is opt-in and carried in the rule, not inferred", () => {
    expect(spec("every 3 days when done").mode).toBe("completion");
    expect(formatRecurrenceSpec(spec("every 3 days when done"))).toBe("every 3 days when done");
  });

  it("the same rule and the same late completion give DIFFERENT dates per mode", () => {
    // Due 1 March, completed 15 July. Due-anchored keeps the calendar day;
    // completion-anchored counts from the day the work happened.
    const dueAnchored = advance("every month", "2026-03-01", "2026-07-15");
    const completionAnchored = formatCivilDate(
      advanceOccurrence(spec("every month when done"), {
        from: d("2026-03-01"),
        today: d("2026-07-15"),
      }),
    );
    expect(dueAnchored).toBe("2026-08-01");
    expect(completionAnchored).toBe("2026-08-15");
    expect(dueAnchored).not.toBe(completionAnchored);
  });

  it("the stale-date catch-up applies only to the default mode", () => {
    // Completion-anchored has no stale problem by construction — its anchor is
    // today — so there is nothing to catch up.
    const veryStale = formatCivilDate(
      advanceOccurrence(spec("every day when done"), {
        from: d("2023-01-01"),
        today: d("2026-07-28"),
      }),
    );
    expect(veryStale).toBe("2026-07-29");
  });

  it("an explicit completion date overrides today in completion mode", () => {
    const result = formatCivilDate(
      advanceOccurrence(spec("every week when done"), {
        from: d("2026-01-01"),
        today: d("2026-07-28"),
        completedOn: d("2026-07-20"),
      }),
    );
    expect(result).toBe("2026-07-27");
  });
});

describe("reminder co-advance (task 6)", () => {
  it("with both fields, the due date is the anchor", () => {
    const out = advancePair(spec("every month"), {
      due: d("2026-07-01"),
      remind: d("2026-06-28"),
      today: d("2026-07-02"),
    });
    expect(formatCivilDate(out.due!)).toBe("2026-08-01");
  });

  it("preserves the gap EXACTLY — carried, not recomputed", () => {
    // Reminder three days before due. After advancing, still three days before.
    const out = advancePair(spec("every month"), {
      due: d("2026-07-01"),
      remind: d("2026-06-28"),
      today: d("2026-07-02"),
    });
    expect(formatCivilDate(out.remind!)).toBe("2026-07-29");
  });

  it("carries the gap across a clamping month without drift", () => {
    // Due 31 Jan clamps to 28 Feb (a 28-day step); the reminder moves by the
    // same 28 days. Recomputing "three days before" would have produced a
    // different, drifting answer.
    const out = advancePair(spec("every month"), {
      due: d("2026-01-31"),
      remind: d("2026-01-28"),
      today: d("2026-02-01"),
    });
    expect(formatCivilDate(out.due!)).toBe("2026-02-28");
    expect(formatCivilDate(out.remind!)).toBe("2026-02-25");
  });

  it("with only a reminder, the reminder is the anchor and the task still recurs", () => {
    // "remind me Tuesday to call my mother" — no due date, and it must still
    // repeat. This is why `remind` is absolute rather than an offset from due.
    const out = advancePair(spec("every week"), {
      remind: d("2026-07-28"),
      today: d("2026-07-28"),
    });
    expect(out.due).toBeUndefined();
    expect(formatCivilDate(out.remind!)).toBe("2026-08-04");
  });

  it("with only a due date, nothing spurious is invented", () => {
    const out = advancePair(spec("every week"), {
      due: d("2026-07-28"),
      today: d("2026-07-28"),
    });
    expect(out.remind).toBeUndefined();
    expect(formatCivilDate(out.due!)).toBe("2026-08-04");
  });

  it("returns nothing when there is no anchor at all", () => {
    expect(advancePair(spec("every week"), { today: d("2026-07-28") })).toEqual({});
  });
});
