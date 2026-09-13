// The vault-wide task panel's view model (myne-md/myne#656, folded).
//
// The panel used to expose four fixed date tabs (Today / Upcoming / Overdue /
// All) and one sort. That is a reduced copy of a filter vocabulary the repo
// already ships for task-query blocks (`taskQueryRun.ts` / `task-query-builder.ts`)
// — status, due window, path, tag, priority, sort — and the four tabs cannot
// express "by file" or "newest", which is what a vault with thousands of tasks
// needs. This module is the ONE place that turns a `TaskView` into the rows a
// surface shows, so the panel and the query engine cannot drift on predicate
// meaning.
//
// It is pure and React-free; the panel owns scroll and rendering.

import type { VaultTask } from "./taskIndex";
import {
  UPCOMING_WINDOW_DAYS,
  matchesFilter,
  priorityRank,
  shiftDay,
  sortTasks,
  taskDate,
} from "./taskFilters";
import { filterTasksByScope } from "./taskScope";
import { taskDescription } from "../dialect/taskFieldWriter";
import { taskRowKey } from "./taskWriteCore";

/** Completion axis. `undone` is the default: a work list is work to do. */
export type TaskStatusFilter = "undone" | "all" | "done";

/** Date axis. `any` does not constrain; the sections still bucket what passes. */
export type TaskDueFilter =
  | "any"
  | "overdue"
  | "today"
  | "upcoming"
  | "later"
  | "none";

export type TaskPriorityFilter =
  | "any"
  | "highest"
  | "high"
  | "medium"
  | "low"
  | "lowest";

/** Within-section order. Section order is fixed (see `TASK_SECTION_ORDER`). */
export type TaskSort = "due" | "dueDesc" | "priority" | "note";

export type TaskSectionKey =
  | "overdue"
  | "today"
  | "upcoming"
  | "later"
  | "none"
  | "done";

/**
 * Everything the panel persists with its tab. `folder`/`tags` are the existing
 * `TaskScope` axes; `noteId` narrows to one file, which is the "separate by
 * file" the fixed tabs could not express.
 */
export type TaskView = {
  readonly status: TaskStatusFilter;
  readonly due: TaskDueFilter;
  readonly folder: string | null;
  readonly noteId: string | null;
  readonly tags: readonly string[];
  readonly priority: TaskPriorityFilter;
  readonly sort: TaskSort;
};

export const DEFAULT_TASK_VIEW: TaskView = {
  status: "undone",
  due: "any",
  folder: null,
  noteId: null,
  tags: [],
  priority: "any",
  sort: "due",
};

/** The sections, in the fixed attention-first order. `done` is appended. */
export const TASK_SECTION_ORDER: readonly TaskSectionKey[] = [
  "overdue",
  "today",
  "upcoming",
  "later",
  "none",
];

export type TaskSection = { readonly key: TaskSectionKey; readonly tasks: VaultTask[] };

/**
 * The text the panel searches and a row displays. Shared with the panel's search
 * box so the box matches what the user reads, not the raw source line.
 */
export function taskSearchText(task: VaultTask): string {
  return task.lineIndex === null
    ? (task.noteTitle ?? "")
    : taskDescription(task.rawLine);
}

/** Which date bucket a task falls in, given `today` as `YYYY-MM-DD`. */
export function dueSection(date: string | undefined, today: string): TaskSectionKey {
  if (date === undefined) return "none";
  if (date < today) return "overdue";
  if (date === today) return "today";
  if (date <= shiftDay(today, UPCOMING_WINDOW_DAYS)) return "upcoming";
  return "later";
}

/**
 * Whether a task passes the completion, priority and due axes.
 *
 * The shared windows (`overdue` / `today` / `upcoming`) go through
 * `matchesFilter`, so their boundaries are defined in exactly one place; only
 * `later` (beyond the upcoming window) and `none` (undated) are new to this
 * model, and they are stated once, here.
 */
export function matchesView(task: VaultTask, view: TaskView, today: string): boolean {
  if (view.status === "undone" && task.completed) return false;
  if (view.status === "done" && !task.completed) return false;
  if (view.priority !== "any" && (task.priority ?? "") !== view.priority) return false;

  switch (view.due) {
    case "any":
      return true;
    case "overdue":
      return matchesFilter(task, "overdue", today);
    case "today":
      return matchesFilter(task, "today", today);
    case "upcoming":
      return matchesFilter(task, "upcoming", today);
    case "later": {
      const date = taskDate(task);
      return date !== undefined && date > shiftDay(today, UPCOMING_WINDOW_DAYS);
    }
    case "none":
      return taskDate(task) === undefined;
    default: {
      const exhaustive: never = view.due;
      return exhaustive;
    }
  }
}

