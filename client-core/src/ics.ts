// The `.ics` codec (myne-md/myne#1037, task 10).
//
// ONE pure codec for all three clients: desktop, web and mobile import and export
// the same text through the same functions, because a calendar file is exactly the
// kind of interchange where two implementations disagree by an hour and nobody can
// see which one moved.
//
// It belongs in `@myne/client-core` by the entry criterion that package states: all
// clients answer this question identically and the module touches no host. Import
// needs the DEVICE ZONE, and that arrives as a parameter rather than as a global
// read, which is what keeps this module testable and keeps the zone choice at the
// call site where the user's setting lives.
//
// **The security boundary is the byte cap and the strict refusal.** An `.ics` file
// is untrusted input from a stranger's calendar server: the parser never
// dereferences a URL, never evaluates anything, and refuses a shape it cannot read
// instead of approximating it. Refusing is not a limitation here, it is the
// guarantee, because §3.10 (and every reader built on it) reports an unreadable
// event rather than inventing one, and an importer that guessed would defeat that
// downstream.
//
// The zone question is the one unavoidable loss. A stored instant in a Myne note is
// a WALL CLOCK with no offset (§3.8.3), so a `TZID` value is converted to the
// importing device's wall clock at import time and the zone is NOT preserved. That
// loss is reported (`zone-not-preserved`) rather than hidden: a user who imports a
// travel series and then flies somewhere gets times that no longer track the origin
// zone, and only a stated warning can tell them.

/** One event as the codec moves it in and out. */
export type IcsEvent = {
  readonly uid: string;
  readonly title: string;
  /** Emitted form: `YYYY-MM-DD HH:MM`, or a bare `YYYY-MM-DD` for an all-day event. */
  readonly start: string;
  readonly end: string | null;
  readonly allDay: boolean;
  /** A rule in the §3.8.7 vocabulary, or `null`. */
  readonly repeat: string | null;
  readonly description: string | null;
  /** A relative lead: `30m`, `2h`, `1d`. */
  readonly remind: string | null;
  readonly calendar: string | null;
  /**
   * The dates this series does not occur on, as `YYYY-MM-DD`.
   *
   * `EXDATE` is the file's own spelling of a cancellation and Myne stores the same
   * fact as `skip:` on the series note (`decisions/storage/0795`), so the exchange is
   * a rename rather than a translation. Without it an export asserted occurrences the
   * user had cancelled, which is the one thing a backup must not do.
   */
  readonly skip: readonly string[];
};

/**
 * Why a file was refused.
 *
 * Each is a distinct, explainable condition, and the importer names the one that
 * fired rather than "could not read the file": the difference is whether a user can
 * fix their export or has to guess.
 */
export type IcsRefusal =
  /** Over `ICS_BYTE_CAP`. Refused before a single line is parsed. */
  | "too-large"
  /** A line that is not `NAME:value` or `NAME;param:value`. */
  | "malformed-property"
  /** A `DTSTART` / `DTEND` this codec cannot type. */
  | "unreadable-start"
  /** A `TZID` the platform's ICU data does not know. */
  | "unknown-zone"
  /** A `VALUE=DATE` carrying a time, or a date value carrying `T`. */
  | "value-shape-mismatch"
  /** An `RRULE` outside the closed vocabulary this codec maps. */
  | "unreadable-rule"
  /** A `VEVENT` with no `DTSTART`: the file claims an event and does not say when. */
  | "missing-start"
  /** A calendar with nothing importable in it. */
  | "no-events";

/** What an import wants to tell the user without refusing the file. */
export type IcsWarning =
  /** A `TZID` or `Z` value was converted to the device's wall clock; the zone is gone. */
  | "zone-not-preserved"
  /** An event with no `UID`: one was derived, so a re-import cannot match it. */
  | "uid-derived"
  /** The file carried something this codec does not map (a `TRIGGER` it cannot read). */
  | "property-ignored";

export type IcsImport =
  | {
      readonly kind: "ok";
      readonly events: readonly IcsEvent[];
      readonly warnings: readonly IcsWarning[];
    }
  | { readonly kind: IcsRefusal };

