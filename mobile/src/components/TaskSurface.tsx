// The mobile task surface (MYND-620, task 2).
//
// **One component, both scopes.** The vault-wide destination and the
// note-scoped sheet differ by two props — which is the same shape
// `AttachmentsSheet` already uses for its `variant="page"` destination and its
// editor sheet, so this is an in-repo pattern rather than an invention.
//
// It renders the **desktop's own `TaskListPanel`**, aliased in as
// `@myne/task-panel`. That is stronger than consuming just the row: the filter
// strip, the overdue count, the four empty states, the sort order and the
// `due ?? remind` date axis are then identical to the desktop **by
// construction** rather than by two implementations agreeing. This file adds
// data, state and platform IO, and no task behaviour at all.
//
// What is left to the tasks after this one: the bottom-bar destination (3), the
// editor sheet (4), the sidebar tabs (5), and the two-line row at narrow width
// (6 — a change to the shared row, so it lands for every surface at once).

import { useMemo, useState, type ReactNode } from "react";
import { TaskListPanel } from "@myne/task-panel";
import { EMPTY_SCOPE, type TaskScope } from "@myne/task-scope";
import { TASK_FILTERS, todayLocal, type TaskFilter } from "@myne/task-filters";
import { setTaskCompleted, useVaultTasks, type VaultTask } from "../lib/tasks";
import { useSizeClass } from "../formfactor/SizeClassContext";
import { TaskScopeStrip } from "./TaskScopeStrip";

export type TaskSurfaceScope =
  /** Every task in the vault — the bottom-bar destination and its sidebar tab. */
  | { kind: "vault" }
  /** Only the open note's tasks — the editor sheet and its sidebar tab. */
  | { kind: "note"; noteId: string };

export type TaskSurfaceProps = {
  scope: TaskSurfaceScope;
  /** Folder/tag narrowing. Owned by the caller so the state survives leaving
   *  and re-entering the destination. */
  taskScope?: TaskScope;
  /** Omitted → no scope strip. The note-scoped surface passes nothing: you are
   *  already inside the one note, so narrowing it by folder is meaningless. */
  onScopeChange?: (next: TaskScope) => void;
  /** Per-note tags, for the scope selector's tag half. */
  tagsOf?: (noteId: string) => readonly string[];
  /** Open the task's note at its line. Absent → rows are not openable. */
  onOpen?: (task: VaultTask) => void;
  /** Injected in tests; production reads the local calendar day. */
  today?: string;
  testIdPrefix?: string;
};

/**
 * The default filter.
 *
 * `today` rather than `all`, because the question a phone gets asked is "what is
 * due today" — opening on an undifferentiated dump of every task in the vault
 * would answer a question nobody asked and bury the one they did.
 */
const DEFAULT_FILTER: TaskFilter = "today";

export function TaskSurface({
  scope,
  taskScope = EMPTY_SCOPE,
  onScopeChange,
  tagsOf,
  onOpen,
  today,
  testIdPrefix,
}: TaskSurfaceProps): ReactNode {
  const [filter, setFilter] = useState<TaskFilter>(DEFAULT_FILTER);
  const { tasks } = useVaultTasks();
  // Two lines wherever the row would otherwise have to choose between the task
  // text and its context. `compact` is the phone; the medium two-pane list
  // column is barely wider, so it takes the two-line row too. Only the expanded
  // layout, where the sidebar has room, keeps the single line.
  const { sizeClass } = useSizeClass();

  // The note-scoped surface narrows the SAME vault-wide fetch rather than asking
  // the backend for one note's tasks: `vault_indices_tasks` is deliberately
  // unparameterized (a parameterized accessor would move the §3.6.4 type
  // authority out of the dialect layer), so every surface filters the one list.
  const visible = useMemo(
    () => (scope.kind === "note" ? tasks.filter((t) => t.noteId === scope.noteId) : tasks),
    [tasks, scope],
  );

  return (
    <>
      {onScopeChange !== undefined && (
        <TaskScopeStrip
          tasks={visible}
          scope={taskScope}
          onScopeChange={onScopeChange}
          {...(tagsOf === undefined ? {} : { tagsOf })}
        />
      )}
      <TaskListPanel
        tasks={visible}
        scope={taskScope}
        filter={filter}
        today={today ?? todayLocal()}
        // The row decides for itself what context to show: the source note is
        // redundant in a note-scoped list and essential in a vault-wide one.
        rowScope={scope.kind === "note" ? "note" : "vault"}
        twoLine={sizeClass !== "expanded"}
        {...(tagsOf === undefined ? {} : { tagsOf })}
        onFilterChange={setFilter}
        // The write goes through the SHARED sequence with mobile IO — including
        // the content-hash guard, without which a sync pull-apply racing a
        // checkbox flip would be clobbered.
        onToggle={(task) => void setTaskCompleted(task, !task.completed).catch(() => {})}
        {...(onOpen === undefined ? {} : { onOpen })}
        {...(testIdPrefix === undefined ? {} : { testIdPrefix })}
      />
    </>
  );
}

/** The filter roster, re-exported so a caller's chrome cannot invent a fifth. */
export { TASK_FILTERS };
