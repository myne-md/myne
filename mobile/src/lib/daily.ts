// Daily notes — the mobile port of the desktop `src/notes/dailyNote.ts` +
// `newNoteFromTemplate.ts`. Pure resolver (clock injected as `now`) + create
// helpers over the byte-exact template engine + frontmatter surgery, so a daily
// note created on mobile matches desktop (folder/title/template identical).

import { renderTemplate } from "../dialect/templateEngine";
import { patchTitleField, patchFolderField } from "../dialect/surgery";
import { locateFrontmatter } from "../dialect/lezer/frontmatter";
import { normalizeFolderPath, foldSegment, folderKey } from "../dialect/folderPath";
import {
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTime,
  formatLocalWeekday,
} from "./localDateTime";
import { noteRead, noteCreate } from "./notes";
import { stampUpdated } from "./note-organize";

export const DEFAULT_DAILY_FOLDER = "Daily/";
export const DEFAULT_DAILY_DATE_FORMAT = "YYYY-MM-DD";

const pad2 = (n: number): string => String(n).padStart(2, "0");

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Monday = 0 … Sunday = 6, for a UTC-held calendar date. */
const mondayIndex = (d: Date): number => (d.getUTCDay() + 6) % 7;

/** ISO 8601 week identity for a LOCAL calendar date: week-year + 1-based week.
 *  Weeks start Monday, week 1 holds the year's first Thursday, so 2027-01-01 is
 *  2026-W53. The WEEK-YEAR is load-bearing: a calendar year splits that one week
 *  across two titles, and the match rule keys on folder + title, so that is one
 *  week with two notes. Mirrors `src/notes/dailyNote.ts::isoWeek` exactly. */
export function isoWeek(now: Date): { weekYear: number; week: number } {
  const thursday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  thursday.setUTCDate(thursday.getUTCDate() - mondayIndex(thursday) + 3);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - mondayIndex(firstThursday) + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / MS_PER_WEEK);
  return { weekYear, week };
}

/** Format `now` into a date title. Tokens, longest first: `YYYY` (calendar
 *  year), `gggg` (ISO week-year), `MM`, `DD`, `ww` (ISO week). A `[...]` run is
 *  literal with the brackets stripped, so `gggg-[W]ww` gives `2026-W35`; an
 *  unterminated `[` is itself literal. Local clock. One left-to-right pass, so
 *  nothing emitted is eligible for another token match. The escape exists
 *  because every week format wants a literal `W` beside the `ww` token, which
 *  successive replaces cannot disambiguate (myne#177). Mirrors
 *  `src/notes/dailyNote.ts::formatDailyDate` exactly. */
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

/** Re-express `now` as a Date whose LOCAL calendar fields are `timeZone`'s
 *  (myne#177). Everything downstream reads the local getters, so converting once
 *  at the injection point is the whole of honouring the `timezone` display
 *  override. Without it the app shows one date and files under another. `null`
 *  returns `now` untouched. An unusable zone falls back to the device clock,
 *  which is the documented handling for every free-string pref (protocol.md
 *  §9.5): unknown value maps to the default rather than breaking the flow.
 *  Carries the zone's time of day as well as its date, because the same instant
 *  feeds a template's `{{time}}`. Mirrors `src/notes/dailyNote.ts::zonedNow`. */
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
  // its body with the device's clock: two definitions of "now" in one note.
  return new Date(year, month - 1, day, hour, minute, second, 0);
}

export type DailyResolution =
  | { kind: "open"; id: string; dateTitle: string }
  | { kind: "create"; dateTitle: string; folder: string | null };

/** A live note candidate for daily-note matching. */
export interface DailyCandidate {
  id: string;
  title: string;
  folder: string | null;
}

/** The periods with first-class support (myne#177). Mirrors
 *  `src/notes/dailyNote.ts::PERIODS`. */
export const PERIODS = ["daily", "weekly", "monthly"] as const;
export type Period = (typeof PERIODS)[number];

/** Canonical defaults per period, applied host-side when a setting is unset.
 *  Mirrors `src/notes/dailyNote.ts::PERIOD_DEFAULTS` exactly, because the two clients
 *  must file a period note in the same folder under the same title, or the same
 *  vault gets two notes for one week. */
export const PERIOD_DEFAULTS: Record<Period, { folder: string; format: string }> = {
  daily: { folder: DEFAULT_DAILY_FOLDER, format: DEFAULT_DAILY_DATE_FORMAT },
  weekly: { folder: "Weekly/", format: "gggg-[W]ww" },
  monthly: { folder: "Monthly/", format: "YYYY-MM" },
};

/** The three things a period configures, resolved from prefs. */
export type PeriodSettings = {
  folder: string | null;
  format: string | null;
  template: string | null;
};

/** The shape of the prefs this module reads (structural, so the module does not
 *  import the client's `PrefsView`). */
