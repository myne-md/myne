// Recurrence rule vocabulary and parser (MYND-615, task 1).
//
// A **closed** three-tier keyword union, consumed with an exhaustiveness guard so
// an out-of-vocabulary shape is *unrepresentable* rather than merely rejected.
//
// **No date or recurrence library.** A general RFC-5545 implementation is an
// evaluator, and admitting one makes the closed-allow-list claim unenforceable at
// the type level — the same reasoning that keeps `onCompletion` uninterpreted and
// the template engine's registry closed. The arithmetic (tasks 2–4) is likewise
// hand-rolled over civil year/month/day fields.
//
// Rules are stored in canonical English and displayed localized (task 11): the
// file must not carry two languages, and a user who switches app language must
// not lose the ability to read their own rules. **The user never types a rule** —
// they pick it from a chip, which is what makes a closed vocabulary honest rather
// than restrictive.

/** Weekday names, canonical English, Monday-first. */
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** Interval units. */
export const INTERVAL_UNITS = ["day", "week", "month", "year"] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

/** Ordinal positions within a month; `last` is the from-the-end position. */
export const ORDINALS = ["first", "second", "third", "fourth", "last"] as const;
export type Ordinal = (typeof ORDINALS)[number];

/**
 * A recurrence rule.
 *
 * Two FAMILIES with deliberately different behaviour, and the user chooses
 * between them by choosing the rule rather than by a hidden setting:
 *
 *   - **interval** and **weekdays** count from the last date and clamp into short
 *     months, so they may drift;
 *   - **ordinal** and **dayOfMonth** are anchored to the calendar and do not
 *     drift.
 *
 * That is what makes the month-end question answerable without hidden state:
 * "keep it on the 31st" is directly expressible, so nothing has to remember an
 * original anchor day the file does not carry.
 */
export type RecurrenceRule =
  /** `every day`, `every 3 weeks`, `every month`, `every 2 years`. */
  | { readonly kind: "interval"; readonly unit: IntervalUnit; readonly count: number }
  /** `every monday`, `every tuesday and thursday`. */
  | { readonly kind: "weekdays"; readonly days: readonly Weekday[] }
  /** `first monday of every month`, `last friday of every month`. */
  | { readonly kind: "ordinal"; readonly ordinal: Ordinal; readonly weekday: Weekday }
  /** `day 31 of every month`, `last day of every month`. */
  | { readonly kind: "dayOfMonth"; readonly day: number | "last" };

/**
 * The result of reading a rule expression.
 *
 * An unsupported phrase yields `unrecognized` — never an exception, and never a
 * silent fallback to some default rule. The editor surfaces that state visibly
 * (MYND-615 task 10): a rule Myne cannot read must look unread, not look like it
 * works.
 */
export type ParsedRecurrence =
  | { readonly ok: true; readonly rule: RecurrenceRule }
  | { readonly ok: false; readonly raw: string };

const WEEKDAY_SET: ReadonlySet<string> = new Set(WEEKDAYS);
const UNIT_SINGULAR: ReadonlyMap<string, IntervalUnit> = new Map([
  ["day", "day"],
  ["days", "day"],
  ["week", "week"],
  ["weeks", "week"],
  ["month", "month"],
  ["months", "month"],
  ["year", "year"],
  ["years", "year"],
]);
const ORDINAL_SET: ReadonlySet<string> = new Set(ORDINALS);

function unrecognized(raw: string): ParsedRecurrence {
  return { ok: false, raw };
}

/**
 * Parse a canonical-English rule expression.
 *
 * Case-insensitive and whitespace-tolerant, because the value arrives from a
 * file a human may have hand-written or an importer may have produced — but the
 * *vocabulary* is closed, so anything outside it is `unrecognized` rather than
 * approximated.
 */
