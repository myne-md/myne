// Date labels for the calendar (myne-md/myne#1037, task 5).
//
// A heading that reads `2026-11` is a database, not a calendar, so the pane names
// its period the way the user's locale names it. `Intl.DateTimeFormat` gives that
// without a catalogue: month and weekday names are CLDR data the platform already
// ships, and a translation catalogue would only be a second copy of it.
//
// **`timeZone: "UTC"` is load-bearing.** These are CIVIL dates (a day, not an
// instant), so they are formatted as the UTC midnight they denote. Formatting them
// in the machine's zone moves every label a day backwards west of Greenwich, which
// is the classic off-by-one that makes a calendar useless in exactly the timezones
// its users are in.
//
// Every call is guarded: an unsupported locale tag raises a `RangeError`, and "what
// month is this" is not a question that may fail.

import type { CivilDate } from "@myne/dialect/civilDate";

function utcDateOf(date: CivilDate): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

function format(date: CivilDate, locale: string, options: Intl.DateTimeFormatOptions, fallback: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(utcDateOf(date));
  } catch {
    return fallback;
  }
}

/** `November 2026` (or the locale's equivalent) - the month view's heading. */
export function monthLabel(date: CivilDate, locale: string): string {
  return format(
    date,
    locale,
    { month: "long", year: "numeric" },
    `${String(date.year)}-${String(date.month).padStart(2, "0")}`,
  );
}

/** `Thu 5 Nov 2026` - the day view's heading. */
export function dayLabel(date: CivilDate, locale: string): string {
  return format(
    date,
    locale,
    { weekday: "short", day: "numeric", month: "short", year: "numeric" },
    `${String(date.year)}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
  );
}

/** `5 Nov` - a short label for a week column or a grid cell's tooltip. */
export function shortDayLabel(date: CivilDate, locale: string): string {
  return format(
    date,
    locale,
    { day: "numeric", month: "short" },
    String(date.day).padStart(2, "0"),
  );
}