/**
 * The hard cap on an imported file, in bytes.
 *
 * 1 MiB is roughly two thousand events: far more than a person's calendar and far
 * less than a file that can make the WebView struggle. The cap is a REFUSAL rather
 * than a truncation, because half an import is worse than none.
 */
export const ICS_BYTE_CAP = 1_048_576;

/** The lines of a text, unfolded (`RFC 5545` §3.1). */
function unfold(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if (line === "") continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] = (out[out.length - 1] ?? "") + line.slice(1);
      continue;
    }
    out.push(line);
  }
  return out;
}

type Property = {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
};

function parseProperty(line: string): Property | null {
  // The name and its parameters come before the first colon, and a colon inside a
  // quoted parameter value is legal, so the split is at the first UNQUOTED colon.
  let index = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      index = i;
      break;
    }
  }
  if (index <= 0) return null;
  const head = line.slice(0, index);
  const value = line.slice(index + 1);
  const parts = head.split(";");
  const name = (parts[0] ?? "").toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    params.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }
  return { name, params, value };
}

/** Undo the text escapes `§3.1` allows (`\\n`, `\\,`, `\\;`, `\\\\`). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_match, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch,
  );
}

/** Apply the same escapes when writing. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** The offset of `zone` at `utcMs`, in milliseconds east of UTC. */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - utcMs;
}

/** The wall clock `utcMs` shows in `zone`, as `YYYY-MM-DD HH:MM`. */
function wallClockIn(utcMs: number, zone: string): string {
  const shifted = utcMs + zoneOffsetMs(utcMs, zone);
  const d = new Date(shifted);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** A `DTSTART` / `DTEND` value, typed rather than repaired. */
type IcsInstant =
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "instant"; readonly wall: string }
  | { readonly kind: "error"; readonly reason: IcsRefusal };

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/;