function compareDue(a: VaultTask, b: VaultTask): number {
  const da = taskDate(a);
  const db = taskDate(b);
  if (da === db) return 0;
  if (da === undefined) return 1;
  if (db === undefined) return -1;
  return da < db ? -1 : 1;
}

function noteKey(task: VaultTask): string {
  return (task.noteTitle ?? "").toLocaleLowerCase();
}

/**
 * Total order within an open section: the chosen axis, then the usual chain.
 * The default (`due`) is `sortTasks` verbatim, so the panel and the query block
 * cannot disagree about what "ordered by due date" means.
 */
function sortOpen(tasks: readonly VaultTask[], sort: TaskSort): VaultTask[] {
  if (sort === "due") return sortTasks(tasks);
  return [...tasks].sort((a, b) => {
    let c = 0;
    if (sort === "priority") c = priorityRank(a) - priorityRank(b) || compareDue(a, b);
    else if (sort === "note") c = noteKey(a) < noteKey(b) ? -1 : noteKey(a) > noteKey(b) ? 1 : compareDue(a, b);
    else c = compareDue(b, a); // dueDesc
    if (c !== 0) return c;
    const p = priorityRank(a) - priorityRank(b);
    if (p !== 0) return p;
    const n = noteKey(a) < noteKey(b) ? -1 : noteKey(a) > noteKey(b) ? 1 : 0;
    if (n !== 0) return n;
    return (a.lineIndex ?? -1) - (b.lineIndex ?? -1);
  });
}

/**
 * A flat Done section, newest completion first. `done` is the completion date
 * (a line-task's `[done:: …]` field, a note-task's `updated` timestamp); a
 * completed task with no recorded date sorts after the dated ones rather than
 * being dropped.
 */
function sortDone(tasks: readonly VaultTask[]): VaultTask[] {
  return [...tasks].sort((a, b) => {
    const da = a.done;
    const db = b.done;
    if (da !== db) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      return da < db ? 1 : -1;
    }
    const c = compareDue(a, b);
    if (c !== 0) return c;
    return (a.lineIndex ?? -1) - (b.lineIndex ?? -1);
  });
}

/**
 * Filter, partition and sort in one step — what the panel actually calls.
 *
 * Scope (folder/tags) goes through the shared `filterTasksByScope`, and the
 * remaining axes through `matchesView`, so neither adds a second predicate
 * language. `search` is passed separately because it is transient (never
 * persisted with the tab), unlike the rest of the view.
 */
export function partitionTasks(
  tasks: readonly VaultTask[],
  view: TaskView,
  today: string,
  tagsOf: (noteId: string) => readonly string[],
  search = "",
): TaskSection[] {
  const q = search.trim().toLowerCase();
  const scoped = filterTasksByScope(
    tasks,
    { folder: view.folder, tags: view.tags },
    tagsOf,
  );
  const matched = scoped.filter((task) => {
    if (view.noteId !== null && task.noteId !== view.noteId) return false;
    if (!matchesView(task, view, today)) return false;
    if (q !== "" && !taskSearchText(task).toLowerCase().includes(q)) return false;
    return true;
  });

  const out: TaskSection[] = [];
  if (view.status !== "done") {
    const open = matched.filter((task) => !task.completed);
    for (const key of TASK_SECTION_ORDER) {
      const list = open.filter((task) => dueSection(taskDate(task), today) === key);
      if (list.length > 0) out.push({ key, tasks: sortOpen(list, view.sort) });
    }
  }
  if (view.status !== "undone") {
    const done = matched.filter((task) => task.completed);
    if (done.length > 0) out.push({ key: "done", tasks: sortDone(done) });
  }
  return out;
}

/** Distinct folders present in the set, sorted — the scope control's options. */
export function distinctFolders(tasks: readonly VaultTask[]): string[] {
  const out = new Set<string>();
  for (const task of tasks) if (task.noteFolder !== null) out.add(task.noteFolder);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Distinct tags present in the set, sorted — the tag control's options. */
export function distinctTags(
  tasks: readonly VaultTask[],
  tagsOf: (noteId: string) => readonly string[],
): string[] {
  const out = new Set<string>();
  for (const task of tasks) for (const tag of tagsOf(task.noteId)) out.add(tag);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Stable key for a task, re-exported so the panel imports one module. */
export { taskRowKey };
