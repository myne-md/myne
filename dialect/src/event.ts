// The event vocabulary for calendar notes (myne-md/myne#1037).
//
// Spec: `myne-agents/docs/spec/markdown-dialect.md` §3.10 (the keys, their typing, all-day,
// the relative `remind` grammar) plus §3.6.1 (`kind: event`), §3.8.3 (wall-clock
// time, no offset, no IANA zone) and §3.8.7 (the CLOSED recurrence vocabulary,
// which this file reuses and never redefines).
//
// WHY THIS IS A DIALECT MODULE AND NOT CALENDAR CODE. An event is a NOTE. The
// reader therefore belongs beside the other value-strict frontmatter readers, so
// the same rules apply to a note the calendar shows and a note it does not: a
// value it cannot type is preserved and surfaced, never dropped and never
// corrected, exactly as §3.8.3 requires of an unparseable task field.
//
// TWO READERS EXIST, AND THE OTHER HALF OF THIS ONE IS IN RUST. The range query
// that the fifth agent tool depends on runs in the host process and cannot call
// TypeScript, so `myne-core` reads the same vocabulary from the typed property
// rows the index already carries. One committed fixture of (rule, start,
// occurrence) cases is read by both test suites, so a change to either side's
// answer fails the other. That is the same device the property-coercion vectors
// use across clients (§3.6.4).
//
// WALL CLOCK, DELIBERATELY. "09:00" means 09:00 wherever the reader is, and no
// offset is ever stored or emitted, so a plaintext export carries no coarse
// geolocation datum. An `.ics` value that carries a zone is converted to the
// importing device's wall clock at the boundary (the codec's job), which is the
// one place the two meanings of a time in a vault can differ.

import { compareCivilDates, formatCivilDate, parseCivilDate, type CivilDate } from "./civilDate";
import { isLegalSegment } from "./folderPath";
import { NEWLINE } from "./lezer/frontmatter";
import { parseRecurrenceRule, type ParsedRecurrence } from "./recurrence";
import { EVENT_KIND_VALUE, extractFmScalar, patchFrontmatterField, patchTitleField, readKindFromFmBody } from "./surgery";

/** The frontmatter keys of the event vocabulary (§3.10). */
export const EVENT_FIELD_KEYS = {
  start: "start",
  end: "end",
  calendar: "calendar",
  uid: "uid",
  repeat: "repeat",
  remind: "remind",
  skip: "skip",
  override: "override",
} as const;

/**
 * One point an event occupies: a civil date, plus a wall-clock time when the
 * event is timed. `time === null` means all day.
 *
 * The time is kept as the user's digits (`HH:MM` or `HH:MM:SS`) rather than as
 * seconds-since-midnight, because the emitted form is the stored form and a
 * normalizing round trip is the one thing §3.8.5's byte-stability rule forbids
 * a reader from doing.
 */
export type EventInstant = {
  readonly date: CivilDate;
  readonly time: string | null;
};

/** A relative reminder lead: `30m`, `2h`, `1d`. */
export type ReminderLead = {
  /** The bytes the file carries, trimmed. */
  readonly raw: string;
  readonly minutes: number;
  /**
   * Whether the lead reaches past the reminder horizon the caller supplied.
   * `false` when no horizon was supplied, because "too long" is a policy
   * question and this module only parses the grammar.
   */
  readonly beyondHorizon: boolean;
};

/** A complete, readable event. */
export type CalendarEvent = {
  readonly start: EventInstant;
  readonly end: EventInstant | null;
  readonly allDay: boolean;
  readonly calendar: string | null;
  readonly uid: string | null;
  /** The raw rule expression, preserved verbatim (§3.8.7). */
  readonly repeatRaw: string | null;
  /** The parsed rule. `ok: false` means "unrecognized", never "no repeat". */
  readonly repeat: ParsedRecurrence | null;
  readonly remind: ReminderLead | null;
  /**
   * The dates this series does NOT occur on (`skip: 2026-11-05, 2026-11-12`).
   *
   * A series with every occurrence cancelled still reads as an event: the note is
   * the event, and the list is one of its fields, so an empty range answer is a
   * legitimate result rather than a broken one. Unparseable entries are dropped
   * here and left in the file, because a reader that rewrote the field would be
   * editing a note the user did not ask it to touch.
   */
  readonly skip: readonly CivilDate[];
  /**
   * The occurrences whose START TIME differs from the rule's
   * (`override: 2026-11-10 14:00, 2026-11-17 13:30`).
   *
   * The narrowest shape that answers "not 09:00 this Tuesday": a date the rule
   * already generates, and a new wall-clock time for it. The date stays, the day
   * stays and the duration stays, so nothing here can disagree with the series
   * about WHAT happens or WHEN it ends, which is what keeps this from becoming the
   * second record `decisions/storage/0792` refuses (`0796` draws the bound).
   */
  readonly overrides: readonly EventInstant[];
};

