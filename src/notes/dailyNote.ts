// Periodic-notes "open this period" resolver (MYND-191 daily; myne#177 weekly
// and monthly).
//
// A pure, deterministic function that answers "which note is today's note?" —
// the testable core of the daily-notes feature. Given a host-injected `now`,
// the `daily_date_format` + `daily_folder` prefs, and the note list, it:
//   1. computes today's date-title string from `now` via the format (LOCAL
//      clock — the host injects `now`; no clock read here);
//   2. searches for a note whose `folder:` == the daily folder AND `title:` ==
//      the date string, comparing both under the dialect identity rule
//      (case-fold + NFC, via `foldSegment`) so `Daily/` matches a `daily/`
//      variant and an NFC/NFD date-title variant resolves to the same note;
//   3. excludes trashed + template-flagged notes (same exclusion machinery as
//      trash/templates);
//   4. returns the matched note ("open") or a "create" signal.
// Renamed-title and moved-out-of-folder notes intentionally no longer match —
// the key is folder + date-title by design (predictable, not magical).
//
// Daily-notes is a bounded plain-markdown skeleton + date navigation over
// ordinary notes — NOT a calendar/date-object model (anti-Notion, vision.md:59).

import { foldSegment, folderKey, normalizeFolderPath } from "../dialect/folderPath";
import type { TitleRecord } from "./loadNoteBatch";
import type { NoteId } from "./sidebarState";

/** Canonical default daily folder when `daily_folder` is unset (None ≡ default). */
export const DEFAULT_DAILY_FOLDER = "Daily/";
/** Canonical default daily date format when `daily_date_format` is unset. */
export const DEFAULT_DAILY_DATE_FORMAT = "YYYY-MM-DD";

/**
 * The periods that have first-class support (myne#177). Quarterly and yearly
 * were cut deliberately: each period costs three settings, a Settings block, a
 * command, a scenario and a user-guide section, and the storage shape means
 * adding one later needs no codec, spec or vector change.
 */
export const PERIODS = ["daily", "weekly", "monthly"] as const;
export type Period = (typeof PERIODS)[number];

/** Canonical defaults per period, applied host-side when a setting is unset. */
export const PERIOD_DEFAULTS: Record<Period, { folder: string; format: string }> = {
  daily: { folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_DATE_FORMAT },
  // `gggg-[W]ww` is moment.js-compatible, so a format carried over from another
  // tool works as typed. The defaults do not collide with each other, which is
  // what keeps the Settings collision warning a self-inflicted case only.
  weekly: { folder: "Weekly/", format: "gggg-[W]ww" },
  monthly: { folder: "Monthly/", format: "YYYY-MM" },
};

/** The three things a period configures, resolved from prefs. */
export type PeriodSettings = {
  folder: string | null;
  format: string | null;
  template: string | null;
};

/** The shape of the prefs this module reads. Structural, so both client trees
 *  can pass their own `PrefsView` without this module importing either. */
export type PeriodPrefs = {
  daily_folder: string | null;
  daily_date_format: string | null;
  daily_template: string | null;
  periodic_notes: Record<string, string>;
};

/**
 * Resolve one period's settings out of prefs (myne#177).
 *
 * Daily reads the three legacy top-level fields and the others read the
 * `periodic_notes` map, which is the whole of the no-migration decision: prefs
 * merge per field, so a device on an older build would keep writing the flat
 * fields while a newer one wrote the map, and nothing could say which of the
 * two is authoritative. A `daily.*` entry in the map is therefore ignored here
 * rather than preferred, so a client that writes one cannot create a second
 * home for a setting that already has one.
 */
export function periodSettings(prefs: PeriodPrefs, period: Period): PeriodSettings {
  if (period === "daily") {
    return {
      folder: prefs.daily_folder,
      format: prefs.daily_date_format,
      template: prefs.daily_template,
    };
  }
  const read = (setting: string): string | null =>
    // `?.` and not a bare index: the field is typed non-optional, and the
    // value that arrives is whatever `prefs_read` answered. An absent map is
    // normative (protocol.md 9.5: a decoder that does not find the key MUST
    // treat it as unset), so reading it as empty applies the defaults rather
    // than throwing inside a palette command.
    prefs.periodic_notes?.[`${period}.${setting}`] ?? null;
  return { folder: read("folder"), format: read("format"), template: read("template") };
}

