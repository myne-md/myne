// Shared derivation for the two TASK vector categories in the
// `myne-test-vectors` companion — `task-inline-format` (MYND-611 task 8) and
// `task-recurrence` (MYND-615 task 14).
//
// Both the generator (`_genTaskVectors.test.ts`) and the cross-implementation
// runner (`taskVectors.test.ts`) import this module, so "what a case means" is
// defined once. That is the same discipline `dialectSpans.ts` follows for the
// six parse-recognition categories, and for the same reason: two copies of a
// derivation drift, and a drifted vector runner reports agreement that does not
// exist.
//
// **Offsets are UTF-8 byte offsets**, not JS UTF-16 code-unit indices. The
// distinction is not academic here — every emoji marker in Obsidian's dialect is
// a surrogate pair in UTF-16 and four bytes in UTF-8, so a port that walks bytes
// would disagree with an un-converted vector on literally every emoji case.

import { parser } from "../../src/dialect/lezer/parser";
import { parseTaskFields, type TaskFields } from "../../src/dialect/taskFields";
import { planTaskFieldWrite } from "../../src/dialect/taskFieldWriter";
import { parseTaskQuery as parseTaskQueryForVectors } from "../../src/notes/taskQuery";
import {
  formatRecurrenceSpec,
  parseRecurrenceSpec,
  recurrenceFamily,
} from "../../src/dialect/recurrence";
import {
  advancePair,
  formatCivilDate,
  parseCivilDate,
  type CivilDate,
} from "../../src/dialect/civilDate";

/** The node names the task-field recognizer emits. */
export const TASK_FIELD_NODES = [
  "TaskField",
  "TaskFieldKey",
  "TaskFieldValue",
  "TaskFieldMark",
] as const;

export type DialectSpan = { node: string; from: number; to: number };

export function toHex(s: string): string {
  return Buffer.from(s, "utf8").toString("hex");
}
export function fromHex(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}

function utf16ToUtf8Offset(source: string, idx: number): number {
  return Buffer.byteLength(source.slice(0, idx), "utf8");
}

/** Every task-field span in `source`, pre-order, as UTF-8 byte offsets. */
export function taskFieldSpans(source: string): DialectSpan[] {
  const names = new Set<string>(TASK_FIELD_NODES);
  const spans: DialectSpan[] = [];
  parser.parse(source).iterate({
    enter: (n) => {
      if (names.has(n.name)) {
        spans.push({
          node: n.name,
          from: utf16ToUtf8Offset(source, n.from),
          to: utf16ToUtf8Offset(source, n.to),
        });
      }
    },
  });
  return spans;
}

/** A typed record in vector form: absent fields are OMITTED, never null. */
export type VectorFields = {
  due?: { date: string; time?: string };
  repeat?: string;
  done?: { date: string; time?: string };
  priority?: string;
  remind?: { date: string; time?: string };
  preserved: Array<{ key: string; value: string; raw: string }>;
  malformed: Array<{ key: string; value: string; raw: string }>;
};

/**
 * Project a parsed record into the vector's JSON shape.
 *
 * Omit-when-absent rather than explicit nulls, so a port with a different
 * optional representation (Rust `Option`, Swift optional) does not have to
 * invent a null encoding to agree.
 */
export function toVectorFields(fields: TaskFields): VectorFields {
  const out: VectorFields = { preserved: [], malformed: [] };
  if (fields.due !== undefined) out.due = { ...fields.due };
  if (fields.priority !== undefined) out.priority = fields.priority;
  if (fields.remind !== undefined) out.remind = { ...fields.remind };
  if (fields.repeat !== undefined) out.repeat = fields.repeat;
  if (fields.done !== undefined) out.done = { ...fields.done };
  out.preserved = fields.preserved.map((f) => ({ key: f.key, value: f.value, raw: f.raw }));
  out.malformed = fields.malformed.map((f) => ({ key: f.key, value: f.value, raw: f.raw }));
  return out;
}

