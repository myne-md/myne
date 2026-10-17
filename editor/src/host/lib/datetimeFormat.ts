// One place that decides how a date or a time is PRINTED (myne#279).
//
// Before this module four surfaces formatted dates four different ways: task
// rows emitted raw ISO and silently dropped any time, saved-view property cells
// used a hardcoded `en-GB` formatter in `UTC`, attachment and paired-extension
// dates followed the OS locale, and daily-note titles followed a pref that
// existed only for filenames. A user with the app in Turkish still got British
// date formatting in saved views, and it was not a fallback — it was a literal.
//
// # What the settings do, and what they deliberately do NOT do
//
// `dialect/src/taskFields.ts` states the on-disk rule these settings must not
// walk back:
//
//   > No timezone offset and no zone identifier is ever produced. Times are
//   > local wall-clock: "09:00" means 09:00 wherever the user is, which is what
//   > a personal reminder means, and it keeps a coarse geolocation datum out of
//   > a file that gets exported as plaintext.
//
// So this module is display-side only, and the zone setting has a narrower job
// than it first appears. A stored note date or time is **zone-free wall-clock**:
// converting it would not just be unnecessary, it would be WRONG — a reminder
// written as 09:00 must read 09:00 on every device, and shifting it by a zone
// offset would invent an instant the user never wrote. The zone therefore
// applies to exactly two things:
//
//   1. **what counts as "today"** ({@link todayIn}), and
//   2. **absolute instants** ({@link formatInstant}) — an attachment's
//      `created_at` is UNIX seconds, a real moment on the timeline, and printing
//      it in a chosen zone is meaningful.
//
// Note-authored civil dates and wall-clock times go through
// {@link formatCivilDate} / {@link formatWallClockTime}, which never convert.
//
// Every function is pure: the settings arrive as a {@link DateTimeDisplay}
// value, so the formatting is unit-testable with no prefs, no clock and no
// React. `displayFromPrefs` is the only adapter, and the React binding lives in
// the host app.

import { isRealDate } from "@myne/dialect/dates";

/** The closed date-format vocabulary. Closed rather than free-text, for the
 *  same reason the recurrence vocabulary is: a pattern string is a mini-language
 *  to validate, localize and round-trip, for a setting most people set once. */