/** A period's inclusive day range, and the date its title is formatted from. */
export type PeriodRange = { anchor: Date; start: Date; end: Date };

const atNoon = (y: number, m: number, d: number): Date => new Date(y, m, d, 12, 0, 0, 0);

/**
 * The inclusive day range `now` falls in for `period`, plus the anchor date its
 * title is formatted from (myne#177).
 *
 * The anchor is the range's FIRST day for every period, so a weekly title is
 * stable across the week and a monthly one across the month, which is what
 * makes "open this week" idempotent. Weeks start Monday (ISO 8601, frozen: see
 * `isoWeek`), and every returned Date is at noon local, because only the
 * calendar fields are ever read and midnight is the one instant an hour of
 * drift could move a day.
 */
export function periodRange(now: Date, period: Period): PeriodRange {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (period) {
    case "daily": {
      const day = atNoon(y, m, d);
      return { anchor: day, start: day, end: day };
    }
    case "weekly": {
      // Monday = 0 … Sunday = 6.
      const offset = (now.getDay() + 6) % 7;
      const start = atNoon(y, m, d - offset);
      const end = atNoon(y, m, d - offset + 6);
      return { anchor: start, start, end };
    }
    case "monthly": {
      const start = atNoon(y, m, 1);
      // Day 0 of the NEXT month is the last day of this one, which also gets
      // February and leap years right without a table.
      const end = atNoon(y, m + 1, 0);
      return { anchor: start, start, end };
    }
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Monday = 0 … Sunday = 6, for a UTC-held calendar date. */
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;

/**
 * ISO 8601 week identity for a LOCAL calendar date: the week-year and the
 * 1-based week number. Weeks start Monday and week 1 is the week holding the
 * year's first Thursday, so the last days of December can belong to week 1 of
 * the next year and the first days of January to week 52 or 53 of the previous
 * one (2027-01-01 is 2026-W53).
 *
 * The WEEK-YEAR is the load-bearing half. Pairing a calendar year with a week
 * number splits one week across two titles at the boundary, and since the match
 * rule below keys on folder + title, that is one week with two notes.
 *
 * Computed in UTC over the local Y/M/D so a DST transition cannot move a day.
 */
export function isoWeek(now: Date): { weekYear: number; week: number } {
  const thursday = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
  thursday.setUTCDate(thursday.getUTCDate() - mondayIndex(thursday) + 3);
  const weekYear = thursday.getUTCFullYear();

  // January 4th is in week 1 by definition, so its Thursday is week 1's.
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - mondayIndex(firstThursday) + 3,
  );

  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / MS_PER_WEEK);
  return { weekYear, week };
}

/**
 * Format `now` into a date-title string per a period format. Tokens, longest
 * first: `YYYY` (4-digit calendar year), `gggg` (ISO week-year), `MM` (2-digit
 * month), `DD` (2-digit day), `ww` (2-digit ISO week). A `[...]` run is literal
 * text with the brackets stripped, so `gggg-[W]ww` renders `2026-W35`; an
 * unterminated `[` is itself literal. Any other character passes through.
 *
 * The escape is not decoration. Every week format wants a literal `W` beside
 * the week token, and this used to be three successive `String.replace` calls,
 * under which `W` + `ww` and `ww` + `W` are the same string and neither reading
 * is more correct. A single left-to-right pass also means nothing the formatter
 * emits is eligible for another token match, which successive replaces could
 * not promise. The grammar is moment.js-compatible, so a format carried over
 * from another tool works as typed (myne#177).
 *
 * LOCAL time — `now.getFullYear()`/`getMonth()`/`getDate()` are local-clock.
 */
export function formatDailyDate(now: Date, format: string): string {
  const tokens: ReadonlyArray<readonly [string, () => string]> = [
    ["YYYY", () => String(now.getFullYear())],
    ["gggg", () => String(isoWeek(now).weekYear)],
    ["MM", () => pad2(now.getMonth() + 1)],
    ["DD", () => pad2(now.getDate())],
    ["ww", () => pad2(isoWeek(now).week)],
  ];

  let out = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "[") {
      const end = format.indexOf("]", i + 1);
      if (end !== -1) {
        out += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      // Unterminated: the bracket is ordinary text, so fall through.
    }
    const token = tokens.find(([name]) => format.startsWith(name, i));
    if (token !== undefined) {
      out += token[1]();
      i += token[0].length;
      continue;
    }
    out += format[i];
    i += 1;
  }
  return out;
}