/**
 * Why a note that claims to be an event cannot be shown as one.
 *
 * These are the sanctioned refusals of §3.10: each one names a shape Myne does
 * not write, and the surface renders the note in an unreadable group rather
 * than hiding it or repairing it.
 */
export type EventUnreadableReason =
  | "start-missing"
  | "start-unreadable"
  | "end-unreadable"
  | "end-before-start"
  | "end-time-without-start-time"
  | "calendar-unreadable";

/** What one note's frontmatter says about the calendar. */
export type EventRead =
  /** `kind:` is absent or carries another canonical value. Not an event. */
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: EventUnreadableReason }
  | { readonly state: "ok"; readonly event: CalendarEvent };

/** Options a caller may supply. Only the horizon reaches the parse result. */
export type EventReadOptions = {
  /**
   * The reminder horizon in days, from `REMINDER_HORIZON_DAYS`. A longer lead is
   * parsed and flagged, never dropped: the event is fine and the reminder is
   * the part the tier cannot honour.
   */
  readonly reminderHorizonDays?: number;
};

const FIELD_KEY_RES = {
  start: /^(start[ \t]*:[ \t]*)(.*)$/,
  end: /^(end[ \t]*:[ \t]*)(.*)$/,
  calendar: /^(calendar[ \t]*:[ \t]*)(.*)$/,
  uid: /^(uid[ \t]*:[ \t]*)(.*)$/,
  repeat: /^(repeat[ \t]*:[ \t]*)(.*)$/,
  remind: /^(remind[ \t]*:[ \t]*)(.*)$/,
  skip: /^(skip[ \t]*:[ \t]*)(.*)$/,
  override: /^(override[ \t]*:[ \t]*)(.*)$/,
} as const;

const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

const LEAD_RE = /^(\d{1,4})([mhd])$/i;

const MINUTES_PER_UNIT: Readonly<Record<string, number>> = { m: 1, h: 60, d: 1440 };

/**
 * Read every occurrence of a key, first match only, through the shared scalar
 * extractor so quoting and a trailing YAML comment behave exactly as they do for
 * every other value-strict field (`cover:` is the precedent for a value that can
 * legitimately contain `#` and `"`).
 */
function readField(fmBody: string, re: RegExp): string | null {
  for (const line of fmBody.split(NEWLINE)) {
    const m = re.exec(line);
    if (m === null) continue;
    return extractFmScalar(m[2] ?? "");
  }
  return null;
}

/**
 * Parse one `start` / `end` value: a full-date, optionally followed by a
 * wall-clock time separated by a space or `T`.
 *
 * Refuses rather than repairs, so `2026-02-31` is `null` and so is
 * `2026-11-05T09:00:00Z` (§3.8.3: a value carrying an offset does not type).
 */
export function parseEventInstant(value: string): EventInstant | null {
  const trimmed = value.trim();
  if (trimmed.length < 10) return null;
  const date = parseCivilDate(trimmed.slice(0, 10));
  if (date === null) return null;
  const rest = trimmed.slice(10);
  if (rest === "") return { date, time: null };
  const separator = rest[0];
  if (separator !== " " && separator !== "T") return null;
  const time = rest.slice(1).trim();
  const m = TIME_RE.exec(time);
  if (m === null) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = m[3] === undefined ? null : Number(m[3]);
  if (hours > 23 || minutes > 59) return null;
  if (seconds !== null && seconds > 59) return null;
  return {
    date,
    time: seconds === null ? `${m[1]}:${m[2]}` : `${m[1]}:${m[2]}:${m[3]}`,
  };
}