function toDate(y: string, m: string, d: string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${y}-${m}-${d}`;
}

function readInstant(prop: Property, deviceZone: string): IcsInstant {
  const value = prop.value.trim();
  const wantsDate = (prop.params.get("VALUE") ?? "").toUpperCase() === "DATE";

  const dateMatch = DATE_RE.exec(value);
  if (dateMatch !== null) {
    const date = toDate(dateMatch[1] ?? "", dateMatch[2] ?? "", dateMatch[3] ?? "");
    if (date === null) return { kind: "error", reason: "unreadable-start" };
    return { kind: "date", date };
  }
  if (wantsDate) {
    // A `VALUE=DATE` that carries a time is the shape §3.10.2 refuses: a date is a
    // day, and inventing an hour for it would put the event somewhere the file did
    // not say.
    return { kind: "error", reason: "value-shape-mismatch" };
  }

  const stampMatch = STAMP_RE.exec(value);
  if (stampMatch === null) return { kind: "error", reason: "unreadable-start" };
  const date = toDate(stampMatch[1] ?? "", stampMatch[2] ?? "", stampMatch[3] ?? "");
  if (date === null) return { kind: "error", reason: "unreadable-start" };
  const hh = Number(stampMatch[4]);
  const mm = Number(stampMatch[5]);
  const ss = Number(stampMatch[6]);
  if (hh > 23 || mm > 59 || ss > 60) return { kind: "error", reason: "unreadable-start" };

  const zone = prop.params.get("TZID") ?? null;
  const isUtc = stampMatch[7] === "Z";
  if (zone === null && !isUtc) {
    // A floating value already IS a wall clock, which is what the note stores, so
    // there is nothing to convert and nothing lost.
    return { kind: "instant", wall: `${date} ${pad(hh)}:${pad(mm)}` };
  }

  let sourceZone: string;
  if (isUtc) {
    sourceZone = "UTC";
  } else {
    sourceZone = zone ?? deviceZone;
    if (!isSupportedZone(sourceZone)) return { kind: "error", reason: "unknown-zone" };
  }
  const localWallMs = Date.UTC(Number(stampMatch[1]), Number(stampMatch[2]) - 1, Number(stampMatch[3]), hh, mm, ss);
  // The value is a wall clock IN `sourceZone`; the instant is that minus the offset,
  // resolved twice because the offset depends on the instant we are solving for
  // (a DST boundary otherwise lands an hour out).
  let utcMs = localWallMs - zoneOffsetMs(localWallMs, sourceZone);
  utcMs = localWallMs - zoneOffsetMs(utcMs, sourceZone);
  return { kind: "instant", wall: wallClockIn(utcMs, deviceZone) };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isSupportedZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Translate an `RRULE` into the closed §3.8.7 vocabulary, or refuse it. */
function ruleFromIcs(value: string): { ok: true; rule: string } | { ok: false } {
  const parts = new Map<string, string>();
  for (const chunk of value.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;
    parts.set(chunk.slice(0, eq).toUpperCase(), chunk.slice(eq + 1).toUpperCase());
  }
  // `COUNT` / `UNTIL` are not part of the dialect's vocabulary, and dropping them
  // would import an endless series where the file said three. Refuse rather than
  // approximate: the user can fix their export, and a silently endless series
  // cannot be fixed.
  if (parts.has("COUNT") || parts.has("UNTIL")) return { ok: false };

  const freq = parts.get("FREQ") ?? "";
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isFinite(interval) || interval < 1 || interval > 99) return { ok: false };
  const byDay = parts.get("BYDAY");
  const byMonthDay = parts.get("BYMONTHDAY");
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[freq];

  if (byDay !== undefined && freq === "WEEKLY") {
    if (interval !== 1 || byMonthDay !== undefined) return { ok: false };
    const days = byDay.split(",").map(weekdayFromIcs);
    if (days.some((day) => day === null)) return { ok: false };
    return { ok: true, rule: `every ${joinWords(days as string[])}` };
  }
  if (byMonthDay !== undefined && freq === "MONTHLY") {
    if (interval !== 1 || byDay !== undefined) return { ok: false };
    const day = byMonthDay === "-1" ? "last" : String(Number(byMonthDay));
    if (day !== "last" && (!Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 31)) {
      return { ok: false };
    }
    return { ok: true, rule: day === "last" ? "last day of every month" : `day ${day} of every month` };
  }
  if (byDay !== undefined && freq === "MONTHLY") {
    if (interval !== 1) return { ok: false };
    const ordinalMatch = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay);
    if (ordinalMatch === null) return { ok: false };
    const ordinal = ordinalFromIcs(ordinalMatch[1] ?? "");
    const day = weekdayFromIcs(ordinalMatch[2] ?? "");
    if (ordinal === null || day === null) return { ok: false };
    return { ok: true, rule: `${ordinal} ${day} of every month` };
  }
  if (unit === undefined || byDay !== undefined || byMonthDay !== undefined) return { ok: false };
  const every = interval === 1 ? unit : `${interval} ${unit}s`;
  return { ok: true, rule: `every ${every}` };
}

const ICS_WEEKDAYS: ReadonlyMap<string, string> = new Map([
  ["MO", "monday"],
  ["TU", "tuesday"],
  ["WE", "wednesday"],
  ["TH", "thursday"],
  ["FR", "friday"],
  ["SA", "saturday"],
  ["SU", "sunday"],
]);

function weekdayFromIcs(code: string): string | null {
  return ICS_WEEKDAYS.get(code.toUpperCase()) ?? null;
}

function ordinalFromIcs(raw: string): string | null {
  switch (raw) {
    case "1":
      return "first";
    case "2":
      return "second";
    case "3":
      return "third";
    case "4":
      return "fourth";
    case "-1":
      return "last";
    default:
      return null;
  }
}

/** `a`, `a and b`, `a, b and c`: the vocabulary's own joining. */
function joinWords(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]!}`;
}