export function parseRecurrenceRule(input: string): ParsedRecurrence {
  const raw = input.trim();
  const text = raw.toLowerCase().replace(/\s+/g, " ");
  if (text === "") return unrecognized(raw);

  // --- tier 3: ordinal-in-month -----------------------------------------
  // `last day of every month` is checked FIRST: it also matches the ordinal
  // shape below (`last` + a word), and `day` is not a weekday, so the ordinal
  // branch would reject the whole phrase before this one was ever reached.
  if (text === "last day of every month") {
    return { ok: true, rule: { kind: "dayOfMonth", day: "last" } };
  }

  // `first monday of every month` / `last friday of every month`
  const ordinalMatch = /^(first|second|third|fourth|last) ([a-z]+) of every month$/.exec(text);
  if (ordinalMatch) {
    const [, ord, day] = ordinalMatch;
    if (ORDINAL_SET.has(ord!) && WEEKDAY_SET.has(day!)) {
      return { ok: true, rule: { kind: "ordinal", ordinal: ord as Ordinal, weekday: day as Weekday } };
    }
    return unrecognized(raw);
  }

  // `day 31 of every month`
  const domMatch = /^day (\d{1,2}) of every month$/.exec(text);
  if (domMatch) {
    const day = Number(domMatch[1]);
    if (day >= 1 && day <= 31) return { ok: true, rule: { kind: "dayOfMonth", day } };
    return unrecognized(raw);
  }

  if (!text.startsWith("every ")) return unrecognized(raw);
  const rest = text.slice("every ".length);

  // --- tier 2: weekday sets ---------------------------------------------
  // `monday` / `tuesday and thursday` / `monday, wednesday and friday`
  const dayTokens = rest
    .split(/,| and /)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (dayTokens.length > 0 && dayTokens.every((t) => WEEKDAY_SET.has(t))) {
    // Deduplicate but keep the canonical Monday-first order, so two spellings of
    // the same set compare equal.
    const set = new Set(dayTokens as Weekday[]);
    const days = WEEKDAYS.filter((d) => set.has(d));
    return { ok: true, rule: { kind: "weekdays", days } };
  }

  // --- tier 1: plain intervals ------------------------------------------
  // `day` / `3 days` / `week` / `2 months`
  const bare = UNIT_SINGULAR.get(rest);
  if (bare !== undefined) return { ok: true, rule: { kind: "interval", unit: bare, count: 1 } };

  const countMatch = /^(\d{1,3}) ([a-z]+)$/.exec(rest);
  if (countMatch) {
    const count = Number(countMatch[1]);
    const unit = UNIT_SINGULAR.get(countMatch[2]!);
    if (unit !== undefined && count >= 1) {
      return { ok: true, rule: { kind: "interval", unit, count } };
    }
  }

  return unrecognized(raw);
}

