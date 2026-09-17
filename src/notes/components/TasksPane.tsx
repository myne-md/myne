// The vault-wide task tab (MYND-616, task 4; view redesigned for myne-md/myne#656)
// and the note-scoped panel body (task 5), as two thin wrappers over ONE
// `TaskListPanel`.
//
// They differ in exactly three things: which task list they hand down, the
// `rowScope` they pass, and where their view state lives. Everything else - the
// sections, the filter row, the windowing, the rows - is the same component.
//
// The vault-wide tab keeps its view (filters + sort) **with the tab** in the
// workspace descriptor. The note-scoped panel keeps it in component state: the
// right panel is not a tab strip and has no per-tab descriptor to ride.

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { TaskListPanel } from "./TaskListPanel";
import { toggleTaskSwallowingRefusal } from "../toggleTask";
import { useLocalToday } from "../useLocalToday";
import { useDateTimeDisplay } from "../../lib/useDateTimeDisplay";
import { DEFAULT_TASK_VIEW, type TaskView } from "../taskView";
import { useLiveVaultTasks, type VaultTask } from "../taskIndex";
import { useWorkspace } from "../workspaceContext";
import { useSelectedNote } from "../sidebarState";
import { requestRevealTask } from "../views/revealTaskSignal";
import type { WorkspaceItem, PaneId } from "../workspaceState";
import { taskViewOf } from "../workspaceState";

/** The vault-wide task list, mounted as a pane body. */
export function TasksPane({ paneId, item }: { paneId: PaneId; item: WorkspaceItem }): ReactElement {
  const ws = useWorkspace();
  const tasks = useLiveVaultTasks();
  // myne#279: "today" follows the display timezone when one is set; myne#557:
  // it must also tick at midnight, so it is a hook, not a memo on the zone.
  const { timeZone: zone } = useDateTimeDisplay();
  const today = useLocalToday(zone);

  // Container-level, so closing and reopening the tab restores the filters.
  // On a vault written before the container field existed, fall back to the
  // tab's own persisted view instead of silently dropping it (myne-md/myne#656
  // review).
  const view = ws.taskViewIsSet ? ws.taskView : taskViewOf(item);
  const onViewChange = useCallback(
    (next: TaskView) => ws.setTaskViewState(paneId, next),
    [ws, paneId],
  );
  const onToggle = useCallback(
    (task: VaultTask) => void toggleTaskSwallowingRefusal(task, ws.flushAll),
    [ws.flushAll],
  );
  const onOpen = useCallback(
    (task: VaultTask) => {
      // Open the note, then ask the focused pane to scroll to the task's line.
      ws.openInFocused(task.noteId);
      if (task.lineIndex !== null) requestRevealTask(task.noteId, task.lineIndex, task.rawLine);
    },
    [ws],
  );

  return (
    <TaskListPanel
      tasks={tasks}
      view={view}
      today={today}
      rowScope="vault"
      onViewChange={onViewChange}
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
  const today = useLocalToday(zone);
  // A single-file view: showing completed and open together is the point, so the
  // default status here is `all`, unlike the vault-wide tab's `undone`.
  const [view, setView] = useState<TaskView>({ ...DEFAULT_TASK_VIEW, status: "all" });

  // Every record already carries its note, so narrowing needs no new query
  // capability - the point task 5 makes about the two surfaces sharing data.
  const tasks = useMemo(
    () => (selectedId === null ? [] : all.filter((t) => t.noteId === selectedId)),
    [all, selectedId],
  );

  const onToggle = useCallback(
    (task: VaultTask) => void toggleTaskSwallowingRefusal(task, ws.flushAll),
    [ws.flushAll],
  );
  const onOpen = useCallback(
    (task: VaultTask) => {
      // Make sure the note is open (it may not be, even when selected), then ask
      // its pane to scroll to the line.
      ws.openInFocused(task.noteId);
      if (task.lineIndex !== null) requestRevealTask(task.noteId, task.lineIndex, task.rawLine);
    },
    [ws],
  );

  return (
    <TaskListPanel
      tasks={tasks}
      view={view}
      today={today}
      rowScope="note"
      onViewChange={setView}
      onToggle={onToggle}
      onOpen={onOpen}
      testIdPrefix="notePanel.tasks"
      minimal
    />
  );
}
