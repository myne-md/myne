// The calendar's grid math (myne-md/myne#1037, task 5).
//
// Pure, and that is the point: a month matrix, a week row and a day list are
// arithmetic over civil dates and the rows one range read returned, so they can be
// tested without a DOM, a clock or a vault. The pane renders what these functions
// say and adds nothing of its own, which is what keeps the four views agreeing
// about which day an event falls on.
//
// **A multi-day event occupies every date it spans.** The host returns ONE row per
// occurrence (its start and its end), so the expansion lives here: a trip from the
// 5th to the 7th is three cells in the month view and one line in the agenda, and
// both come from the same function.
//
// Nothing here decides whether two events overlap: the host computes the
// `conflicts` flag, because that is a fact about the schedule rather than about the
// drawing.

import {
  addDays,
  addMonths,
  compareCivilDates,
  daysBetween,
  daysInMonth,
  formatCivilDate,
  parseCivilDate,
  weekdayOf,
  type CivilDate,
} from "@myne/dialect/civilDate";
import { WEEKDAYS } from "@myne/dialect/recurrence";
import type { CalendarRow } from "../vaultIndices";

/** One cell of a month grid: a date, and the rows that occupy it. */
export type GridCell = {
  readonly date: string;
  /** False for the padding days that belong to the neighbouring months. */
  readonly inMonth: boolean;
  readonly rows: readonly CalendarRow[];
};

/** The date part of a row's start (`YYYY-MM-DD`). */
function rowStartDate(row: CalendarRow): CivilDate | null {
  return parseCivilDate(row.start.slice(0, 10));
}

/** The date part of a row's end, or its start when it has no end. */
function rowEndDate(row: CalendarRow): CivilDate | null {
  const start = rowStartDate(row);
  if (start === null) return null;
  if (row.end === null) return start;
  const end = parseCivilDate(row.end.slice(0, 10));
  return end === null ? start : end;
}

/**
 * Every date a row occupies, inclusive.
 *
 * An all-day event with no end occupies its start date; a timed one does too,
 * because a calendar cell has no room to draw a 15-minute bar across midnight and a
 * schedule that spills into the next day's cell reads as a mistake.
 */