/** A lead from a `TRIGGER`, or `null` when the shape is not one Myne writes. */
function leadFromTrigger(value: string): string | null {
  // The `D` arm is not optional: `exportEvents` writes a day-granular lead as
  // `-P<n>D`, so without it Myne's own `remind: 1d` left as a duration and came back
  // as `null` with a generic "property ignored" warning. The round trip has to hold
  // for every unit the grammar admits, which is what this arm is for.
  const match = /^-P(?:(\d+)D|T(?:(\d+)H)?(?:(\d+)M)?)$/.exec(value.trim().toUpperCase());
  if (match === null) return null;
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");
  if (days > 0) return `${days}d`;
  const total = hours * 60 + minutes;
  if (total <= 0) return null;
  if (total % 1440 === 0) return `${total / 1440}d`;
  if (total % 60 === 0) return `${total / 60}h`;
  return `${total}m`;
}

/**
 * Parse an `.ics` text into events.
 *
 * Strict by construction: the cap is checked before parsing, an unreadable start
 * refuses the FILE rather than the single event (a half-imported calendar is worse
 * than none), and nothing is approximated.
 */
export function importEvents(text: string, options: { readonly zone: string }): IcsImport {
  // Measured in BYTES, because the cap is about how much a stranger can hand the
  // WebView, and a character count would let a multi-byte file through at twice the
  // intended size.
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > ICS_BYTE_CAP) return { kind: "too-large" };

  const warnings = new Set<IcsWarning>();
  const events: IcsEvent[] = [];
  let derived = 0;
  let current: Map<string, Property> | null = null;
  let trigger: string | null = null;

  for (const line of unfold(text)) {
    const prop = parseProperty(line);
    if (prop === null) return { kind: "malformed-property" };

    if (prop.name === "BEGIN") {
      if (prop.value.toUpperCase() === "VEVENT") {
        current = new Map();
        trigger = null;
      }
      continue;
    }
    if (prop.name === "END") {
      if (prop.value.toUpperCase() === "VEVENT" && current !== null) {
        const built = buildEvent(
          current,
          trigger,
          options.zone,
          warnings,
          `myne-derived-${String(++derived)}`,
        );
        if (typeof built === "string") return { kind: built };
        events.push(built);
        current = null;
        trigger = null;
      }
      continue;
    }
    if (current === null) continue;
    // `TRIGGER` lives inside a VALARM, but the order is not guaranteed and one pass
    // is enough for a file whose VALARM belongs to its VEVENT.
    if (prop.name === "TRIGGER") {
      trigger = prop.value;
      continue;
    }
    if (prop.name === "EXDATE") {
      // Repeatable, and a `Map` can only hold one. Collected on a second map that
      // only this reader looks at, so the property map keeps its first-wins rule for
      // every other field.
      const seen = current.get("EXDATE");
      const merged = seen === undefined ? prop.value : `${seen.value},${prop.value}`;
      current.set("EXDATE", { name: "EXDATE", value: merged } as Property);
      continue;
    }
    if (!current.has(prop.name)) current.set(prop.name, prop);
  }

  if (events.length === 0) {
    // Distinguishes "an empty calendar" from "a file whose every event was broken":
    // the first is fine, the second is what `missing-start` reports per VEVENT, and
    // the caller sees the refusal rather than an unclear zero.
    return { kind: "no-events" };
  }
  return { kind: "ok", events, warnings: [...warnings].sort() };
}

/**
 * Build one event, or report why it cannot be built.
 *
 * A refusal here refuses the FILE: a half-imported calendar would leave a user with
 * some events and no way to tell which are missing.
 */
