// Query execution over the shared task list (MYND-617, tasks 5 and 9).
//
// **No new backend command, and no new data source.** The evaluator runs against
// the same in-memory list every other task surface reads, which is what makes
// "N blocks in one note cause one fetch, not N" true by construction rather than
// by a cache the block has to manage: the fetch belongs to `taskIndex`, and a
// block is just another consumer of it.
//
// It also reuses the **live-set gate** rather than filtering independently. The
// Rust index is deliberately trash-blind — exclusion happens at query time, in
// one place — so a block that filtered trashed notes itself would be a second
// gate to keep in step, and the one that drifts is the one nobody notices.
//
// The row limit is a **bound with a stated remainder**, not a silent truncation.
// Every other cap in this epic states what it dropped; a list that quietly shows
// 100 of 400 is a wrong answer wearing a right answer's clothes.

import { taskDate } from "./taskFilters";
import { resolveQueryValue, type ParsedQuery, type QueryClause } from "./taskQuery";
import type { VaultTask } from "./taskIndex";

/** Rows rendered when a query states no limit of its own. */
export const DEFAULT_QUERY_LIMIT = 100;

export type QueryResult = {
  /** The rows to render — at most the effective limit. */
  readonly rows: readonly VaultTask[];
  /** How many more matched beyond the limit. Zero when nothing was cut. */
  readonly remainder: number;
  /** Total matches before the limit — what the remainder is computed from. */
  readonly matched: number;
  /** The query refused (all clauses dropped); nothing was evaluated. */
  readonly refused: boolean;
};

const PRIORITY_RANK: ReadonlyMap<string, number> = new Map([
  ["highest", 0],
  ["high", 1],
  ["medium", 2],
  ["low", 3],
  ["lowest", 4],
]);

function priorityRank(task: VaultTask): number {
  return PRIORITY_RANK.get(task.priority ?? "") ?? 5;
}

function pathOf(task: VaultTask): string {
  return `${task.noteFolder ?? ""}/${task.noteTitle ?? ""}`.toLocaleLowerCase();
}

/**
 * Whether one clause admits a task.
 *
 * `sortBy` and `limit` are not predicates — they are handled by the caller — but
 * they still appear here so the `switch` stays exhaustive. That guard is the
 * closedness claim's teeth: adding a clause variant without handling it fails to
 * compile.
 */
function admits(task: VaultTask, clause: QueryClause, today: string): boolean {
  switch (clause.kind) {
    case "done":
      return task.completed === clause.done;
    case "noDueDate":
      return taskDate(task) === undefined;
    case "dueCompare": {
      const date = taskDate(task);
      if (date === undefined) return false;
      const against = resolveQueryValue(clause.value, today);
      if (clause.op === "before") return date < against;
      if (clause.op === "after") return date > against;
      return date === against;
    }
    case "pathIncludes":
      return pathOf(task).includes(clause.text.toLocaleLowerCase());
    case "tagIncludes":
      // Tags are not on the record, so the caller supplies them through
      // `tagsOf`; without it the clause matches nothing rather than everything.
      // Matching everything would silently widen the query, which is the exact
      // failure the widen guard exists to prevent.
      return false;
    case "priorityIs":
      return task.priority === clause.priority;
    case "sortBy":
    case "limit":
      return true;
    default: {
      const exhaustive: never = clause;
      return exhaustive;
    }
  }
}

/** Compare by the query's sort clause, defaulting to date-ascending. */
function comparator(
  clauses: readonly QueryClause[],
): (a: VaultTask, b: VaultTask) => number {
  const sort = clauses.find((c): c is Extract<QueryClause, { kind: "sortBy" }> =>
    c.kind === "sortBy",
  );
  const sign = sort?.direction === "desc" ? -1 : 1;
  const field = sort?.field ?? "due";

  return (a, b) => {
    let cmp = 0;
    if (field === "due") {
      const da = taskDate(a);
      const db = taskDate(b);
      // Undated last regardless of direction: an unscheduled task has not been
      // ranked, so reversing the sort must not promote it to the top.
      if (da !== db) {
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        cmp = da < db ? -1 : 1;
      }
    } else if (field === "priority") {
      cmp = priorityRank(a) - priorityRank(b);
    } else {
      const pa = pathOf(a);
      const pb = pathOf(b);
      cmp = pa === pb ? 0 : pa < pb ? -1 : 1;
    }
    if (cmp !== 0) return cmp * sign;
    // Total order, so rows do not swap places between renders.
    return (a.lineIndex ?? -1) - (b.lineIndex ?? -1);
  };
}

/**
 * Run a parsed query against the shared list.
 *
 * `tagsOf` is injected, like the panel's scope predicate, because the tag index
 * is an async IPC surface and this must stay a pure function of its inputs.
 */
export function runTaskQuery(
  query: ParsedQuery,
  tasks: readonly VaultTask[],
  today: string,
  tagsOf?: (noteId: string) => readonly string[],
): QueryResult {
  // A refused query evaluates NOTHING. Returning the unfiltered list here is
  // precisely the widening the guard exists to prevent.
  if (query.refused) return { rows: [], remainder: 0, matched: 0, refused: true };

  const matches = tasks.filter((task) =>
    query.clauses.every((clause) => {
      if (clause.kind === "tagIncludes") {
        const tags = tagsOf?.(task.noteId) ?? [];
        const want = clause.text.toLocaleLowerCase();
        return tags.some((t) => {
          const tag = t.toLocaleLowerCase();
          return tag === want || tag.startsWith(`${want}/`);
        });
      }
      return admits(task, clause, today);
    }),
  );

  matches.sort(comparator(query.clauses));

  const explicit = query.clauses.find((c): c is Extract<QueryClause, { kind: "limit" }> =>
    c.kind === "limit",
  );
  const limit = explicit?.count ?? DEFAULT_QUERY_LIMIT;

  return {
    rows: matches.slice(0, limit),
    remainder: Math.max(0, matches.length - limit),
    matched: matches.length,
    refused: false,
  };
}