/**
 * The line as Myne would write it — the whole line converted, which is the
 * dialect's convert-on-edit rule (§3.8.2). A line with no fields, and a line
 * already in the emitted form, both come back unchanged: the emitted form is a
 * fixed point, which is what keeps opening a vault from dirtying its tasks.
 */
export function emittedLine(line: string): string {
  const edit = planTaskFieldWrite(line, parseTaskFields(line));
  if (edit === null) return line;
  return line.slice(0, edit.range.start) + edit.text + line.slice(edit.range.end);
}

// --- task-inline-format ------------------------------------------------------

export type InlineFormatCase = {
  vector_id: string;
  description: string;
  case_kind: "dataview" | "emoji" | "myne" | "mixed" | "preserve" | "malformed" | "inert";
  input_markdown_utf8_hex: string;
  informational_markdown: string;
  expected_dialect_spans: DialectSpan[];
  expected_fields: VectorFields;
  expected_emitted_utf8_hex: string;
  informational_emitted: string;
};

export type InlineFormatSpec = {
  slug: string;
  kind: InlineFormatCase["case_kind"];
  desc: string;
  source: string;
};

export function buildInlineFormatCase(spec: InlineFormatSpec): InlineFormatCase {
  const emitted = emittedLine(spec.source);
  return {
    vector_id: `task-inline-format/v0.1/${spec.slug}`,
    description: spec.desc,
    case_kind: spec.kind,
    input_markdown_utf8_hex: toHex(spec.source),
    informational_markdown: spec.source,
    expected_dialect_spans: taskFieldSpans(spec.source),
    expected_fields: toVectorFields(parseTaskFields(spec.source)),
    expected_emitted_utf8_hex: toHex(emitted),
    informational_emitted: emitted,
  };
}

// --- task-recurrence ---------------------------------------------------------

export type RecurrenceCase = {
  vector_id: string;
  description: string;
  case_kind: "advance" | "unrecognized";
  rule: string;
  expected_rule_recognized: boolean;
  expected_canonical_rule?: string;
  expected_mode?: "due" | "completion";
  expected_family?: "interval" | "calendar";
  today: string;
  due?: string;
  remind?: string;
  expected_due?: string;
  expected_remind?: string;
};

export type RecurrenceSpecCase = {
  slug: string;
  desc: string;
  rule: string;
  today: string;
  due?: string;
  remind?: string;
};

function civil(value: string): CivilDate {
  const parsed = parseCivilDate(value);
  if (parsed === null) throw new Error(`vector fixture carries an impossible date: ${value}`);
  return parsed;
}

export function buildRecurrenceCase(spec: RecurrenceSpecCase): RecurrenceCase {
  const parsed = parseRecurrenceSpec(spec.rule);
  const base = {
    vector_id: `task-recurrence/v0.1/${spec.slug}`,
    description: spec.desc,
    rule: spec.rule,
    today: spec.today,
    ...(spec.due === undefined ? {} : { due: spec.due }),
    ...(spec.remind === undefined ? {} : { remind: spec.remind }),
  };

  if (!parsed.ok) {
    // An unrecognized rule advances NOTHING. Pinning that here is the
    // cross-implementation half of "never fall back to a default rule" — a port
    // that quietly resolves to "every day" fails this case rather than shipping.
    return { ...base, case_kind: "unrecognized", expected_rule_recognized: false };
  }

  const advanced = advancePair(parsed.spec, {
    due: spec.due === undefined ? undefined : civil(spec.due),
    remind: spec.remind === undefined ? undefined : civil(spec.remind),
    today: civil(spec.today),
  });

  return {
    ...base,
    case_kind: "advance",
    expected_rule_recognized: true,
    expected_canonical_rule: formatRecurrenceSpec(parsed.spec),
    expected_mode: parsed.spec.mode,
    expected_family: recurrenceFamily(parsed.spec.rule),
    ...(advanced.due === undefined ? {} : { expected_due: formatCivilDate(advanced.due) }),
    ...(advanced.remind === undefined
      ? {}
      : { expected_remind: formatCivilDate(advanced.remind) }),
  };
}

