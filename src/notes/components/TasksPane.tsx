// The vault-wide task tab (MYND-616, task 4) and the note-scoped panel body
// (task 5), as two thin wrappers over ONE `TaskListPanel`.
//
// They differ in exactly three things: which task list they hand down, the
// `scope` they pass to the rows, and where their filter state lives. Everything
// else — the four filters, the overdue count, the empty states, the row — is the
// same component instance shape. That is the "literally one component with a
// scope parameter" claim made concrete rather than asserted.
//
// The vault-wide tab keeps its filter and scope **with the tab** in the
// workspace descriptor (task 9). The note-scoped panel keeps its filter in
// component state: the right panel is not a tab strip and has no per-tab
// descriptor to ride, and a panel filter that survived a restart would be a
// preference — which this feature deliberately does not add.

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { TaskListPanel } from "./TaskListPanel";
import { toggleTaskSwallowingRefusal } from "../toggleTask";
import { TASK_FILTERS, type TaskFilter } from "../taskFilters";
import { useLocalToday } from "../useLocalToday";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { EMPTY_SCOPE, type TaskScope } from "../taskScope";
import { useLiveVaultTasks, type VaultTask } from "../taskIndex";
import { useWorkspace } from "../workspaceContext";
import { useSelectedNote } from "../sidebarState";
import type { WorkspaceItem, PaneId } from "../workspaceState";

/** A persisted filter name back to the closed union, defaulting on anything else. */
function asFilter(raw: string | undefined): TaskFilter {
  return (TASK_FILTERS as readonly string[]).includes(raw ?? "")
    ? (raw as TaskFilter)
    : "today";
}

/** The scope a persisted task tab carries, defaulting to the unset scope. */
function asScope(raw: { folder?: string; tags?: readonly string[] } | undefined): TaskScope {
  if (raw === undefined) return EMPTY_SCOPE;
  return { folder: raw.folder ?? null, tags: raw.tags ?? [] };
}

/** The vault-wide task list, mounted as a pane body. */
export function TasksPane({ paneId, item }: { paneId: PaneId; item: WorkspaceItem }): ReactElement {
  const ws = useWorkspace();
  const tasks = useLiveVaultTasks();
  // myne#279: "today" follows the display timezone when one is set.
  const { timeZone: zone } = useDateTimeDisplay();
  // Not a `useMemo` on the zone: that re-runs when the ZONE changes and never
  // when the DAY does, so a window left open across midnight kept yesterday's
  // buckets (myne-md/myne#557).
  const today = useLocalToday(zone);

  const persisted = item.kind === "tasks" ? item : undefined;
  const filter = asFilter(persisted?.taskFilter);
  const scope = asScope(persisted?.taskScope);

  const onFilterChange = useCallback(
    (next: TaskFilter) => ws.setTaskTabState(paneId, { filter: next }),
    [ws, paneId],
  );
  const onToggle = useCallback(
    (task: VaultTask) => void toggleTaskSwallowingRefusal(task, ws.flushAll),
    [ws.flushAll],
  );
  const onOpen = useCallback((task: VaultTask) => ws.openInFocused(task.noteId), [ws]);

  return (
    <TaskListPanel
      tasks={tasks}
      scope={scope}
      filter={filter}
      today={today}
      rowScope="vault"
      onFilterChange={onFilterChange}
      onToggle={onToggle}
      onOpen={onOpen}
      testIdPrefix="tasks"
    />
  );
}

/** The open note's tasks, mounted as a right-panel tab body. */
export function NoteTasksPanel(): ReactElement {
  const ws = useWorkspace();
  const all = useLiveVaultTasks();
  const { selectedId } = useSelectedNote();
  const { timeZone: zone } = useDateTimeDisplay();
  // Not a `useMemo` on the zone: that re-runs when the ZONE changes and never
  // when the DAY does, so a window left open across midnight kept yesterday's
  // buckets (myne-md/myne#557).
  const today = useLocalToday(zone);
  const [filter, setFilter] = useState<TaskFilter>("all");

  // Every record already carries its note, so narrowing needs no new query
  // capability — the point task 5 makes about the two surfaces sharing data.
  const tasks = useMemo(
    () => (selectedId === null ? [] : all.filter((t) => t.noteId === selectedId)),
    [all, selectedId],
  );

  const onToggle = useCallback(
    (task: VaultTask) => void toggleTaskSwallowingRefusal(task, ws.flushAll),
    [ws.flushAll],
  );

  return (
    <TaskListPanel
      tasks={tasks}
      scope={EMPTY_SCOPE}
      filter={filter}
      today={today}
      rowScope="note"
      onFilterChange={setFilter}
      onToggle={onToggle}
      testIdPrefix="notePanel.tasks"
    />
  );
}