/**
 * Re-express `now` as a Date whose LOCAL calendar fields are the calendar
 * fields of `timeZone` (myne#177). Everything downstream (the formatter, the
 * ISO-week helper, the resolver) reads `getFullYear()`/`getMonth()`/`getDate()`
 * off whatever it is handed, so converting once at the injection point is the
 * whole of honouring the override.
 *
 * The problem this closes is live today, not hypothetical: the `timezone` pref
 * (myne#279) decides how every date in the app is DISPLAYED, and "open today"
 * read the device clock. At 20:00 in New York with the override on Berlin, the
 * app shows tomorrow's date everywhere and opens yesterday's-by-display note.
 * For a weekly note the same disagreement moves a whole week, not a day.
 *
 * `null` (the default: follow this device's own zone) returns `now` untouched,
 * so the byte-identical no-override path is the same code as before.
 *
 * An unusable zone identifier falls back to the device clock rather than
 * throwing. That is not a swallowed error: `timezone` is stored as a free
 * string with no codec-level validation (`protocol.md` §9.5), so an unknown
 * value is a documented state, and the spec's rule for every free-string pref
 * is that the client maps an unknown value to the default. Throwing here would
 * make a stale or tampered pref break "open today" entirely.
 */
export function zonedNow(now: Date, timeZone: string | null): Date {
  if (timeZone == null || timeZone === "") return now;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return now;
  }
  const field = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = field("year");
  const month = field("month");
  const day = field("day");
  const hour = field("hour");
  const minute = field("minute");
  const second = field("second");
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return now;
  }
  // The TIME OF DAY comes across too, not just the calendar date. The same
  // instant feeds a template's `{{time}}` and `{{datetime}}`, so pinning an
  // arbitrary hour here would title a note with the override's date and stamp
  // its body with the device's clock: two definitions of "now" inside one note.
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

/** Resolution result: open the existing period note, or create one. */
export type DailyResolution =
  | { kind: "open"; id: NoteId; dateTitle: string }
  | { kind: "create"; dateTitle: string; folder: string | null };

/** [`resolvePeriodNote`]'s result, with the range the caller needs to fill the
 *  `{{period_start}}` / `{{period_end}}` template tokens on the create path. */
export type PeriodResolution = DailyResolution & { range: PeriodRange };

/**
 * Resolve a period's note (idempotent open-or-create). Pure: all clock input is
 * the caller-injected `now`, already converted to the display timezone by
 * `zonedNow` at the injection point.
 *
 * The match rule is unchanged from the daily-only version and deliberately so:
 * folder + title under case-fold + NFC, excluding trashed, tombstoned and
 * template notes. A renamed or moved period note therefore stops matching and
 * the next open makes a fresh one: predictable, not magical. Two periods
 * pointed at one folder with one format resolve to ONE note; Settings warns at
 * the moment that is configured rather than the rule being special-cased here.
 */
export function resolvePeriodNote(
  now: Date,
  period: Period,
  settings: PeriodSettings,
  notes: readonly TitleRecord[],
): PeriodResolution {
  const range = periodRange(now, period);
  const format = settings.format ?? PERIOD_DEFAULTS[period].format;
  const dateTitle = formatDailyDate(range.anchor, format);
  const folderNorm = normalizeFolderPath(settings.folder ?? PERIOD_DEFAULTS[period].folder);
  const wantFolder = folderNorm == null ? "" : foldSegment(folderNorm);
  const wantTitle = foldSegment(dateTitle);

  for (const n of notes) {
    // Exclude trashed + deleted (tombstoned) + templates (same machinery as the
    // sidebar live set).
    if (n.trashed != null || n.deleted != null || n.template === true) continue;
    if (folderKey(n.folder) !== wantFolder) continue;
    if (n.title == null || foldSegment(n.title) !== wantTitle) continue;
    return { kind: "open", id: n.noteUuid as NoteId, dateTitle, range };
  }
  return { kind: "create", dateTitle, folder: folderNorm, range };
}