/**
 * Render a rule back to its canonical English form — the form stored in the
 * file. Localization is a display concern layered on top (task 11); the bytes
 * are always this.
 *
 * The `switch` is exhaustive with a `never` guard, which is the type-level half
 * of "closed vocabulary": adding a variant without handling it here fails to
 * compile.
 */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case "interval":
      return rule.count === 1
        ? `every ${rule.unit}`
        : `every ${rule.count} ${rule.unit}s`;
    case "weekdays": {
      const days = [...rule.days];
      if (days.length === 1) return `every ${days[0]}`;
      const last = days[days.length - 1];
      return `every ${days.slice(0, -1).join(", ")} and ${last}`;
    }
    case "ordinal":
      return `${rule.ordinal} ${rule.weekday} of every month`;
    case "dayOfMonth":
      return rule.day === "last"
        ? "last day of every month"
        : `day ${rule.day} of every month`;
    default: {
      // Exhaustiveness guard — an unhandled variant is a compile error, which is
      // what makes the vocabulary closed rather than merely documented.
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

/**
 * Which family a rule belongs to. Interval-family rules drift (they count from
 * the last date); calendar-family rules do not.
 */
export function recurrenceFamily(rule: RecurrenceRule): "interval" | "calendar" {
  switch (rule.kind) {
    case "interval":
    case "weekdays":
      return "interval";
    case "ordinal":
    case "dayOfMonth":
      return "calendar";
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}

/**
 * How a rule's next occurrence is anchored (MYND-615 task 5).
 *
 * Both modes are real needs, which is why neither is inferred:
 *
 *   - **`due`** (the default) computes from the previous due date, so a calendar
 *     obligation does not drift when the user handles it late;
 *   - **`completion`** computes from the day the task was actually completed, so
 *     an interval-from-last-action task ("water the plants every 3 days") does
 *     drift, as it should.
 *
 * The mode is carried **in the rule expression**, not inferred from context —
 * inferring it would mean guessing which of two correct behaviours the user
 * wanted, with no way for them to correct the guess.
 */
export type RecurrenceMode = "due" | "completion";

/** A rule together with its anchoring mode. */
export type RecurrenceSpec = {
  readonly rule: RecurrenceRule;
  readonly mode: RecurrenceMode;
};

/** The suffix that opts a rule into completion-anchored mode. */
const COMPLETION_SUFFIX = " when done";

/**
 * Parse a rule expression that may carry the completion-anchored opt-in.
 *
 * `every 3 days` → due-anchored (the default).
 * `every 3 days when done` → completion-anchored.
 */
export function parseRecurrenceSpec(
  input: string,
): { ok: true; spec: RecurrenceSpec } | { ok: false; raw: string } {
  const raw = input.trim();
  const lower = raw.toLowerCase().replace(/\s+/g, " ");
  const isCompletion = lower.endsWith(COMPLETION_SUFFIX);
  const rulePart = isCompletion ? raw.slice(0, raw.length - COMPLETION_SUFFIX.length) : raw;

  const parsed = parseRecurrenceRule(rulePart);
  if (!parsed.ok) return { ok: false, raw };
  return { ok: true, spec: { rule: parsed.rule, mode: isCompletion ? "completion" : "due" } };
}

/** Render a spec back to canonical English, including the mode opt-in. */
export function formatRecurrenceSpec(spec: RecurrenceSpec): string {
  const base = formatRecurrenceRule(spec.rule);
  return spec.mode === "completion" ? `${base}${COMPLETION_SUFFIX}` : base;
}

// --- Localized display (MYND-615 task 11) ------------------------------------
//
// Rules are STORED in canonical English and DISPLAYED in the user's language.
// The file must not carry two languages — a vault opened on a differently
// configured device would otherwise become unreadable to its own owner — and a
// user who switches app language must not lose the ability to read their own
// rules.
//
// This module returns a structured descriptor rather than a string, so the host
// supplies the actual translations through its own i18n catalogue. Putting
// English strings here and translating them elsewhere would put the vocabulary
// in two places.

/** A display descriptor: an i18n key plus its interpolation values. */
export type RecurrenceDisplay = {
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
};

/**
 * Describe a rule for display. The host maps `key` through its catalogue; the
 * stored bytes are unaffected.
 */
export function describeRecurrenceRule(rule: RecurrenceRule): RecurrenceDisplay {
  switch (rule.kind) {
    case "interval":
      return rule.count === 1
        ? { key: `recurrence.every.${rule.unit}`, values: {} }
        : { key: `recurrence.everyN.${rule.unit}`, values: { count: rule.count } };
    case "weekdays":
      return {
        key: rule.days.length === 1 ? "recurrence.everyWeekday" : "recurrence.everyWeekdays",
        values: { days: rule.days.join(","), count: rule.days.length },
      };
    case "ordinal":
      return {
        key: "recurrence.ordinalOfMonth",
        values: { ordinal: rule.ordinal, weekday: rule.weekday },
      };
    case "dayOfMonth":
      return rule.day === "last"
        ? { key: "recurrence.lastDayOfMonth", values: {} }
        : { key: "recurrence.dayOfMonth", values: { day: rule.day } };
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}