function buildEvent(
  properties: ReadonlyMap<string, Property>,
  trigger: string | null,
  zone: string,
  warnings: Set<IcsWarning>,
  generatedUid: string,
): IcsEvent | IcsRefusal {
  const startProp = properties.get("DTSTART");
  if (startProp === undefined) return "missing-start";
  const start = readInstant(startProp, zone);
  if (start.kind === "error") return start.reason;
  if (startProp.params.has("TZID") || startProp.value.trim().endsWith("Z")) {
    warnings.add("zone-not-preserved");
  }

  const allDay = start.kind === "date";
  let end: string | null = null;
  const endProp = properties.get("DTEND");
  if (endProp !== undefined) {
    const parsed = readInstant(endProp, zone);
    if (parsed.kind === "error") return parsed.reason;
    if (parsed.kind === "date" && !allDay) return "value-shape-mismatch";
    if (parsed.kind === "instant" && allDay) return "value-shape-mismatch";
    if (allDay) {
      // `DTEND` is EXCLUSIVE in ICS: "until the 8th" means the last day is the 7th,
      // which is the day the note carries.
      end = previousDay(parsed.kind === "date" ? parsed.date : parsed.wall.slice(0, 10));
    } else {
      end = parsed.kind === "instant" ? parsed.wall : null;
    }
  }

  const uid = unescapeText(properties.get("UID")?.value ?? "").trim();
  if (uid === "") warnings.add("uid-derived");

  const ruleProp = properties.get("RRULE");
  let repeat: string | null = null;
  if (ruleProp !== undefined) {
    const rule = ruleFromIcs(ruleProp.value);
    if (!rule.ok) return "unreadable-rule";
    repeat = rule.rule;
  }

  // `EXDATE` may appear once per date, or once with a comma list, and both spellings
  // are produced by real calendars. The prefix is stripped because these values are
  // parsed from a line whose name was already consumed, and a date-only or
  // date-time value both name the same day here.
  const skip: string[] = [];
  for (const piece of (properties.get("EXDATE")?.value ?? "").split(",")) {
    // A date-only or a date-time value names the same DAY here, which is the
    // granularity `skip:` stores. RFC 5545's DATE form is COMPACT (`20261110`), and a
    // dashed value is accepted too because hand-written files carry them.
    const date = icsDateToCanonical(piece.trim());
    if (date !== null && !skip.includes(date)) skip.push(date);
  }

  const lead = trigger === null ? null : leadFromTrigger(trigger);
  if (trigger !== null && lead === null) warnings.add("property-ignored");

  return {
    uid: uid === "" ? generatedUid : uid,
    title: unescapeText(properties.get("SUMMARY")?.value ?? ""),
    start: start.kind === "date" ? start.date : start.wall,
    end,
    allDay,
    repeat,
    description: properties.has("DESCRIPTION")
      ? unescapeText(properties.get("DESCRIPTION")?.value ?? "")
      : null,
    remind: lead,
    skip,
    calendar: properties.has("CATEGORIES")
      ? (unescapeText(properties.get("CATEGORIES")?.value ?? "").split(",")[0] ?? "").trim()
      : null,
  };
}

/**
 * The `YYYY-MM-DD` a `DTSTART`/`EXDATE` value names, from either the compact RFC 5545
 * form or a dashed one this codec's own writer used before it was corrected.
 */
function icsDateToCanonical(value: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})(?:T|$)/.exec(value);
  if (compact !== null) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (dashed !== null) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
  return null;
}

