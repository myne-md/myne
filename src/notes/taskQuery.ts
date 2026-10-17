// The task-query grammar (MYND-617, tasks 1–3).
//
// A **closed** keyword vocabulary, consumed with an exhaustiveness guard, so
// arithmetic, function calls and field-to-field comparison are not merely
// rejected but **unrepresentable**. There is no code path that evaluates an
// expression, because no type can hold one.
//
// THE BOUNDARY IS FIELD REFERENCE AND COMPOSITION, NOT PARAMETERS.
//
//   **A field name may never appear where a value goes.**
//
// That single sentence is the whole rule. `in 3 days` is a *parameterized
// constant* — the same shape the recurrence vocabulary already accepts — and is
// admitted. `due + 3d` is an *expression*: it reads a field and operates on it,
// and once that is representable so is comparing two fields to each other, and
// from there a query language needs an evaluator. `QueryValue` below is a union
// of absolute, named and relative-with-parameter; a field reference is not a
// member of it, and the exhaustiveness guard makes that a compile-time
// guarantee rather than a convention.
//
// TOTALITY. `parseTaskQuery` never throws and never silently swallows. Every
// line it cannot read produces a structured warning naming what was dropped, and
// the lines it *could* read still produce a working query. This is the
// importer's machine — a total leaf parser, a typed warning record, a tally —
// and it transfers directly.
//
// THE WIDEN GUARD. A query whose clauses were **all** dropped REFUSES. It must
// not collapse to "match everything": a misunderstood query that silently
// renders the entire vault looks like a correct enormous result, which is the
// worst failure available here. A genuinely empty query — no clauses written at
// all — is a different case and legitimately means unfiltered.

import { shiftDay } from "./taskFilters";

/** The five priority levels, shared with the dialect's typing. */
export const QUERY_PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;
export type QueryPriority = (typeof QUERY_PRIORITIES)[number];

/** Named relative days. A closed list — no `next monday` arithmetic. */
export const QUERY_NAMED_DAYS = ["today", "tomorrow", "yesterday"] as const;
export type QueryNamedDay = (typeof QUERY_NAMED_DAYS)[number];

export const QUERY_UNITS = ["day", "week", "month", "year"] as const;
export type QueryUnit = (typeof QUERY_UNITS)[number];

/**
 * A value a comparison may be given.
 *
 * **A field reference is deliberately not a member.** Adding one is what turns a
 * filter into an expression language, and the `never` guards below would stop
 * compiling — which is the point.
 */
export type QueryValue =
  /** `2026-08-01` */
  | { readonly kind: "absolute"; readonly date: string }
  /** `today` / `tomorrow` / `yesterday` */
  | { readonly kind: "named"; readonly name: QueryNamedDay }
  /** `in 3 days` / `3 weeks ago` — a parameterized CONSTANT, not arithmetic. */
  | {
      readonly kind: "relative";
      readonly amount: number;
      readonly unit: QueryUnit;
      readonly direction: "future" | "past";
    };

/** One clause of a query. The roster is frozen normatively (task 13). */
export type QueryClause =
  | { readonly kind: "done"; readonly done: boolean }
  | { readonly kind: "dueCompare"; readonly op: "before" | "after" | "on"; readonly value: QueryValue }
  | { readonly kind: "noDueDate" }
  | { readonly kind: "pathIncludes"; readonly text: string }
  | { readonly kind: "tagIncludes"; readonly text: string }
  | { readonly kind: "priorityIs"; readonly priority: QueryPriority }
  | {
      readonly kind: "sortBy";
      readonly field: "due" | "priority" | "path";
      readonly direction: "asc" | "desc";
    }
  | { readonly kind: "limit"; readonly count: number };

/** A clause the parser could not read, named so the widget can report it. */
export type QueryWarning = {
  /** Zero-based line within the query body. */
  readonly line: number;
  /** The source text, verbatim — what the widget shows the user. */
  readonly text: string;
  /** Why it was dropped, as a stable machine-readable reason. */
  readonly reason: "unrecognized" | "function-valued" | "expression" | "malformed-value";
};