export function rowDates(row: CalendarRow): readonly string[] {
  const start = rowStartDate(row);
  if (start === null) return [];
  const end = rowEndDate(row);
  const last = end === null || compareCivilDates(end, start) < 0 ? start : end;
  const out: string[] = [];
  let cursor = start;
  // A hand-edited event spanning decades must not build a year of cells: the grid
  // only ever shows a bounded window, so a cap here is a guard rather than a rule.
  for (let i = 0; i < 400; i++) {
    out.push(formatCivilDate(cursor));
    if (compareCivilDates(cursor, last) >= 0) break;
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** Group rows by the date they occupy, expanding a multi-day span into each cell. */
export function rowsByDate(rows: readonly CalendarRow[]): ReadonlyMap<string, CalendarRow[]> {
  const out = new Map<string, CalendarRow[]>();
  for (const row of rows) {
    for (const date of rowDates(row)) {
      const bucket = out.get(date);
      if (bucket === undefined) out.set(date, [row]);
      else bucket.push(row);
    }
  }
  return out;
}

/** Monday-first weekday headers, the dialect's own order (§3.8.7). */
export const WEEKDAY_HEADERS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** Monday-first index of a date's weekday, `0` for Monday. */
function weekdayIndex(date: CivilDate): number {
  // The dialect's `weekdayOf` returns the canonical NAME (it is the same value a
  // recurrence rule carries), so the index is its position in `WEEKDAYS`. Doing
  // arithmetic on the name directly is how a grid silently becomes NaN.
  return WEEKDAYS.indexOf(weekdayOf(date));
}

/** The first day of the week a month grid starts on: the Monday on or before the 1st. */
function weekStart(date: CivilDate): CivilDate {
  return addDays(date, -weekdayIndex(date));
}

/**
 * The month grid for `anchor`'s month: whole weeks, Monday first, with the
 * neighbouring months' days included as `inMonth: false`.
 *
 * Always whole weeks, so every row of the grid has seven cells and a month never
 * renders a ragged last row whose height differs from the others.
 */
export function monthGrid(
  anchor: CivilDate,
  rows: readonly CalendarRow[],
): readonly (readonly GridCell[])[] {
  const first = { year: anchor.year, month: anchor.month, day: 1 };
  const lastOfMonth = {
    year: anchor.year,
    month: anchor.month,
    day: daysInMonth(anchor.year, anchor.month),
  };
  const gridStart = weekStart(first);
  // Whole weeks only: a ragged last row makes one week of the month taller than
  // the others, and the height a user sees then depends on which month they are in.
  const spanned = daysBetween(gridStart, lastOfMonth) + 1;
  const cells = Math.ceil(spanned / 7) * 7;

  const byDate = rowsByDate(rows);
  const out: GridCell[][] = [];
  let cursor = gridStart;
  for (let i = 0; i < cells; i++) {
    const iso = formatCivilDate(cursor);
    const cell: GridCell = {
      date: iso,
      inMonth: cursor.year === anchor.year && cursor.month === anchor.month,
      rows: byDate.get(iso) ?? [],
    };
    if (i % 7 === 0) out.push([cell]);
    else out[out.length - 1]!.push(cell);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** The seven days of the week containing `anchor`, Monday first. */
export function weekRow(
  anchor: CivilDate,
  rows: readonly CalendarRow[],
): readonly GridCell[] {
  const start = weekStart(anchor);
  const byDate = rowsByDate(rows);
  return Array.from({ length: 7 }, (_, i) => {
    const iso = formatCivilDate(addDays(start, i));
    return { date: iso, inMonth: true, rows: byDate.get(iso) ?? [] };
  });
}

/** One day's rows, in the order the host returned them (which is by start). */
export function dayCells(
  anchor: CivilDate,
  rows: readonly CalendarRow[],
): readonly GridCell[] {
  const iso = formatCivilDate(anchor);
  return [{ date: iso, inMonth: true, rows: rowsByDate(rows).get(iso) ?? [] }];
}

/** The window one view needs for `anchor`, as the host's wall-clock strings. */
export function windowForView(
  view: "month" | "week" | "day" | "agenda",
  anchor: CivilDate,
  agendaDays: number,
): { readonly start: string; readonly end: string } {
  switch (view) {
    case "month": {
      const first = { year: anchor.year, month: anchor.month, day: 1 };
      const gridStart = weekStart(first);
      const lastOfMonth = {
        year: anchor.year,
        month: anchor.month,
        day: daysInMonth(anchor.year, anchor.month),
      };
      const gridEnd = weekStart(addDays(lastOfMonth, 6));
      return {
        start: formatCivilDate(gridStart),
        end: `${formatCivilDate(addDays(gridEnd, 6))} 23:59`,
      };
    }
    case "week": {
      const start = weekStart(anchor);
      return {
        start: formatCivilDate(start),
        end: `${formatCivilDate(addDays(start, 6))} 23:59`,
      };
    }
    case "day":
      return { start: formatCivilDate(anchor), end: `${formatCivilDate(anchor)} 23:59` };
    case "agenda":
      return {
        start: formatCivilDate(anchor),
        end: `${formatCivilDate(addDays(anchor, agendaDays - 1))} 23:59`,
      };
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

/** Step `anchor` one page forward or back in `view`'s own unit. */
export function shiftAnchor(
  view: "month" | "week" | "day" | "agenda",
  anchor: CivilDate,
  direction: 1 | -1,
): CivilDate {
  switch (view) {
    case "month":
      return addMonths({ ...anchor, day: 1 }, direction);
    case "week":
      return addDays(anchor, 7 * direction);
    case "day":
      return addDays(anchor, direction);
    case "agenda":
      // The agenda scrolls its own 30-day window rather than paging by a month.
      return addDays(anchor, 30 * direction);
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}