// --- the corpora -------------------------------------------------------------
//
// Transcribed from `tests/fixtures/dialect/task-fields/*.md`, which are the
// fixtures the local suite already reads. Keeping the two in step by hand is
// deliberate: the fixtures are prose files a human curates, and a vector whose
// inputs are generated from a directory listing would change silently when
// someone edits a fixture for an unrelated reason.

export const INLINE_FORMAT_SPECS: readonly InlineFormatSpec[] = [
  // --- read dialect 1: Obsidian Dataview-style bracketed fields --------------
  { slug: "dataview-due", kind: "dataview", desc: "A due date in Obsidian's Dataview-style inline-field form.", source: "- [ ] pay the rent [due:: 2026-08-01]" },
  { slug: "dataview-repeat", kind: "dataview", desc: "A recurrence rule in the Dataview form.", source: "- [ ] water the plants [repeat:: every 3 days]" },
  { slug: "dataview-completion-folds-to-done", kind: "dataview", desc: "Obsidian's `completion` key folds onto Myne's `done` — the whole of the third dialect a reader must learn.", source: "- [x] ship the release [completion:: 2026-07-27]" },
  { slug: "dataview-remind-with-time", kind: "dataview", desc: "A reminder carrying a wall-clock time, with no offset and no zone id.", source: "- [ ] call mother [remind:: 2026-07-29 09:00]" },
  { slug: "dataview-priority-word", kind: "dataview", desc: "A priority in its word form.", source: "- [ ] urgent thing [priority:: high]" },
  { slug: "dataview-all-five", kind: "dataview", desc: "All five typed fields on one line; emission reorders them into the stable order.", source: "- [ ] everything at once [due:: 2026-08-01] [repeat:: every week] [remind:: 2026-07-31 08:00] [priority:: highest]" },

  // --- read dialect 2: Obsidian emoji markers -------------------------------
  { slug: "emoji-due", kind: "emoji", desc: "A due date behind Obsidian's calendar marker. Four UTF-8 bytes, one surrogate pair in UTF-16 — the case a byte-offset port must agree on.", source: "- [ ] pay the rent 📅 2026-08-01" },
  { slug: "emoji-repeat", kind: "emoji", desc: "A recurrence rule behind the repeat marker.", source: "- [ ] water the plants 🔁 every 3 days" },
  { slug: "emoji-done", kind: "emoji", desc: "A completion date behind the check marker, read as Myne's `done`.", source: "- [x] ship the release ✅ 2026-07-27" },
  { slug: "emoji-priority-marker-is-the-value", kind: "emoji", desc: "A priority marker carries no value — the marker IS the value.", source: "- [ ] urgent thing ⏫" },
  { slug: "emoji-several-markers", kind: "emoji", desc: "Several emoji fields on one line; each value ends at the next marker.", source: "- [ ] everything at once 📅 2026-08-01 🔁 every week ⏰ 2026-07-31 08:00 🔺" },
  { slug: "emoji-value-stops-at-trailing-tag", kind: "emoji", desc: "An emoji value terminates at a token-initial `#`, so a trailing tag stays a tag instead of being swallowed into the value.", source: "- [ ] a task with a trailing tag 📅 2026-08-01 #chores" },

  // --- read dialect 3: Myne's own form --------------------------------------
  { slug: "myne-done", kind: "myne", desc: "Myne's own key for a completion date.", source: "- [x] ship the release [done:: 2026-07-27]" },
  { slug: "myne-emitted-form-is-a-fixed-point", kind: "myne", desc: "A line already in the emitted form rewrites to itself — the property that keeps opening a vault from dirtying its task lines (§6 C1).", source: "- [ ] everything at once [due:: 2026-08-01] [priority:: highest] [remind:: 2026-07-31 08:00] [repeat:: every week] [done:: 2026-07-27]" },
  { slug: "myne-due-with-time", kind: "myne", desc: "A due date carrying a wall-clock time.", source: "- [ ] due with a time [due:: 2026-08-01 14:30]" },

  // --- both dialects on one line (a half-migrated vault) --------------------
  { slug: "mixed-emoji-then-bracketed", kind: "mixed", desc: "One field of each form on one line — the shape a vault takes mid-migration.", source: "- [ ] one of each 📅 2026-08-01 [priority:: high]" },
  { slug: "mixed-bracketed-then-emoji", kind: "mixed", desc: "The same, in the other order.", source: "- [ ] the other order [due:: 2026-08-01] 🔁 every week" },
  { slug: "mixed-description-between-fields", kind: "mixed", desc: "Description text between two fields; emission preserves the description and moves the fields to the end.", source: "- [ ] description between fields [due:: 2026-08-01] the plumber [priority:: low]" },
  { slug: "mixed-emoji-value-stops-at-bracket", kind: "mixed", desc: "An emoji value terminates at a `[`, so both dialects can share a line.", source: "- [ ] emoji then bracket 📅 2026-08-01 [priority:: low]" },

  // --- fields Myne recognizes but does not type -----------------------------
  { slug: "preserve-obsidian-other-keys", kind: "preserve", desc: "Obsidian's remaining keys are recognized, preserved verbatim, and never typed.", source: "- [ ] obsidian's other keys [scheduled:: 2026-08-05] [start:: 2026-08-01] [cancelled:: 2026-08-09] [created:: 2026-07-01] [id:: abc] [dependsOn:: xyz]" },
  { slug: "preserve-oncompletion-uninterpreted", kind: "preserve", desc: "`onCompletion` is preserved byte-for-byte and assigned NO meaning — interpreting it would cross the no-code-eval line.", source: "- [ ] an action language Myne never runs [onCompletion:: delete]" },
  { slug: "preserve-emoji-untyped-keys", kind: "preserve", desc: "The emoji form of the untyped keys is likewise recognized and preserved.", source: "- [ ] fields Myne does not type ⏳ 2026-08-05 🛫 2026-08-01 🆔 abc123" },

  // --- values that do not type ----------------------------------------------
  { slug: "malformed-half-written-date", kind: "malformed", desc: "A half-written date does not type; it is preserved rather than completed.", source: "- [ ] half-written date [due:: 2026-08]" },
  { slug: "malformed-impossible-date", kind: "malformed", desc: "A date that passes the shape but does not exist is refused, never corrected.", source: "- [ ] impossible date [due:: 2026-02-31]" },
  { slug: "malformed-out-of-range-time", kind: "malformed", desc: "An out-of-range hour is refused.", source: "- [ ] out-of-range time [due:: 2026-08-01 25:00]" },
  { slug: "malformed-utc-offset", kind: "malformed", desc: "A Z offset does not type at all — stripping it would silently shift the due date.", source: "- [ ] a Z offset [due:: 2026-08-01T10:00:00Z]" },
  { slug: "malformed-numeric-offset", kind: "malformed", desc: "A numeric offset is refused for the same reason, and keeps a coarse geolocation datum out of an exported plaintext file.", source: "- [ ] a numeric offset [due:: 2026-08-01T10:00:00+03:00]" },
  { slug: "malformed-unknown-priority", kind: "malformed", desc: "A priority word outside the five levels is preserved, not approximated.", source: "- [ ] an unknown priority word [priority:: urgent]" },

  // --- near-misses the recognizer must NOT claim -----------------------------
  { slug: "inert-code-span", kind: "inert", desc: "A field inside a code span is not a field — inline parsing never runs inside a range the code node has consumed.", source: "- [ ] inside a code span `[due:: 2026-08-01]`" },
  { slug: "inert-plain-link", kind: "inert", desc: "An ordinary markdown link and a dangling label are not fields, even though the bracketed rule outranks Link.", source: "- [ ] a dangling label [label] and an ordinary [link](https://example.com)" },
  { slug: "inert-shortcode", kind: "inert", desc: "A `:emoji:` shortcode is not an emoji marker.", source: "- [ ] a shortcode :calendar: 2026-08-01" },
  { slug: "inert-no-fields", kind: "inert", desc: "A task line with no fields at all.", source: "- [ ] plain task, nothing to see" },
];