export const DATE_FORMATS = ["system", "iso", "dmy", "mdy", "dmmmy"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** The closed time-format vocabulary. */
export const TIME_FORMATS = ["system", "24h", "12h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

/** Resolved display settings. Pure data — every formatter here takes one. */
export interface DateTimeDisplay {
  readonly dateFormat: DateFormat;
  readonly timeFormat: TimeFormat;
  /** IANA zone identifier, or `null` to follow the host's own zone. */
  readonly timeZone: string | null;
  /**
   * BCP-47 tag the `system` presets resolve against.
   *
   * The app's OWN language, not the OS locale. Following the OS would silently
   * split from the language the user actually picked in Myne — the objection
   * that made "just use the OS locale everywhere" the wrong answer to this.
   */
  readonly locale: string;
}

/** Every setting unset: `system` everything, host zone, English. */
export const DEFAULT_DISPLAY: DateTimeDisplay = {
  dateFormat: "system",
  timeFormat: "system",
  timeZone: null,
  locale: "en",
};

/**
 * Degrade a stored value to the default rather than trusting it.
 *
 * Exported (myne-md/myne#609) because both settings surfaces need exactly this
 * and each had grown a private copy: three coercers for one rule, so adding a
 * member to {@link DATE_FORMATS} meant finding all three, and the two surfaces
 * could silently disagree about what an unknown wire value degrades to. This
 * module owns the vocabulary, so it owns the coercion.
 */
export function asDateFormat(raw: string | null | undefined): DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(raw ?? "")
    ? (raw as DateFormat)
    : "system";
}

/** The time-format twin of {@link asDateFormat}, exported for the same reason. */
export function asTimeFormat(raw: string | null | undefined): TimeFormat {
  return (TIME_FORMATS as readonly string[]).includes(raw ?? "")
    ? (raw as TimeFormat)
    : "system";
}

/**
 * Whether `zone` is a zone this runtime can actually format in.
 *
 * The pref is a free string on the wire, so an unrecognised value has to degrade
 * to the host zone rather than throw — `Intl.DateTimeFormat` raises a
 * `RangeError` on an unknown `timeZone`, and a date cell is not worth an
 * exception.
 */
export function isSupportedTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Shape of the three prefs this reads. Structural, so both clients' `PrefsView`
 *  satisfy it without importing each other. */
export interface DateTimePrefsSlice {
  readonly date_format?: string | null;
  readonly time_format?: string | null;
  readonly timezone?: string | null;
}

/**
 * Resolve stored prefs into display settings.
 *
 * Every field degrades to its default rather than failing: the wire carries free
 * strings (the `editor_content_width` precedent class), so an unknown format or
 * an unsupported zone means "unset", never "broken".
 */
export function displayFromPrefs(
  prefs: DateTimePrefsSlice | null | undefined,
  locale: string = DEFAULT_DISPLAY.locale,
): DateTimeDisplay {
  const zone = prefs?.timezone ?? null;
  return {
    dateFormat: asDateFormat(prefs?.date_format),
    timeFormat: asTimeFormat(prefs?.time_format),
    timeZone: zone !== null && zone !== "" && isSupportedTimeZone(zone) ? zone : null,
    locale,
  };
}

/** `YYYY-MM-DD` — the normative civil-date shape (`markdown-dialect.md` §3.6.4). */
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `HH:MM` (optionally `:SS`) — the normative wall-clock-time shape. */
const WALL_CLOCK = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Split a stored value into its civil-date and wall-clock-time halves. Either
 *  may be absent; a value this does not recognise yields both `null`. */
export function splitStoredValue(value: string): {
  date: string | null;
  time: string | null;
} {
  const t = value.trim();
  if (t === "") return { date: null, time: null };
  if (CIVIL_DATE.test(t)) return { date: t, time: null };
  const at = t.indexOf("T") >= 0 ? t.indexOf("T") : t.indexOf(" ");
  if (at > 0) {
    const head = t.slice(0, at);
    const tail = t.slice(at + 1);
    if (CIVIL_DATE.test(head)) {
      const m = WALL_CLOCK.exec(tail);
      return { date: head, time: m === null ? null : `${m[1]}:${m[2]}` };
    }
  }
  return { date: null, time: null };
}

/** Cache: constructing an `Intl.DateTimeFormat` is the expensive part, and
 *  these are called once per rendered row. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function intl(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let f = formatterCache.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, f);
  }
  return f;
}

/**
 * Print a stored civil date (`YYYY-MM-DD`).
 *
 * **No zone conversion.** A civil date names a calendar day, not an instant, so
 * it must show the same day everywhere — this is the off-by-one that hit every
 * user west of UTC when a date-only value was run through a zoned formatter.
 * The `system` preset therefore anchors at `T00:00:00Z` and formats in `UTC`,
 * which is the only way to make `Intl` agree.
 *
 * An unparseable value is returned verbatim: never throws, never blank.
 */
export function formatCivilDate(value: string, display: DateTimeDisplay): string {
  const m = CIVIL_DATE.exec(value.trim());
  if (m === null) return value;
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  switch (display.dateFormat) {
    case "iso":
      return `${y}-${mo}-${d}`;
    case "dmy":
      return `${d}/${mo}/${y}`;
    case "mdy":
      return `${mo}/${d}/${y}`;
    case "dmmmy":
    case "system": {
      const ms = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
      if (Number.isNaN(ms)) return value;
      return intl(display.locale, INTL_DATE_OPTIONS[display.dateFormat]).format(new Date(ms));
    }
  }
}

/**
 * The `Intl` options behind the two presets this module does not spell itself.
 *
 * One table rather than a literal inside {@link formatCivilDate}, because
 * {@link parseDisplayDate} reads these formats back by running this same printer
 * over candidate days (myne-md/myne#609). Two copies of the options would let
 * the reader search for a string the printer never emits.
 *
 * `dmmmy` asks for a SPELLED month and lets the locale place it: `Intl` picks
 * the field order either way, so in English the two presets print the same
 * string and in German they do not (`1. Aug. 2026` against `01.08.2026`). This
 * comment used to claim `dmmmy` pinned the order, which is the sentence a test
 * asserting `1 Aug 2026` was believing when it failed.
 */
const INTL_DATE_OPTIONS: Record<"dmmmy" | "system", Intl.DateTimeFormatOptions> = {
  dmmmy: { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" },
  system: { timeZone: "UTC", dateStyle: "medium" },
};

/** `DD/MM/YYYY` or `MM/DD/YYYY` - the two presets whose grammar this module
 *  writes itself, and therefore the two it can read back leniently. */
const SLASHED_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * The Gregorian years {@link parseDisplayDate} will consider for the two
 * `Intl`-shaped presets.
 *
 * Absolute rather than relative to today, deliberately: reading a clock here
 * would make the same query answer differently on New Year's Eve, and every
 * function in this module is pure so its tests need no clock.
 */
const SEARCHABLE_YEARS = { first: 1900, last: 2100 } as const;

/**
 * How many candidate years one query may open before this gives up.
 *
 * A year token is normally unique to one Gregorian year, and two at most where
 * the locale's calendar year straddles the Gregorian one. The cap is a bound on
 * the work, not a rule about dates: without it a pathological query could ask
 * for two centuries of formatting on one keystroke.
 */
const MAX_CANDIDATE_YEARS = 4;

/**
 * Fold a printed date and a typed one onto the same string.
 *
 * Three differences are noise rather than disagreement, and each one is a real
 * output of `Intl` rather than a hypothetical: the bidi marks Arabic and Urdu
 * wrap numerals in, the non-breaking and narrow-no-break spaces several locales
 * put between fields, and letter case in a month name. Anything else survives,
 * the digits included: a locale that prints Bengali or Persian numerals is
 * matched only by a query carrying them, which is the honest answer rather than
 * a transliteration this module would have to invent.
 */
function normalizeTyped(text: string): string {
  return text
    // Escaped rather than written literally: these three are invisible, and a
    // raw control byte in this file already cost a day once, when every shell
    // tool started reading it as binary and the guards silently skipped it.
    .replace(/[\u200e\u200f\u061c]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Per locale and preset: every year token the printer emits, mapped to the
 *  Gregorian years that emit it. Built once; see {@link yearTokens}. */
const yearTokenCache = new Map<string, Map<string, number[]>>();

/**
 * Which Gregorian years could a query be talking about?
 *
 * Probed, never parsed. The year a locale PRINTS is not always the Gregorian
 * one: `th` prints the Buddhist year (2569 for 2026) and `fa` the Persian one
 * (1405), so pulling a four-digit run out of the query and calling it a year is
 * wrong on two of the shipped catalogs. Asking the formatter what it prints for
 * each year is right on all of them, and stays right for a calendar added later,
 * because it assumes no mapping at all.
 *
 * Two probes per year, six months apart, because a calendar whose year boundary
 * falls inside the Gregorian one makes one Gregorian year print two different
 * year tokens. A single probe indexes only the first of them, which is how a
 * Persian-calendar reader searching an August date would have found nothing.
 */
function yearTokens(locale: string, format: "dmmmy" | "system"): Map<string, number[]> {
  const key = `${format} ${locale}`;
  const hit = yearTokenCache.get(key);
  if (hit !== undefined) return hit;
  const f = intl(locale, INTL_DATE_OPTIONS[format]);
  const index = new Map<string, number[]>();
  for (let y = SEARCHABLE_YEARS.first; y <= SEARCHABLE_YEARS.last; y += 1) {
    for (const probeMonth of [0, 6]) {
      const parts = f.formatToParts(new Date(Date.UTC(y, probeMonth, 1)));
      const token = normalizeTyped(parts.find((part) => part.type === "year")?.value ?? "");
      if (token === "") continue;
      const bucket = index.get(token);
      if (bucket === undefined) index.set(token, [y]);
      else if (!bucket.includes(y)) bucket.push(y);
    }
  }
  yearTokenCache.set(key, index);
  return index;
}

/**
 * Read back a date printed by `Intl`, by running the printer over candidate days
 * and comparing.
 *
 * The inversion is the point. `system` and `dmmmy` have no grammar this module
 * owns: field order, separators, month spelling, numeral system and even the
 * calendar all come from the host's locale data. Writing a parser for that means
 * writing a second, weaker copy of `Intl`, and a copy that disagreed with the
 * printer would hand the search a string no chip in the note can be showing.
 * Comparing against the printer's own output cannot disagree with it.
 *
 * The cost is bounded and paid rarely: at most {@link MAX_CANDIDATE_YEARS} times
 * 372 formats on a cached formatter, and only on a query that already matched
 * nothing in the note.
 */
function matchPrintedDate(
  text: string,
  display: DateTimeDisplay,
  format: "dmmmy" | "system",
): string | null {
  const typed = normalizeTyped(text);
  if (typed === "") return null;

  const years: number[] = [];
  for (const [token, bucket] of yearTokens(display.locale, format)) {
    if (!typed.includes(token)) continue;
    for (const y of bucket) if (!years.includes(y)) years.push(y);
  }
  if (years.length === 0 || years.length > MAX_CANDIDATE_YEARS) return null;

  for (const y of years) {
    for (let month = 1; month <= 12; month += 1) {
      for (let day = 1; day <= 31; day += 1) {
        if (!isRealDate(y, month, day)) continue;
        const iso = `${String(y).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (normalizeTyped(formatCivilDate(iso, display)) === typed) return iso;
      }
    }
  }
  return null;
}

/**
 * Read a date the way the user WRITES it back into the stored `YYYY-MM-DD`, or
 * `null` when it is not a date in their chosen format (myne-md/myne#609).
 *
 * The inverse of {@link formatCivilDate}, and deliberately a partial one.
 *
 * **Only the user's currently selected format is tried.** Trying all of them
 * would make `01/08/2026` ambiguous, since it is a real date under both the
 * day-first and month-first presets and a different one under each, and
 * resolving that would mean searching two strings, which is the alternation the
 * in-note find deliberately has no way to express. One format in, one answer
 * out, or nothing.
 *
 * **Two readers, because there are two kinds of preset.** `dmy` and `mdy` are
 * spelled out in {@link formatCivilDate} as this module's own grammar, so they
 * are read with a regular expression that is deliberately more lenient than the
 * printer: the printer pads (`01/08/2026`) and the reader also accepts what a
 * person types (`1/8/2026`). `system` and `dmmmy` have no grammar this module
 * owns, so they go to {@link matchPrintedDate}, which runs the printer over
 * candidate days rather than writing a second copy of `Intl`.
 *
 * `system` is covered rather than excluded, and that is the whole reason the
 * second reader exists. It is the DEFAULT, so excluding it would have shipped
 * this feature switched off for everyone who never opened the setting. That is
 * not a narrow gap, it is the common case, and the first version of this
 * function had it.
 *
 * `iso` returns `null`, which is not a gap: the typed text already IS the stored
 * form, so there is nothing to translate and no second search worth running.
 *
 * A syntactically well-formed value that is not a real day (`31/02/2026`)
 * returns `null` rather than a rolled-over date. Rolling over would answer a
 * question the user did not ask.
 *
 * The calendar check is the dialect's own `isRealDate`, not a second one written
 * here. That matters more than tidiness: this function's output is fed straight
 * into a search for a stored form, and the ONLY thing that can have written such
 * a form is `parseTaskInstant`, which validates with that same predicate. Two
 * predicates would let this produce an ISO string no chip can be carrying, so
 * the search would come back empty for a reason nobody could see. A first
 * version did round-trip the date through `Date.parse` instead, and the two
 * already disagreed: `isRealDate` builds through `Date.UTC`, which remaps a
 * two-digit year, so `01/08/0026` is rejected there and was accepted here.
 * Consuming the sibling makes the pair agree by construction; whether the remap
 * is right is the dialect's question, not this module's.
 */
export function parseDisplayDate(text: string, display: DateTimeDisplay): string | null {
  if (display.dateFormat === "iso") return null;
  if (display.dateFormat === "dmy" || display.dateFormat === "mdy") {
    const m = SLASHED_DATE.exec(text.trim());
    if (m === null) return null;
    const [, a, b, y] = m as unknown as [string, string, string, string];
    const day = display.dateFormat === "dmy" ? a : b;
    const month = display.dateFormat === "dmy" ? b : a;
    if (!isRealDate(Number(y), Number(month), Number(day))) return null;
    return `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return matchPrintedDate(text, display, display.dateFormat);
}

/**
 * Print a stored wall-clock time (`HH:MM`).
 *
 * **No zone conversion**, for the reason in the module header: "09:00" means
 * 09:00 wherever the user is. Only the 12/24-hour presentation is a choice.
 */
export function formatWallClockTime(value: string, display: DateTimeDisplay): string {
  const m = WALL_CLOCK.exec(value.trim());
  if (m === null) return value;
  const hh = Number(m[1]);
  const mm = m[2]!;
  if (!Number.isFinite(hh) || hh > 23) return value;
  if (display.timeFormat === "24h") return `${String(hh).padStart(2, "0")}:${mm}`;
  if (display.timeFormat === "12h") {
    const suffix = hh < 12 ? "AM" : "PM";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${mm} ${suffix}`;
  }
  // `system`: let the locale decide, but keep the value zone-free by anchoring
  // in UTC and formatting in UTC — the clock digits must survive untouched.
  const ms = Date.parse(`1970-01-01T${String(hh).padStart(2, "0")}:${mm}:00Z`);
  if (Number.isNaN(ms)) return value;
  return intl(display.locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/**
 * Print a stored value that may carry a date, a time, or both — the shape task
 * rows and property cells actually hold. Neither half is zone-converted.
 *
 * A value this does not recognise is returned verbatim, so an unexpected string
 * is shown rather than swallowed.
 */
export function formatStoredValue(value: string, display: DateTimeDisplay): string {
  const { date, time } = splitStoredValue(value);
  if (date === null) return value;
  const printed = formatCivilDate(date, display);
  return time === null ? printed : `${printed} ${formatWallClockTime(time, display)}`;
}

/**
 * Print an ABSOLUTE instant — a real moment on the timeline, such as an
 * attachment's `created_at` in UNIX seconds.
 *
 * This is the one direction where the zone setting genuinely converts, because
 * the value genuinely names an instant rather than a wall-clock reading.
 */
export function formatInstant(
  instant: Date | number,
  display: DateTimeDisplay,
  opts: { readonly withTime?: boolean } = {},
): string {
  const d = typeof instant === "number" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return "";
  const zone = display.timeZone ?? undefined;
  if (display.dateFormat !== "system" || opts.withTime !== true) {
    // Reduce the instant to its civil date IN THE DISPLAY ZONE, then hand it to
    // the same civil-date printer every other surface uses — so an explicit
    // preset applies here too instead of quietly falling back to the locale.
    // `civilDateIn`, not `.format(…)`: see its own doc for the runtime where the
    // layout-based read handed `formatCivilDate` a string it could not match,
    // which made this comment false.
    const parts = civilDateIn(
      intl("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
      d,
    );
    const printed = formatCivilDate(parts, display);
    if (opts.withTime !== true) return printed;
    const clock = intl("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    return `${printed} ${formatWallClockTime(clock, display)}`;
  }
  return intl(display.locale, {
    timeZone: zone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/**
 * The `YYYY-MM-DD` civil date an `Intl.DateTimeFormat` probe renders, assembled
 * from `formatToParts` rather than from `format()`'s LAYOUT.
 *
 * **Three call sites used to write `Intl.DateTimeFormat("en-CA", …).format(…)`
 * and each carried a comment saying en-CA renders `YYYY-MM-DD` "so no
 * part-by-part reassembly is needed". That is a property of the ICU DATA, not of
 * the API, and it is not true everywhere.** Measured on the WebKitGTK the desktop
 * E2E runs against (2026-10-17): `Intl.DateTimeFormat("en-CA", {year:"numeric",
 * month:"2-digit", day:"2-digit", timeZone:"UTC"}).format(2026-10-17)` answers
 * `10/17/2026`, byte-identical to `en-US`, and `formatToParts` reports the US
 * order. The three consequences were all silent, and all of them landed in
 * STORED or COMPARED values rather than in pixels:
 *
 *   - the task-field date picker seeds its selection from {@link todayIn}, so
 *     every date it committed reached the note as `[due:: 10/17/2026]`. The
 *     dialect's `DATE_ONLY` then refused to parse it and the value arrived as
 *     MALFORMED, i.e. the on-disk contract (`markdown-dialect.md` §3.6.4's
 *     `YYYY-MM-DD`) was broken by the runtime's locale data. Caught by
 *     `task-panel` tp5, which asserts the note's bytes;
 *   - {@link formatInstant}'s civil-date reduction produced a string no
 *     `CIVIL_DATE` matches, so `formatCivilDate` returned it verbatim and the
 *     user's `date_format` preset was silently not applied;
 *   - `todayLocal` (`src/notes/taskFilters.ts`) handed the date filters a value
 *     no stored ISO date equals, so a "today" filter matched nothing.
 *
 * `formatToParts` names every field, so the layout cannot decide what is stored.
 */
export function civilDateIn(format: Intl.DateTimeFormat, when: Date): string {
  const parts = format.formatToParts(when);
  const field = (type: "year" | "month" | "day"): string =>
    (parts.find((p) => p.type === type)?.value ?? "").padStart(
      type === "year" ? 4 : 2,
      "0",
    );
  return `${field("year")}-${field("month")}-${field("day")}`;
}

/**
 * Today as `YYYY-MM-DD` in the DISPLAY zone.
 *
 * The zone-aware replacement for a bare local-calendar read: with an override
 * set, "today" — and therefore which tasks are overdue, due today or upcoming —
 * follows the zone the user chose rather than the machine's.
 */
export function todayIn(display: DateTimeDisplay, now: Date = new Date()): string {
  return civilDateIn(
    intl("en-CA", {
      timeZone: display.timeZone ?? undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    now,
  );
}

// ── the ambient current settings ────────────────────────────────────────────
//
// The formatters above are pure and take their settings as a value, which is
// what makes them testable. Render sites, though, are scattered across two
// packages and several component trees, and threading a prefs object through
// every one of them would be a much larger change than the bug warrants.
//
// So the host publishes the resolved settings once, here, and surfaces read
// them. The store is a `useSyncExternalStore` source rather than a bare module
// variable for one reason: changing the setting has to REPAINT the surfaces,
// and a plain variable would leave every already-rendered date stale until
// something else happened to re-render it.

let current: DateTimeDisplay = DEFAULT_DISPLAY;
const listeners = new Set<() => void>();

/** Publish resolved display settings. Called by the host whenever the three
 *  prefs (or the app language) change. A no-op when nothing actually differs,
 *  so a prefs write that touched something else does not repaint every date. */
export function setDateTimeDisplay(next: DateTimeDisplay): void {
  if (
    next.dateFormat === current.dateFormat &&
    next.timeFormat === current.timeFormat &&
    next.timeZone === current.timeZone &&
    next.locale === current.locale
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

/** The current settings, for non-React callers. */
export function dateTimeDisplay(): DateTimeDisplay {
  return current;
}

/** Subscribe to setting changes; returns an unsubscribe fn. */
export function subscribeDateTimeDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Return the store to its defaults when a vault session ends.
 *
 * This store is module scope, so it outlives every unmount, and neither a lock
 * nor a vault switch reloads the page. Without this call the reader's chosen
 * date format, time format and TIME ZONE stay resident after a lock and are
 * carried into the next vault's session until its own publisher overwrites
 * them. The zone is the one worth naming: it is a coarse-location datum that
 * every other layer keeps per vault, and `dialect/src/taskFields.ts` keeps it
 * out of note bytes for exactly that reason.
 *
 * Listeners are KEPT, unlike in the test reset below. A subscriber is a mounted
 * view plugin; dropping its registration here would leave it silently
 * unsubscribed for the rest of the process, which is a worse failure than the
 * one this fixes (myne-md/myne#609, found by review).
 *
 * Rostered in `scripts/check-frontend-lock-teardown.mjs`, so a leaving path
 * added later that skips this fails by name.
 */
export function resetDateTimeDisplayForLock(): void {
  current = DEFAULT_DISPLAY;
  for (const l of listeners) l();
}

/** Test-only: return the store to its defaults and drop every listener. */
export function __resetDateTimeDisplayForTest(): void {
  current = DEFAULT_DISPLAY;
  listeners.clear();
}
