// What an occurrence is, and what a gesture on it may do (myne-md/myne#1037, task 8).
//
// A recurring event is ONE note. The range read projects it into one row per
// occurrence inside the window, and each of those rows is **an appearance of the
// note, not a record of its own**: §3.8.7 has no per-occurrence overrides, so there
// is nowhere for "this Thursday only, 11:00" to live.
//
// A CANCELLATION is the one exception to that, and it is not an exception of the
// same kind (`decisions/storage/0795`): "not this day" carries no time and nothing
// that could disagree with the series, so it lives in the series note's own `skip:`
// field and `skipWrite.ts` writes it. A MOVE still has no legal write, which is what
// the refusal below is about.
//
// That makes a drag on an occurrence a gesture with no legal write. There are
// exactly two honest answers, and this module owns both:
//
// - `movableTarget` REFUSES, naming the series note and the occurrence date. It is
//   called before any planner runs, so no code path can compute a move for a row
//   that has no note to move.
// - `oneOffSeed` builds the sanctioned alternative: a NEW note with `kind: event`
//   on that day, carrying the series' own duration, and no `repeat`. The series is
//   left byte-identical, because nothing about it was touched.
//
// The refusal is a value rather than a message so every surface says the same
// thing, and so a surface cannot answer it with a toast and leave the user nowhere.

import { addDays, parseCivilDate } from "@myne/dialect/civilDate";
import { parseEventInstant, type EventInstant } from "@myne/dialect/event";
import type { CalendarRow } from "../vaultIndices";
import type { NewEventInput } from "../createEvent";

/** Why a gesture on a row was refused, in the one vocabulary the surfaces share. */
export type OccurrenceRefusal = {
  readonly reason: "belongs-to-series";
  /** The note a series-wide edit must target. */
  readonly seriesNoteId: string;
  /** `YYYY-MM-DD`: which appearance the user touched. */
  readonly occurrenceDate: string;
  readonly title: string | null;
};

/** A refusal, so a caller can show the two affordances instead of a generic error. */
export class OccurrenceRefused extends Error {
  constructor(readonly refusal: OccurrenceRefusal) {
    super(`occurrence of series ${refusal.seriesNoteId}: gestures target the series`);
    this.name = "OccurrenceRefused";
  }
}

/** Whether this row is an appearance of a series rather than a note in its own right. */
export function isProjected(row: Pick<CalendarRow, "occurrenceOf">): boolean {
  return row.occurrenceOf !== null;
}

/** The note any write about this row must target. */
export function seriesNoteId(row: Pick<CalendarRow, "noteId" | "occurrenceOf">): string {
  return row.occurrenceOf ?? row.noteId;
}

/** Which appearance a row is, as the date the user sees. */
export function occurrenceDate(row: Pick<CalendarRow, "start" | "occurrenceDate">): string {
  return row.occurrenceDate ?? row.start.slice(0, 10);
}

/** The refusal a row raises, or `null` when it may be moved. */
export function occurrenceRefusal(row: CalendarRow): OccurrenceRefusal | null {
  if (!isProjected(row)) return null;
  return {
    reason: "belongs-to-series",
    seriesNoteId: seriesNoteId(row),
    occurrenceDate: occurrenceDate(row),
    title: row.title,
  };
}

/**
 * The note a drag may move, or a thrown refusal.
 *
 * This is the guard, and it sits BEFORE the planners: a projected row has no
 * `start` of its own, so computing a move for it would produce a span that looks
 * valid and belongs to no note.
 */
export function movableTarget(row: Pick<CalendarRow, "noteId" | "occurrenceOf" | "start" | "occurrenceDate" | "title">): string {
  const refusal = occurrenceRefusal(row as CalendarRow);
  if (refusal !== null) throw new OccurrenceRefused(refusal);
  return row.noteId;
}

/**
 * The record "add a one-off on this day" creates.
 *
 * It carries the series' own duration (`end - start`), because a 90-minute
 * occurrence becoming an hour-long one-off would be the calendar silently editing
 * the series the user did not ask to touch. `repeat` is absent: this note happens
 * once, and that is the whole difference between it and the series.
 *
 * Returns `null` for a row whose start cannot be read, which is the same shape the
 * reader reports as unreadable rather than repairing.
 */
export function oneOffSeed(row: CalendarRow): NewEventInput | null {
  const start = parseEventInstant(row.start);
  if (start === null) return null;
  const end = row.end === null ? null : parseEventInstant(row.end);
  return {
    title: row.title ?? "",
    start,
    end,
    calendar: row.calendar,
    repeat: null,
    remind: null,
  };
}

/**
 * The one-off's start when the user picks a DIFFERENT day than the occurrence's.
 *
 * The occurrence moves, the duration does not: that is the same rule `planDrag`
 * follows for a single note, applied to the seed the alternative creates.
 */
export function oneOffSeedOn(row: CalendarRow, date: string): NewEventInput | null {
  const seed = oneOffSeed(row);
  if (seed === null) return null;
  if (parseCivilDate(date) === null) return null;
  const from = row.start.slice(0, 10);
  const start = shiftInstant(seed.start, from, date);
  const seedEnd = seed.end;
  const end = seedEnd === null || seedEnd === undefined ? null : shiftInstant(seedEnd, from, date);
  return { ...seed, start, end };
}

/** Move an instant's DATE to `to`, keeping its wall-clock time. */
function shiftInstant(instant: EventInstant, from: string, to: string): EventInstant {
  const fromDate = parseCivilDate(from);
  const toDate = parseCivilDate(to);
  if (fromDate === null || toDate === null) return instant;
  const dayGap = dayGapBetween(fromDate, toDate);
  return { ...instant, date: addDays(instant.date, dayGap) };
}

function dayGapBetween(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}