export const RECURRENCE_SPECS: readonly RecurrenceSpecCase[] = [
  // --- interval family: counts from the previous date, clamps, may drift -----
  { slug: "interval-daily", desc: "A daily rule advances one day.", rule: "every day", today: "2026-07-28", due: "2026-07-28" },
  { slug: "interval-counted-days", desc: "A counted interval advances by its count.", rule: "every 3 days", today: "2026-07-28", due: "2026-07-28" },
  { slug: "interval-weekly", desc: "A weekly rule advances seven days.", rule: "every week", today: "2026-07-28", due: "2026-07-28" },
  { slug: "interval-monthly-clamps-into-february", desc: "31 January + one month CLAMPS to 28 February. Half one of the interval family's drift.", rule: "every month", today: "2026-01-31", due: "2026-01-31" },
  { slug: "interval-monthly-drifts-after-clamping", desc: "…and the next step counts from the CLAMPED date, giving 28 March. Half two — the drift is the accepted cost of the stateless option.", rule: "every month", today: "2026-02-28", due: "2026-02-28" },
  { slug: "interval-yearly-leap-day-clamps", desc: "29 February + one year clamps to 28 February in a non-leap year.", rule: "every year", today: "2028-02-29", due: "2028-02-29" },
  { slug: "weekdays-single", desc: "A weekday rule lands on the next matching weekday, strictly after the anchor.", rule: "every monday", today: "2026-07-28", due: "2026-07-28" },
  { slug: "weekdays-set-picks-the-nearest", desc: "A weekday SET lands on the nearest member, not the first listed.", rule: "every monday and friday", today: "2026-07-28", due: "2026-07-28" },
  { slug: "weekdays-set-normalizes", desc: "Two spellings of one set are one rule: the canonical form is Monday-first and deduplicated.", rule: "every friday, monday and friday", today: "2026-07-28", due: "2026-07-28" },

  // --- calendar family: anchored, does not drift ----------------------------
  { slug: "calendar-day-of-month-clamps", desc: "`day 31` clamps to 28 February in a short month.", rule: "day 31 of every month", today: "2026-01-31", due: "2026-01-31" },
  { slug: "calendar-day-of-month-returns-to-nominal", desc: "…and then returns to 31 March rather than counting from the clamped date. THE decisive contrast with the interval family.", rule: "day 31 of every month", today: "2026-02-28", due: "2026-02-28" },
  { slug: "calendar-last-day-of-month", desc: "`last day of every month` resolves to each month's own last day.", rule: "last day of every month", today: "2026-07-31", due: "2026-07-31" },
  { slug: "calendar-ordinal-first-weekday", desc: "The first Monday of the following month.", rule: "first monday of every month", today: "2026-07-06", due: "2026-07-06" },
  { slug: "calendar-ordinal-last-weekday", desc: "The last Friday of the following month.", rule: "last friday of every month", today: "2026-07-31", due: "2026-07-31" },
  { slug: "calendar-ordinal-fourth-clamps-back", desc: "A month holding only four of a weekday clamps BACK a week rather than spilling into the next month.", rule: "fourth monday of every month", today: "2026-01-26", due: "2026-01-26" },

  // --- the advance rule: whole intervals until strictly after today ---------
  { slug: "advance-stale-monthly-keeps-the-anchor", desc: "Rent due on the 1st, four months untouched: whole intervals are added until strictly after today, and the 1st survives.", rule: "every month", today: "2026-07-28", due: "2026-03-01" },
  { slug: "advance-stale-yields-one-occurrence", desc: "A daily rule three years stale yields ONE date, not a thousand catch-up occurrences — the property the notification capacity argument rests on.", rule: "every day", today: "2026-07-28", due: "2023-07-28" },
  { slug: "advance-non-stale-moves-one-interval", desc: "A rule that is not stale advances by exactly one interval.", rule: "every week", today: "2026-07-28", due: "2026-07-27" },

  // --- anchoring modes ------------------------------------------------------
  { slug: "mode-due-anchored-default", desc: "No suffix means due-anchored, so a late completion does not drift the calendar obligation.", rule: "every month", today: "2026-08-15", due: "2026-08-01" },
  { slug: "mode-completion-anchored", desc: "The ` when done` suffix anchors on today instead, so an interval-from-last-action task drifts — as it should. Same rule, same late date, different answer.", rule: "every month when done", today: "2026-08-15", due: "2026-08-01" },

  // --- reminder co-advance --------------------------------------------------
  { slug: "reminder-gap-is-carried", desc: "With both fields the due date is the anchor and the reminder shifts by the SAME number of days, so the gap is carried rather than recomputed.", rule: "every week", today: "2026-07-28", due: "2026-07-28", remind: "2026-07-26" },
  { slug: "reminder-gap-survives-a-clamp", desc: "The clamping case proves the gap is carried: 31 Jan to 28 Feb is a 28-day step, so the reminder moves 28 days too.", rule: "every month", today: "2026-01-31", due: "2026-01-31", remind: "2026-01-28" },
  { slug: "reminder-only-still-recurs", desc: "With no due date the reminder is the anchor — 'remind me Tuesday to call my mother', which is why `remind` is absolute rather than an offset.", rule: "every week", today: "2026-07-28", remind: "2026-07-28" },

  // --- unrecognized rules ---------------------------------------------------
  { slug: "unrecognized-rfc5545", desc: "An RFC-5545 expression is outside the closed vocabulary: nothing advances, and NO default is substituted.", rule: "FREQ=DAILY;INTERVAL=1", today: "2026-07-28", due: "2026-07-28" },
  { slug: "unrecognized-prose", desc: "A human phrase outside the vocabulary likewise advances nothing.", rule: "whenever I feel like it", today: "2026-07-28", due: "2026-07-28" },
  { slug: "unrecognized-near-miss", desc: "A near-miss — a real unit with no count word — is rejected rather than approximated.", rule: "every fortnight", today: "2026-07-28", due: "2026-07-28" },
];

