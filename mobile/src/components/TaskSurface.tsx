// The mobile task surface (MYND-620, task 2; view redesigned myne-md/myne#656).
//
// **One component, both scopes.** The vault-wide destination and the note-scoped
// sheet differ by one prop.
//
// It renders the **desktop's own `TaskListPanel`**, aliased in as
// `@myne/task-panel`. That is stronger than consuming just the row: the filter
// row, the sections, the windowing, the four empty states and the sort order are
// identical to the desktop **by construction** rather than by two implementations
// agreeing. This file adds data, state and platform IO, and no task behaviour.
//
// The old mobile-only `TaskScopeStrip` is retired: folder/tag narrowing is now
// one of the shared filter row's axes, so there is no second scope control to
// drift from the desktop's.

import { useMemo, useState, type ReactNode } from "react";
import { TaskListPanel } from "@myne/task-panel";
import { DEFAULT_TASK_VIEW, type TaskView } from "@myne/task-view";
import { todayLocal } from "@myne/task-filters";
import { setTaskCompleted, useVaultTasks, type VaultTask } from "../lib/tasks";

export type TaskSurfaceScope =
  /** Every task in the vault - the bottom-bar destination and its sidebar tab. */
  | { kind: "vault" }
  /** Only the open note's tasks - the editor sheet and its sidebar tab. */
  | { kind: "note"; noteId: string };

export type TaskSurfaceProps = {
  scope: TaskSurfaceScope;
  /** Per-note tags, for the filter row's tag half. */
  tagsOf?: (noteId: string) => readonly string[];
  /** Open the task's note at its line. Absent → rows are not openable. */
  onOpen?: (task: VaultTask) => void;
  /** Injected in tests; production reads the local calendar day. */
  today?: string;
  testIdPrefix?: string;
};

export function TaskSurface({
  scope,
  tagsOf,
  onOpen,
  today,
  testIdPrefix,
}: TaskSurfaceProps): ReactNode {
  // The view is component state: the mobile caller is a destination, and the
  // shared panel persists desktop's per-tab copy. Mobile's default is `undone`,
  // the same as desktop's vault-wide tab.
  const [view, setView] = useState<TaskView>(DEFAULT_TASK_VIEW);
  const { tasks } = useVaultTasks();

  // The note-scoped surface narrows the SAME vault-wide fetch rather than asking
  // the backend for one note's tasks - `vault_indices_tasks` is deliberately
  // unparameterized, so every surface filters the one list.
  const visible = useMemo(
    () => (scope.kind === "note" ? tasks.filter((t) => t.noteId === scope.noteId) : tasks),
    [tasks, scope],
  );

  return (
    <TaskListPanel
      tasks={visible}
      view={view}
      today={today ?? todayLocal()}
      // The row decides for itself what context to show: the source note is
      // redundant in a note-scoped list and essential in a vault-wide one.
      rowScope={scope.kind === "note" ? "note" : "vault"}
      {...(tagsOf === undefined ? {} : { tagsOf })}
      onViewChange={setView}
      // The write goes through the SHARED sequence with mobile IO - including
      // the content-hash guard, without which a sync pull-apply racing a
      // checkbox flip would be clobbered.
      onToggle={(task) => void setTaskCompleted(task, !task.completed).catch(() => {})}
      {...(onOpen === undefined ? {} : { onOpen })}
      {...(testIdPrefix === undefined ? {} : { testIdPrefix })}
    />
  );
}