export type PeriodPrefs = {
  daily_folder: string | null;
  daily_date_format: string | null;
  daily_template: string | null;
  periodic_notes: Record<string, string>;
};

/** Resolve one period's settings out of prefs. Daily reads the three legacy
 *  top-level fields, the others read the `periodic_notes` map; a `daily.*` entry
 *  in the map is IGNORED, so a client that writes one cannot give a single
 *  setting two homes. Mirrors `src/notes/dailyNote.ts::periodSettings`. */
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

/** The inclusive day range `now` falls in for `period`, plus the anchor its
 *  title is formatted from, which is the range's FIRST day for every period. That is
 *  what makes "open this week" idempotent from any day of that week. Weeks
 *  start Monday (ISO 8601). Mirrors `src/notes/dailyNote.ts::periodRange`. */
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
      const offset = (now.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
      const start = atNoon(y, m, d - offset);
      return { anchor: start, start, end: atNoon(y, m, d - offset + 6) };
    }
    case "monthly": {
      const start = atNoon(y, m, 1);
      // Day 0 of the NEXT month is the last day of this one, February and leap
      // years included, with no table.
      return { anchor: start, start, end: atNoon(y, m + 1, 0) };
    }
  }
}

/** [`resolvePeriodNote`]'s result, with the range the caller needs to fill the
 *  `{{period_start}}` / `{{period_end}}` template tokens on the create path. */
export type PeriodResolution = DailyResolution & { range: PeriodRange };

/** Idempotent open-or-create resolver for a period's note. Pure (clock =
 *  `now`). Match = folder + date-title under case-fold. Caller passes only LIVE
 *  notes. Mirrors `src/notes/dailyNote.ts::resolvePeriodNote`. */
export function resolvePeriodNote(
  now: Date,
  period: Period,
  settings: PeriodSettings,
  notes: readonly DailyCandidate[],
): PeriodResolution {
  const range = periodRange(now, period);
  const dateTitle = formatDailyDate(range.anchor, settings.format ?? PERIOD_DEFAULTS[period].format);
  const folderNorm = normalizeFolderPath(settings.folder ?? PERIOD_DEFAULTS[period].folder);
  const wantFolder = folderNorm == null ? "" : foldSegment(folderNorm);
  const wantTitle = foldSegment(dateTitle);
  for (const n of notes) {
    if (folderKey(n.folder) !== wantFolder) continue;
    if (foldSegment(n.title) !== wantTitle) continue;
    return { kind: "open", id: n.id, dateTitle, range };
  }
  return { kind: "create", dateTitle, folder: folderNorm, range };
}

// ── Create ──────────────────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function buildRenderContext(now: Date, title: string, period?: { start: Date; end: Date }) {
  return {
    title,
    date: formatLocalDate(now),
    time: formatLocalTime(now),
    datetime: formatLocalDateTime(now),
    weekday: formatLocalWeekday(now),
    // myne#177. Absent `period`, the period is the single day `now` falls on,
    // so the two tokens are never empty. `{{date}}` keeps meaning today in
    // every context on purpose. See src/notes/newNoteFromTemplate.ts.
    periodStart: formatLocalDate(period?.start ?? now),
    periodEnd: formatLocalDate(period?.end ?? now),
  };
}

/** Strip the template's frontmatter block (+ one leading blank line). */
function extractTemplateBody(plaintext: string): string {
  const fm = locateFrontmatter(plaintext);
  if (fm === null) return plaintext;
  let body = plaintext.slice(fm.blockEnd);
  if (body.startsWith("\n")) body = body.slice(1);
  return body;
}

async function createNoteFromBody(body: string, name: string, folder: string | null): Promise<string> {
  let bytes: Uint8Array = enc.encode(body);
  bytes = patchTitleField(bytes, name);
  const nf = normalizeFolderPath(folder);
  if (nf !== null) bytes = patchFolderField(bytes, nf);
  // `nf` is the folder this note is being filed into, and it was dropped:
  // the daily folder is the single most likely folder to be emptied by
  // trashing its notes, which is the case the unlock back-fill cannot cover
  // because it walks LIVE notes (myne#613 review round 2).
  return await noteCreate(stampUpdated(dec.decode(bytes)), nf);
}

/** Create a blank note with a given title + folder; resolves to the new id. */
export async function createBlankNamedNote(name: string, folder: string | null): Promise<string> {
  return createNoteFromBody("", name, folder);
}

/** Instantiate a template note (render `{{tokens}}`) with a title + folder. The
 *  new note carries neither the template's `template:` flag nor its title. */
export async function createNoteFromTemplate(
  templateId: string,
  name: string,
  folder: string | null,
  now: Date,
  period?: { start: Date; end: Date },
): Promise<string> {
  const body = extractTemplateBody(await noteRead(templateId));
  const rendered = renderTemplate(body, buildRenderContext(now, name, period));
  return createNoteFromBody(rendered, name, folder);
}
