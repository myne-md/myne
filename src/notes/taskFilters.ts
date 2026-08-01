// Task-list filters, the date axis, and the sort (MYND-616, task 2).
//
// Pure functions over a task list with the clock **injected**. No hidden `new
// Date()` anywhere: a filter whose answer depends on an ambient clock cannot be
// tested at its boundaries, and the boundaries are the whole difficulty here.
//
// THE DATE AXIS: the due date, **falling back to the reminder**. A task carrying
// only a reminder would otherwise be filed as undated and appear in exactly one
// filter — which is the case absolute reminders exist to support ("remind me
// Tuesday to call my mother"). The axis is defined once, here, and every filter
// and the sort read it.
//
// TODAY MEANS TODAY. Overdue items are deliberately NOT folded into Today. The
// temptation is real — a daily list that hides the backlog feels dishonest — but
// folding them in makes the word stop meaning what it says, and a Today list
// that silently contains three months of arrears is not a daily list. The
// backlog stays visible instead through the overdue filter's count badge
// (task 6), which is the mechanism that answers the concern rather than the
// word "today" quietly absorbing it.

import type { VaultTask } from "./taskIndex";

// Re-exported so a consumer of this module needs only this module. Mobile
// reaches it through the `@myne/task-filters` alias (MYND-620 task 2) and would
// otherwise have to name a relative path out of its own repository — into
// `taskIndex.ts`, which is Tauri- and React-coupled.
export type { VaultTask };

/** The four filters a task surface offers. */
export const TASK_FILTERS = ["today", "upcoming", "overdue", "all"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

/** How many days forward `upcoming` reaches, inclusive of today. */
export const UPCOMING_WINDOW_DAYS = 7;

/**
 * The date a task is filed under: `due`, else `remind`, else undated.
 *
 * Returns the **day** portion only. A value may carry a wall-clock time, and
 * every filter here is day-granular, so slicing once at the axis keeps every
 * caller from re-deciding whether to compare times.
 */
export function taskDate(task: VaultTask): string | undefined {
  const raw = task.due ?? task.remind;
  // `== null` catches both undefined AND a wire `null`: the `MYI1` row serializes
  // `Option<String>` fields as `null`, and a client that skips the `taskIndex.ts`
  // `fromWire()` sanitizer (mobile) hands that null straight here — `=== undefined`
  // would let it through and `.slice` a non-string (iOS Tasks-tab crash).
  return raw == null ? undefined : raw.slice(0, 10);
}

/**
 * `date` shifted by whole days, as `YYYY-MM-DD`.
 *
 * UTC-anchored civil arithmetic, the same discipline the recurrence feature
 * uses: no local instant is formed, so no DST transition can perturb a window
 * boundary. (The recurrence module's `addDays` operates on a structured
 * `CivilDate`; this takes and returns the string form the index stores, so the
 * two are not interchangeable — but the anchoring rule is deliberately the
 * same, and neither forms a local instant.)
 */
export function shiftDay(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");
  return `${at.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Whether `task` belongs in `filter`, given `today` as `YYYY-MM-DD`.
 *
 * `all` includes undated tasks — and it is the only filter that does, by
 * construction. Every other filter is a statement about a date, so a task with
 * no date cannot satisfy one; without `all` those tasks would exist in the index
 * and appear on no surface at all.
 */
export function matchesFilter(task: VaultTask, filter: TaskFilter, today: string): boolean {
  if (filter === "all") return true;
  const date = taskDate(task);
  if (date === undefined) return false;

  switch (filter) {
    case "today":
      return date === today;
    case "upcoming": {
      // A rolling window: today through today + 6, so "upcoming" is seven days
      // INCLUDING today rather than seven days after it. The inclusive end is
      // the boundary most likely to be got wrong, so it is pinned by test.
      const end = shiftDay(today, UPCOMING_WINDOW_DAYS - 1);
      return date >= today && date <= end;
    }
    case "overdue":
      // Strictly before today. A completed task is not overdue however old it
      // is — otherwise finishing something late would leave it in the backlog
      // forever.
      return date < today && !task.completed;
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

/** Priority order, most urgent first. An absent priority sorts last. */
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

function noteKey(task: VaultTask): string {
  return (task.noteTitle ?? "").toLocaleLowerCase();
}

/**
 * Sort: **date ascending, undated last, then priority, then source note.**
 *
 * And **no grouping by default.** The list's natural question is "what is
 * next", which a flat date-ordered list answers directly; grouping fragments a
 * short list into several shorter ones and makes the answer harder to read, not
 * easier. Grouping stays available as a user choice rather than a default.
 *
 * Undated last rather than first: an undated task has not been scheduled, so it
 * cannot be more urgent than one that has.
 *
 * Returns a new array — the input is the shared cached list and must not be
 * mutated in place.
 */
export function sortTasks(tasks: readonly VaultTask[]): VaultTask[] {
  return [...tasks].sort((a, b) => {
    const da = taskDate(a);
    const db = taskDate(b);
    if (da !== db) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      return da < db ? -1 : 1;
    }
    const pa = priorityRank(a);
    const pb = priorityRank(b);
    if (pa !== pb) return pa - pb;
    const na = noteKey(a);
    const nb = noteKey(b);
    if (na !== nb) return na < nb ? -1 : 1;
    // Final tiebreak so the order is TOTAL: two tasks alike in every visible
    // way must not swap places between renders.
    return (a.lineIndex ?? -1) - (b.lineIndex ?? -1);
  });
}

/** Apply a filter and the sort in one step — what a surface actually calls. */
export function filterAndSortTasks(
  tasks: readonly VaultTask[],
  filter: TaskFilter,
  today: string,
): VaultTask[] {
  return sortTasks(tasks.filter((task) => matchesFilter(task, filter, today)));
}

/**
 * How many tasks are overdue. Exposed separately from the filter because the
 * count badge (task 6) needs it even while another filter is selected.
 */
export function overdueCount(tasks: readonly VaultTask[], today: string): number {
  let n = 0;
  for (const task of tasks) if (matchesFilter(task, "overdue", today)) n++;
  return n;
}

/** Today as `YYYY-MM-DD` in the user's LOCAL calendar — the only clock read. */
export function todayLocal(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}