export type ParsedQuery = {
  readonly clauses: readonly QueryClause[];
  readonly warnings: readonly QueryWarning[];
  /**
   * Every clause was dropped, so the query **refuses** rather than widening to
   * the whole vault. Distinct from an empty result and distinct from a query
   * with no clauses at all.
   */
  readonly refused: boolean;
};

/**
 * The three function-valued clause forms of the upstream grammar.
 *
 * All three are excluded, not just the filtering one — naming one and silently
 * accepting the others would break the closedness claim outright.
 */
const FUNCTION_CLAUSES = ["filter by function", "sort by function", "group by function"] as const;

/**
 * Shapes that read a field and operate on it — the expression boundary.
 *
 * Deliberately narrow: it names a FIELD followed by an operator, rather than
 * hunting for operator characters. A broad "any arithmetic operator followed by
 * a digit" pattern looks equivalent and is not — it matches the `-0` inside
 * `2026-08-01` and refuses every absolute date in the grammar. (It did, until a
 * test said so.)
 *
 * This pattern only chooses a better *reason* for a refusal. The refusal itself
 * comes from `parseQueryValue`, which admits nothing outside the closed union;
 * a shape that slips past here still fails there.
 */
const EXPRESSION_HINT =
  /\b(?:due|scheduled|start|created|done|priority|path|tag)\s*[+\-*/]\s*\d|\$\{|=>|\btask\./;

const PRIORITY_SET: ReadonlySet<string> = new Set(QUERY_PRIORITIES);
const NAMED_SET: ReadonlySet<string> = new Set(QUERY_NAMED_DAYS);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNIT_WORD: ReadonlyMap<string, QueryUnit> = new Map([
  ["day", "day"],
  ["days", "day"],
  ["week", "week"],
  ["weeks", "week"],
  ["month", "month"],
  ["months", "month"],
  ["year", "year"],
  ["years", "year"],
]);

/**
 * Read a VALUE. Returns null for anything outside the closed value union —
 * including a bare field name, which is how "a field name may never appear
 * where a value goes" is enforced at the parser rather than merely asserted.
 */
export function parseQueryValue(raw: string): QueryValue | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return null;

  if (ISO_DATE.test(text)) {
    // Shape only; reality is checked by the evaluator's own date helpers, which
    // are the single typing authority (§3.6.4 consume-never-redefine).
    return { kind: "absolute", date: text };
  }
  if (NAMED_SET.has(text)) return { kind: "named", name: text as QueryNamedDay };

  // `in 3 days`
  const future = /^in (\d{1,4}) ([a-z]+)$/.exec(text);
  if (future) {
    const unit = UNIT_WORD.get(future[2]!);
    const amount = Number(future[1]);
    if (unit !== undefined && amount >= 0) {
      return { kind: "relative", amount, unit, direction: "future" };
    }
    return null;
  }

  // `3 weeks ago`
  const past = /^(\d{1,4}) ([a-z]+) ago$/.exec(text);
  if (past) {
    const unit = UNIT_WORD.get(past[2]!);
    const amount = Number(past[1]);
    if (unit !== undefined && amount >= 0) {
      return { kind: "relative", amount, unit, direction: "past" };
    }
    return null;
  }

  return null;
}