/**
 * The emitted form of one instant: `YYYY-MM-DD` for an all-day point, else
 * `YYYY-MM-DD HH:MM[:SS]` with a single space.
 *
 * The separator is the writer's choice and this is the only one: a `T` on disk
 * would be read back identically, so allowing both to be written is how one note
 * acquires two spellings and every save produces a spurious diff.
 */
export function formatEventInstant(instant: EventInstant): string {
  const date = formatCivilDate(instant.date);
  return instant.time === null ? date : `${date} ${instant.time}`;
}

/** Compare two instants on the date, then on the time. An all-day point sorts at the start of its day. */
function compareInstants(a: EventInstant, b: EventInstant): number {
  const byDate = compareCivilDates(a.date, b.date);
  if (byDate !== 0) return byDate;
  if (a.time === null && b.time === null) return 0;
  if (a.time === null) return -1;
  if (b.time === null) return 1;
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

/**
 * Parse a relative reminder lead (`30m`, `2h`, `1d`).
 *
 * `null` for anything outside the grammar, including `0m`: a lead of zero means
 * "at the start", which the absence of the field already means, so accepting it
 * would give one state two spellings.
 */
export function parseReminderLead(value: string): { raw: string; minutes: number } | null {
  const raw = value.trim();
  const m = LEAD_RE.exec(raw);
  if (m === null) return null;
  const count = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const perUnit = MINUTES_PER_UNIT[unit];
  if (perUnit === undefined || count < 1) return null;
  return { raw, minutes: count * perUnit };
}

/**
 * Read the calendar from one note's frontmatter body.
 *
 * The `kind:` read comes first, so a note that is not an event is `absent` and
 * costs one line scan. Everything after is refused rather than repaired, and the
 * distinctions matter: an event with **no** `start` is unreadable (the note
 * claims to be an event and does not say when), while a note with a `start` and
 * no `kind: event` is simply a note with a property named `start`.
 */
/**
 * How many cancelled dates one note may carry.
 *
 * A bound rather than trust: the field is user-editable text, and a hand-edited
 * note with ten thousand dates would make every range query walk them. The same
 * number bounds the wire, so a caller never sees a longer list than the readers
 * will honour.
 */
export const MAX_SKIP_DATES = 366;

/**
 * How many retimed occurrences one note may carry.
 *
 * Smaller than the skip bound because an override is a bigger record: 120 is more
 * than two years of a weekly series, and a longer list is a sign the user wants a
 * second series rather than a hundred exceptions.
 */
export const MAX_OVERRIDES = 120;

/**
 * Read `skip:` into civil dates.
 *
 * Separators are commas and whitespace, both accepted, because a user typing the
 * field by hand writes either. Anything unparseable is dropped rather than
 * refusing the event: a typo in a cancellation must not hide the series.
 */
export function parseSkipDates(raw: string | null): readonly CivilDate[] {
  if (raw === null) return [];
  const out: CivilDate[] = [];
  for (const token of raw.split(/[, \t]+/)) {
    if (token === "") continue;
    const date = parseCivilDate(token);
    if (date === null) continue;
    if (!out.some((seen) => compareCivilDates(seen, date) === 0)) out.push(date);
    if (out.length >= MAX_SKIP_DATES) break;
  }
  return out;
}

/**
 * Read `override:` into instants.
 *
 * One entry is `<date> <time>`; a bare date is dropped, because a bare date says
 * nothing this vocabulary can act on (a cancellation is `skip:`). Unparseable
 * entries are dropped for the same reason `parseSkipDates` drops them.
 */
export function parseOverrides(raw: string | null): readonly EventInstant[] {
  if (raw === null) return [];
  const out: EventInstant[] = [];
  // Entries carry a space between date and time, so the list separator must be a
  // comma only: splitting on whitespace would tear `2026-11-10 14:00` in half.
  for (const entry of raw.split(",")) {
    const instant = parseEventInstant(entry.trim());
    if (instant === null || instant.time === null) continue;
    if (!out.some((seen) => compareCivilDates(seen.date, instant.date) === 0)) out.push(instant);
    if (out.length >= MAX_OVERRIDES) break;
  }
  return out;
}

/**
 * `override:` with one date retimed, ordered, and the date replaced when it is
 * already there.
 *
 * Ordering and uniqueness exist for the byte-stability reason `appendSkipDate`
 * states: the field's bytes must be a function of its set, or two clients editing
 * two occurrences in either order produce two files for one schedule.
 */
export function setOverride(raw: string | null, instant: EventInstant): string {
  const kept = parseOverrides(raw).filter(
    (seen) => compareCivilDates(seen.date, instant.date) !== 0,
  );
  const next = [...kept, instant]
    .sort((left, right) => compareCivilDates(left.date, right.date))
    .map(formatEventInstant);
  // Same rule as `appendSkipDate`: an entry the reader could not type is kept as the
  // user wrote it, ahead of the normalised ones, rather than deleted by a writer that
  // never saw the user.
  // The predicate is `parseOverrides`' own, not "does it parse at all": a bare date
  // parses as an all-day instant and is still REFUSED as an override (it changes no
  // clock), so it belongs in the residuals rather than being silently dropped.
  const residuals = residualsOf(raw, (token) => {
    const parsed = parseEventInstant(token);
    return parsed !== null && parsed.time !== null;
  });
  return [...residuals, ...next].join(", ");
}

/** `override:` without the entry for `date`, or `null` when there was none. */
export function clearOverride(raw: string | null, date: CivilDate): string | null {
  const parsed = parseOverrides(raw);
  const kept = parsed.filter((seen) => compareCivilDates(seen.date, date) !== 0);
  if (kept.length === parsed.length) return null;
  return kept.map(formatEventInstant).join(", ");
}

/**
 * `skip:` with one more date, migrated and ordered, or `null` when the date is
 * already there.
 *
 * The ONE place that spells the field, so the desktop pane and the phone's list
 * cannot grow two orderings of the same list. Dates are unique and ascending,
 * which makes the field's bytes a function of its set: without that, two clients
 * cancelling two dates in either order would produce two different files for one
 * schedule and every sync would see a conflict nobody made.
 */
export function appendSkipDate(raw: string | null, date: CivilDate): string | null {
  const dates = parseSkipDates(raw);
  if (dates.some((seen) => compareCivilDates(seen, date) === 0)) return null;
  // Anything the reader could not type is kept VERBATIM, ahead of the normalised
  // entries. Dumping the parsed set back out deletes a user's own typo, and
  // `2026-11-5` is a typo a person means rather than one they want removed, so
  // cancelling one occurrence would silently resurrect another week. §3.10.1 says
  // such an entry is dropped by the READER and left in the file; this is the writer
  // honouring the same sentence.
  const next = [...dates, date].sort(compareCivilDates).map(formatCivilDate);
  const residuals = residualsOf(raw, (token) => parseCivilDate(token) !== null);
  return [...residuals, ...next].join(", ");
}

/** The tokens of `raw` that `keep` rejects, in file order, deduplicated. */
function residualsOf(raw: string | null, keep: (token: string) => boolean): string[] {
  if (raw === null) return [];
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (trimmed === "" || keep(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** What a brand-new event note says, before any client's folder handling. */
export type NewEventNote = {
  readonly title: string;
  readonly start: EventInstant;
  readonly end?: EventInstant | null;
  readonly repeat?: string | null;
  readonly remind?: string | null;
  readonly calendar?: string | null;
  readonly uid?: string | null;
};

/**
 * The plaintext a brand-new event is created with.
 *
 * ONE builder, because it was two and the copies had already drifted: the phone wrote
 * no `uid` and ordered `repeat` before `calendar` where the desktop did the reverse,
 * so the comment in `mobile/src/lib/eventWrite.ts` claiming a phone-created note is
 * byte-identical to a laptop-created one was false. The field SET and its ORDER are
 * the contract here, and a second copy of a contract is a second contract.
 *
 * `folder` is the caller's: it arrives through the create command rather than as a
 * frontmatter patch on this base, and the two clients pass it through the same
 * `normalizeFolderPath`.
 */
export function eventNoteBytes(input: NewEventNote): Uint8Array {
  const encoder = new TextEncoder();
  let bytes = patchTitleField(encoder.encode(""), input.title);
  bytes = patchFrontmatterField(bytes, "kind", EVENT_KIND_VALUE);
  bytes = patchFrontmatterField(bytes, "start", formatEventInstant(input.start));
  if (input.end !== undefined && input.end !== null) {
    bytes = patchFrontmatterField(bytes, "end", formatEventInstant(input.end));
  }
  if (input.calendar !== undefined && input.calendar !== null && input.calendar !== "") {
    bytes = patchFrontmatterField(bytes, "calendar", input.calendar);
  }
  if (input.repeat !== undefined && input.repeat !== null && input.repeat !== "") {
    bytes = patchFrontmatterField(bytes, "repeat", input.repeat);
  }
  if (input.remind !== undefined && input.remind !== null && input.remind !== "") {
    bytes = patchFrontmatterField(bytes, "remind", input.remind);
  }
  if (input.uid !== undefined && input.uid !== null && input.uid !== "") {
    bytes = patchFrontmatterField(bytes, "uid", input.uid);
  }
  return bytes;
}

/** The hour an all-day event's relative reminder counts back from. */
export const DEFAULT_DAY_ANCHOR = "09:00";

/**
 * The day anchor a settings map names, or {@link DEFAULT_DAY_ANCHOR}.
 *
 * The one resolver, shared by every client, because `calendar_settings` is a SHARED
 * pref: its value reaches a device through the per-key merge, so a client that
 * trusted the writer's validation would be trusting a value its own setter never
 * produced. Read-side and total: a value that is not `HH:MM` becomes the default
 * rather than an `Invalid Date` downstream, which is how an all-day reminder used to
 * vanish silently on one client and not the other.
 */
export function resolveDayAnchor(raw: string | undefined | null): string {
  if (typeof raw !== "string") return DEFAULT_DAY_ANCHOR;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(raw) ? raw : DEFAULT_DAY_ANCHOR;
}

export function readEventFromFmBody(fmBody: string, options?: EventReadOptions): EventRead {
  if (readKindFromFmBody(fmBody) !== EVENT_KIND_VALUE) return { state: "absent" };

  const startRaw = readField(fmBody, FIELD_KEY_RES.start);
  if (startRaw === null) return { state: "unreadable", reason: "start-missing" };
  const start = parseEventInstant(startRaw);
  if (start === null) return { state: "unreadable", reason: "start-unreadable" };

  const endRaw = readField(fmBody, FIELD_KEY_RES.end);
  const end = endRaw === null ? null : parseEventInstant(endRaw);
  if (endRaw !== null && end === null) return { state: "unreadable", reason: "end-unreadable" };
  if (end !== null && start.time === null && end.time !== null) {
    return { state: "unreadable", reason: "end-time-without-start-time" };
  }
  if (end !== null && compareInstants(end, start) < 0) {
    return { state: "unreadable", reason: "end-before-start" };
  }

  const calendarRaw = readField(fmBody, FIELD_KEY_RES.calendar);
  if (calendarRaw !== null && !isLegalSegment(calendarRaw)) {
    return { state: "unreadable", reason: "calendar-unreadable" };
  }

  const uid = readField(fmBody, FIELD_KEY_RES.uid);
  const repeatRaw = readField(fmBody, FIELD_KEY_RES.repeat);
  const remindRaw = readField(fmBody, FIELD_KEY_RES.remind);
  const skipRaw = readField(fmBody, FIELD_KEY_RES.skip);
  const overrideRaw = readField(fmBody, FIELD_KEY_RES.override);

  let remind: ReminderLead | null = null;
  if (remindRaw !== null) {
    const lead = parseReminderLead(remindRaw);
    if (lead !== null) {
      const horizon = options?.reminderHorizonDays;
      remind = {
        raw: lead.raw,
        minutes: lead.minutes,
        beyondHorizon: horizon === undefined ? false : lead.minutes > horizon * 1440,
      };
    }
  }

  return {
    state: "ok",
    event: {
      start,
      end,
      allDay: start.time === null,
      calendar: calendarRaw,
      uid,
      repeatRaw,
      repeat: repeatRaw === null ? null : parseRecurrenceRule(repeatRaw),
      remind,
      skip: parseSkipDates(skipRaw),
      overrides: parseOverrides(overrideRaw),
    },
  };
}