/** `YYYY-MM-DD` minus one day, without a date library. */
function previousDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1)) - 86_400_000;
  const back = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${back.getUTCFullYear()}-${p(back.getUTCMonth() + 1)}-${p(back.getUTCDate())}`;
}

/**
 * Fold a line at 75 octets, continuing with a single space (`RFC 5545` §3.1).
 *
 * Folded by CHARACTER count rather than by UTF-8 bytes: the difference only shows on
 * a long non-ASCII title, and a reader that unfolds on either basis reassembles the
 * same value.
 */
function foldLine(line: string): string[] {
  if (line.length <= 75) return [line];
  const out: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    out.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return out;
}

/** The `RRULE` an internal rule becomes, or `null` when it has none. */
function ruleToIcs(rule: string): string | null {
  const interval = /^every (\d+) (day|week|month|year)s?$/.exec(rule);
  if (interval !== null) {
    const unit = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }[
      interval[2] as "day" | "week" | "month" | "year"
    ];
    const count = Number(interval[1]);
    return count === 1 ? `FREQ=${unit}` : `FREQ=${unit};INTERVAL=${count}`;
  }
  const plain = /^every (day|week|month|year)$/.exec(rule);
  if (plain !== null) {
    const unit = { day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }[
      plain[1] as "day" | "week" | "month" | "year"
    ];
    return `FREQ=${unit}`;
  }
  const weekdays = /^every ((?:[a-z]+(?:, )?(?:and )?)+)$/.exec(rule);
  if (weekdays !== null) {
    const days = weekdays[1]!.split(/, | and /).map((day) => day.trim());
    const codes = days.map((day) => ICS_CODE_BY_WEEKDAY.get(day) ?? "");
    if (codes.every((code) => code !== "")) return `FREQ=WEEKLY;BYDAY=${codes.join(",")}`;
  }
  const dayOfMonth = /^day (\d{1,2}) of every month$/.exec(rule);
  if (dayOfMonth !== null) return `FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth[1]}`;
  if (rule === "last day of every month") return "FREQ=MONTHLY;BYMONTHDAY=-1";
  const ordinal = /^(first|second|third|fourth|last) ([a-z]+) of every month$/.exec(rule);
  if (ordinal !== null) {
    const code = ICS_CODE_BY_WEEKDAY.get(ordinal[2]!);
    const position = { first: "1", second: "2", third: "3", fourth: "4", last: "-1" }[
      ordinal[1] as "first" | "second" | "third" | "fourth" | "last"
    ];
    if (code !== undefined) return `FREQ=MONTHLY;BYDAY=${position}${code}`;
  }
  return null;
}

const ICS_CODE_BY_WEEKDAY: ReadonlyMap<string, string> = new Map(
  [...ICS_WEEKDAYS.entries()].map(([code, day]) => [day, code] as const),
);

/** `YYYY-MM-DD HH:MM` (or a bare date) as an ICS value. */
function toIcsValue(value: string, allDay: boolean): { value: string; isDate: boolean } {
  if (allDay) return { value: value.replace(/-/g, "").slice(0, 8), isDate: true };
  const [date, time] = value.split(" ");
  const compact = `${(date ?? "").replace(/-/g, "")}T${(time ?? "00:00").replace(":", "")}00`;
  return { value: compact, isDate: false };
}

/** `YYYY-MM-DD` plus one day, for the exclusive all-day `DTEND`. */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1)) + 86_400_000;
  const next = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${next.getUTCFullYear()}-${p(next.getUTCMonth() + 1)}-${p(next.getUTCDate())}`;
}

/**
 * Emit events as one `.ics` calendar.
 *
 * Deterministic: the same records produce byte-identical text, so a re-export is not
 * a diff. The `uid`s come from the notes themselves, which is what makes a
 * re-import match by identity rather than by title.
 */
export function exportEvents(events: readonly IcsEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Myne//Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const event of events) {
    const start = toIcsValue(event.start, event.allDay);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(event.uid)}`);
    lines.push(`SUMMARY:${escapeText(event.title)}`);
    lines.push(
      start.isDate ? `DTSTART;VALUE=DATE:${start.value}` : `DTSTART:${start.value}`,
    );
    if (event.end !== null) {
      const end = toIcsValue(event.end, event.allDay);
      // Exclusive, so that the import gets back the last day the event covers.
      const value = event.allDay ? nextDay(event.end).replace(/-/g, "") : end.value;
      lines.push(end.isDate ? `DTEND;VALUE=DATE:${value}` : `DTEND:${value}`);
    }
    if (event.repeat !== null) {
      const rule = ruleToIcs(event.repeat);
      if (rule !== null) lines.push(`RRULE:${rule}`);
      // `EXDATE` belongs beside the rule it narrows, and only a series can carry one:
      // a non-recurring event with a cancellation is a note that simply does not
      // exist, so an empty or orphaned list is dropped rather than written.
      if (rule !== null && (event.skip ?? []).length > 0) {
        lines.push(`EXDATE:${[...(event.skip ?? [])].sort().map((date) => date.split("-").join("")).join(",")}`);
      }
    }
    if (event.description !== null) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.calendar !== null) lines.push(`CATEGORIES:${escapeText(event.calendar)}`);
    if (event.remind !== null) {
      const lead = /^(\d+)([mhd])$/.exec(event.remind);
      if (lead !== null) {
        const count = lead[1];
        const trigger =
          lead[2] === "d" ? `-P${count}D` : lead[2] === "h" ? `-PT${count}H` : `-PT${count}M`;
        lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:${trigger}`, "END:VALARM");
      }
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(foldLine).join("\r\n") + "\r\n";
}