/** Resolve a value to a concrete `YYYY-MM-DD`, given today. */
export function resolveQueryValue(value: QueryValue, today: string): string {
  switch (value.kind) {
    case "absolute":
      return value.date;
    case "named":
      return value.name === "today"
        ? today
        : value.name === "tomorrow"
          ? shiftDay(today, 1)
          : shiftDay(today, -1);
    case "relative": {
      const days =
        value.unit === "day"
          ? value.amount
          : value.unit === "week"
            ? value.amount * 7
            : value.unit === "month"
              ? value.amount * 30
              : value.amount * 365;
      return shiftDay(today, value.direction === "future" ? days : -days);
    }
    default: {
      // Exhaustiveness guard. Adding a field-reference variant to `QueryValue`
      // would fail to compile here — which is what makes the boundary a
      // compile-time guarantee rather than a convention.
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** One line → one clause, or a reason it was dropped. */
function parseClause(raw: string): QueryClause | QueryWarning["reason"] {
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");

  for (const fn of FUNCTION_CLAUSES) {
    if (text.startsWith(fn)) return "function-valued";
  }
  if (EXPRESSION_HINT.test(text)) return "expression";

  // --- completion state ---------------------------------------------------
  if (text === "done") return { kind: "done", done: true };
  if (text === "not done") return { kind: "done", done: false };

  // --- absence of a due date ----------------------------------------------
  if (text === "no due date") return { kind: "noDueDate" };
  if (text === "has due date") return { kind: "dueCompare", op: "after", value: { kind: "absolute", date: "0000-01-01" } };

  // --- due-date comparisons ------------------------------------------------
  const due = /^due (before|after|on) (.+)$/.exec(text);
  if (due) {
    const value = parseQueryValue(due[2]!);
    // A bare field name lands here: `due before scheduled` parses the operator
    // and then fails at the value, which is exactly the intended refusal.
    if (value === null) return "malformed-value";
    return { kind: "dueCompare", op: due[1] as "before" | "after" | "on", value };
  }

  // --- containment ----------------------------------------------------------
  const path = /^path includes (.+)$/.exec(text);
  if (path) return { kind: "pathIncludes", text: path[1]!.trim() };

  const tag = /^tags? includes? (.+)$/.exec(text);
  if (tag) return { kind: "tagIncludes", text: tag[1]!.trim().replace(/^#/, "") };

  // --- priority -------------------------------------------------------------
  const priority = /^priority is (?:above |below )?([a-z]+)$/.exec(text);
  if (priority) {
    if (/^priority is (above|below) /.test(text)) return "unrecognized";
    if (!PRIORITY_SET.has(priority[1]!)) return "malformed-value";
    return { kind: "priorityIs", priority: priority[1] as QueryPriority };
  }

  // --- sort -----------------------------------------------------------------
  const sort = /^sort by (due|priority|path)( reverse)?$/.exec(text);
  if (sort) {
    return {
      kind: "sortBy",
      field: sort[1] as "due" | "priority" | "path",
      direction: sort[2] === undefined ? "asc" : "desc",
    };
  }

  // --- limit ----------------------------------------------------------------
  const limit = /^limit(?: to)? (\d{1,5})(?: tasks?)?$/.exec(text);
  if (limit) {
    const count = Number(limit[1]);
    if (count < 1) return "malformed-value";
    return { kind: "limit", count };
  }

  return "unrecognized";
}

/**
 * Parse a query body. **Never throws.**
 *
 * Blank lines and `#` comments are ignored without warning — they are not
 * clauses a user wrote and failed to have understood.
 */
export function parseTaskQuery(body: string): ParsedQuery {
  const clauses: QueryClause[] = [];
  const warnings: QueryWarning[] = [];
  let considered = 0;

  body.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;
    considered++;
    const parsed = parseClause(line);
    if (typeof parsed === "string") {
      warnings.push({ line: index, text: line, reason: parsed });
      return;
    }
    clauses.push(parsed);
  });

  // The widen guard. `considered === 0` is a genuinely empty query, which is
  // legitimately unfiltered; ≥1 considered with 0 understood is a query that was
  // MISREAD, and rendering the whole vault for it would look like success.
  const refused = considered > 0 && clauses.length === 0;
  return { clauses, warnings, refused };
}

/** How many clauses were dropped — the tally the widget shows. */
export function droppedCount(query: ParsedQuery): number {
  return query.warnings.length;
}
