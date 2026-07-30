// Civil-date arithmetic for recurrence (MYND-615, tasks 2–3).
//
// Everything here operates on **civil year/month/day fields anchored to UTC**,
// which is DST-immune by construction: no local-time instant is ever formed, so
// no arithmetic can land in a gap or a repeated hour.
//
// This is deliberately NOT the approach the existing backup scheduler takes —
// adding milliseconds to a locally-anchored instant, which its own comments admit
// has no DST model. That is a precedent to avoid, not to follow, and it is why a
// date library is unnecessary here: the operations are small, total, and easier
// to verify than to configure.
//
// Two families, and the user picks between them by picking the rule:
//
//   - **interval** rules count from the previous date and CLAMP into short
//     months, accepting drift (a monthly rule from the 31st lands on the 28th in
//     February and counts from there);
//   - **calendar** rules are anchored and do NOT drift, which is what lets a user
//     say "keep it on the 31st" directly instead of making Myne remember an
//     anchor the file does not carry.

import {
  ORDINALS,
  WEEKDAYS,
  type Ordinal,
  type RecurrenceRule,
  type RecurrenceSpec,
  type Weekday,
} from "./recurrence";

/** A civil date: no time, no zone, no instant. */
export type CivilDate = { readonly year: number; readonly month: number; readonly day: number };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD`, or null when it is not a real calendar date. */
export function parseCivilDate(value: string): CivilDate | null {
  const m = ISO_DATE.exec(value);
  if (m === null) return null;
  const [, y, mo, d] = m;
  const date = { year: Number(y), month: Number(mo), day: Number(d) };
  if (date.month < 1 || date.month > 12) return null;
  if (date.day < 1 || date.day > daysInMonth(date.year, date.month)) return null;
  return date;
}

/** Format back to `YYYY-MM-DD`. */
export function formatCivilDate(date: CivilDate): string {
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${date.year}-${mm}-${dd}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] ?? 30;
}

/** Weekday of a civil date, as one of the canonical names. UTC-anchored. */
export function weekdayOf(date: CivilDate): Weekday {
  // `Date.UTC` is used purely as a civil-calendar calculator; no local instant
  // is formed, so there is nothing for DST to perturb.
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  // JS: 0 = Sunday. Canonical order is Monday-first.
  return WEEKDAYS[(dow + 6) % 7]!;
}

/** Add whole days, rolling months and years correctly. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const ms = Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Add whole months, **clamping** to the last valid day of the target month.
 *
 * This is where the interval family's drift comes from and it is intentional:
 * 31 January + 1 month = 28 February, and the next step counts from the 28th.
 * A user who wants the 31st back must say so with a calendar-family rule.
 */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const zeroBased = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/** Add whole years, clamping 29 February into a non-leap year. */
export function addYears(date: CivilDate, years: number): CivilDate {
  const year = date.year + years;
  return { year, month: date.month, day: Math.min(date.day, daysInMonth(year, date.month)) };
}

/** Compare two civil dates. */
export function compareCivilDates(a: CivilDate, b: CivilDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/** The nth (or last) `weekday` of a given month. */
export function ordinalWeekdayOf(
  year: number,
  month: number,
  ordinal: Ordinal,
  weekday: Weekday,
): CivilDate {
  if (ordinal === "last") {
    const last = { year, month, day: daysInMonth(year, month) };
    const back = (WEEKDAYS.indexOf(weekdayOf(last)) - WEEKDAYS.indexOf(weekday) + 7) % 7;
    return addDays(last, -back);
  }
  const first = { year, month, day: 1 };
  const forward = (WEEKDAYS.indexOf(weekday) - WEEKDAYS.indexOf(weekdayOf(first)) + 7) % 7;
  const index = ORDINALS.indexOf(ordinal); // first = 0
  const day = 1 + forward + index * 7;
  // A month may have only four of a given weekday; clamp back a week rather than
  // spilling into the next month.
  return day <= daysInMonth(year, month)
    ? { year, month, day }
    : { year, month, day: day - 7 };
}

/**
 * The next occurrence strictly after `from`, applying `rule` **once**.
 *
 * Advancing repeatedly until a target is passed is the advance *policy* and
 * belongs to task 4; this function is one step.
 */
export function nextOccurrence(rule: RecurrenceRule, from: CivilDate): CivilDate {
  switch (rule.kind) {
    case "interval": {
      switch (rule.unit) {
        case "day":
          return addDays(from, rule.count);
        case "week":
          return addDays(from, rule.count * 7);
        case "month":
          return addMonths(from, rule.count);
        case "year":
          return addYears(from, rule.count);
        default: {
          const exhaustive: never = rule.unit;
          return exhaustive;
        }
      }
    }
    case "weekdays": {
      // The next day, strictly after `from`, whose weekday is in the set.
      for (let step = 1; step <= 7; step++) {
        const candidate = addDays(from, step);
        if (rule.days.includes(weekdayOf(candidate))) return candidate;
      }
      return addDays(from, 7);
    }
    case "ordinal": {
      // Calendar-anchored: the same ordinal position in a following month.
      let cursor = { year: from.year, month: from.month, day: 1 };
      for (let i = 0; i < 24; i++) {
        const candidate = ordinalWeekdayOf(cursor.year, cursor.month, rule.ordinal, rule.weekday);
        if (compareCivilDates(candidate, from) > 0) return candidate;
        cursor = addMonths(cursor, 1);
      }
      return from;
    }
    case "dayOfMonth": {
      // Calendar-anchored and drift-free: the nominal day each month, clamped only
      // where the month is too short — and the NEXT month starts from the
      // nominal day again rather than from the clamped one.
      let cursor = { year: from.year, month: from.month, day: 1 };
      for (let i = 0; i < 24; i++) {
        const nominal =
          rule.day === "last" ? daysInMonth(cursor.year, cursor.month) : rule.day;
        const candidate = {
          year: cursor.year,
          month: cursor.month,
          day: Math.min(nominal, daysInMonth(cursor.year, cursor.month)),
        };
        if (compareCivilDates(candidate, from) > 0) return candidate;
        cursor = addMonths(cursor, 1);
      }
      return from;
    }
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

/**
 * The next occurrence a completion should schedule (MYND-615 tasks 4–6).
 *
 * **The advance rule: add whole intervals from the previous due date until
 * strictly after today.** This dissolves a conflict the auto-grill framed as
 * binary — advance one interval (which fabricates catch-up completions for every
 * missed period) or advance from today (which drifts a calendar obligation off
 * the 1st). Adding whole intervals keeps the calendar anchor *and* produces
 * exactly one pending occurrence.
 *
 * It does not contradict the earlier "a missed task stays overdue" decision:
 * that decision was about the *view* not fast-forwarding on its own and hiding a
 * miss while it happens. Nothing here advances by itself — the task sits overdue
 * and visible until the user acts. The rule only declines to manufacture history
 * afterwards.
 *
 * **Consequence worth stating: exactly one pending occurrence survives**, which
 * is what the notification slices' capacity argument rests on; they do not need
 * to re-derive it.
 *
 * In completion-anchored mode there is no stale-date problem by construction —
 * the anchor *is* today — so the catch-up loop does not apply.
 */
export function advanceOccurrence(
  spec: RecurrenceSpec,
  args: { readonly from: CivilDate; readonly today: CivilDate; readonly completedOn?: CivilDate },
): CivilDate {
  if (spec.mode === "completion") {
    // Anchor on the day the work actually happened (today, unless the caller
    // supplies an explicit completion date).
    return nextOccurrence(spec.rule, args.completedOn ?? args.today);
  }

  let cursor = nextOccurrence(spec.rule, args.from);
  // Bounded: a daily rule three years stale is ~1100 steps, and the guard stops
  // a pathological rule from looping forever rather than being a real limit.
  for (let i = 0; i < 4000; i++) {
    if (compareCivilDates(cursor, args.today) > 0) return cursor;
    cursor = nextOccurrence(spec.rule, cursor);
  }
  return cursor;
}

/**
 * Advance a due date and carry a reminder alongside it (MYND-615 task 6).
 *
 * The anchor is the due date when present, otherwise the reminder — so a task
 * with a reminder and no due date still recurs. The other field shifts by the
 * **same interval** the anchor moved, so the gap between them is *carried* rather
 * than recomputed. Recomputing would let the gap drift every cycle; carrying it
 * cannot.
 */
export function advancePair(
  spec: RecurrenceSpec,
  args: {
    readonly due?: CivilDate;
    readonly remind?: CivilDate;
    readonly today: CivilDate;
    readonly completedOn?: CivilDate;
  },
): { due?: CivilDate; remind?: CivilDate } {
  const anchor = args.due ?? args.remind;
  if (anchor === undefined) return {};

  const nextAnchor = advanceOccurrence(spec, {
    from: anchor,
    today: args.today,
    completedOn: args.completedOn,
  });
  const shift = daysBetween(anchor, nextAnchor);

  if (args.due === undefined) return { remind: nextAnchor };
  if (args.remind === undefined) return { due: nextAnchor };
  return { due: nextAnchor, remind: addDays(args.remind, shift) };
}

/** Whole days from `a` to `b` (negative when `b` precedes `a`). */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}