// --- task-query-grammar ------------------------------------------------------
//
// The grammar's vectors pin **both halves** of the closedness claim: what is
// accepted, and — just as importantly — what is refused and why. An independent
// implementation that accepted one extra clause would still pass a
// parse-only vector set; the drop cases are what make it fail.

export type QueryVectorCase = {
  vector_id: string;
  description: string;
  case_kind: "parse" | "drop" | "refuse";
  query: string;
  expected_clause_kinds: string[];
  expected_dropped: Array<{ text: string; reason: string }>;
  expected_refused: boolean;
};

export type QueryVectorSpec = {
  slug: string;
  kind: QueryVectorCase["case_kind"];
  desc: string;
  query: string;
};

export function buildQueryVectorCase(spec: QueryVectorSpec): QueryVectorCase {
  const parsed = parseTaskQueryForVectors(spec.query);
  return {
    vector_id: `task-query-grammar/v0.1/${spec.slug}`,
    description: spec.desc,
    case_kind: spec.kind,
    query: spec.query,
    expected_clause_kinds: parsed.clauses.map((c) => c.kind),
    expected_dropped: parsed.warnings.map((w) => ({ text: w.text, reason: w.reason })),
    expected_refused: parsed.refused,
  };
}

export const QUERY_VECTOR_SPECS: readonly QueryVectorSpec[] = [
  // --- every roster clause --------------------------------------------------
  { slug: "done", kind: "parse", desc: "Completion state: done.", query: "done" },
  { slug: "not-done", kind: "parse", desc: "Completion state: not done.", query: "not done" },
  { slug: "due-before-absolute", kind: "parse", desc: "A due comparison against an absolute date.", query: "due before 2026-08-01" },
  { slug: "due-after-named", kind: "parse", desc: "A due comparison against a named day.", query: "due after today" },
  { slug: "due-on-relative", kind: "parse", desc: "A due comparison against a parameterized relative constant.", query: "due on in 3 days" },
  { slug: "due-relative-past", kind: "parse", desc: "The past-facing relative form.", query: "due after 2 weeks ago" },
  { slug: "no-due-date", kind: "parse", desc: "Absence of a due date.", query: "no due date" },
  { slug: "path-includes", kind: "parse", desc: "Folder-path containment.", query: "path includes Projects/Myne" },
  { slug: "tag-includes", kind: "parse", desc: "Tag containment; the leading hash is not part of the value.", query: "tag includes #work" },
  { slug: "priority-is", kind: "parse", desc: "Priority, one of the five levels.", query: "priority is high" },
  { slug: "sort-by-due", kind: "parse", desc: "Sort, ascending by default.", query: "sort by due" },
  { slug: "sort-reverse", kind: "parse", desc: "Sort, descending.", query: "sort by priority reverse" },
  { slug: "limit", kind: "parse", desc: "An explicit row limit.", query: "limit 25" },
  { slug: "multi-clause", kind: "parse", desc: "Several clauses, AND'd.", query: "not done\ndue before today\nsort by due\nlimit 5" },
  { slug: "comments-and-blanks", kind: "parse", desc: "Blank lines and comments are not clauses and produce no warning.", query: "\n# a note to self\n\ndone\n" },

  // --- representative drops -------------------------------------------------
  { slug: "drop-unrecognized", kind: "drop", desc: "An out-of-roster clause drops with a warning and the rest still runs.", query: "not done\ngroup by heading" },
  { slug: "drop-function-filter", kind: "drop", desc: "The filtering function form is refused.", query: "not done\nfilter by function task.due.moment.month === 7" },
  { slug: "drop-function-sort", kind: "drop", desc: "The sorting function form is refused too — naming only one would break closedness.", query: "not done\nsort by function task.description.length" },
  { slug: "drop-function-group", kind: "drop", desc: "The grouping function form is refused as well.", query: "not done\ngroup by function task.path" },
  { slug: "drop-field-in-value-position", kind: "drop", desc: "A FIELD NAME where a value goes: the boundary rule, refused.", query: "not done\ndue before scheduled" },
  { slug: "drop-arithmetic", kind: "drop", desc: "An expression that reads a field and operates on it.", query: "not done\ndue before due + 3d" },
  { slug: "drop-unknown-priority", kind: "drop", desc: "A priority word outside the five levels is not approximated.", query: "not done\npriority is urgent" },
  { slug: "drop-comparative-priority", kind: "drop", desc: "A comparative priority is not in the roster.", query: "not done\npriority is above medium" },

  // --- the widen guard ------------------------------------------------------
  { slug: "refuse-all-dropped", kind: "refuse", desc: "Every clause dropped: the query REFUSES rather than matching everything.", query: "group by heading\nhide task count" },
  { slug: "refuse-field-to-field", kind: "refuse", desc: "Field-to-field comparison is not representable; nothing survives.", query: "due before scheduled\ndue after start" },
  { slug: "empty-is-unfiltered", kind: "parse", desc: "A genuinely empty query is unfiltered — NOT refused. The distinction the guard rests on.", query: "" },
];
