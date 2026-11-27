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
import { setTaskCompleted, setTaskField, useVaultTasks, type VaultTask } from "../lib/tasks";
import { SCREEN_TOP } from "../components";

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
  /**
   * Controlled view state. The caller (EditorFlow) owns it so the view
   * survives destination re-entry: every mount here is conditional, so
   * component-local state would reset on each leave (myne-md/myne#656
   * review). Absent → the surface keeps its own, for standalone mounts.
   */
  view?: TaskView;
  onViewChange?: (next: TaskView) => void;
};

export function TaskSurface({
  scope,
  tagsOf,
  onOpen,
  today,
  testIdPrefix,
  view: controlledView,
  onViewChange,
}: TaskSurfaceProps): ReactNode {
  // Uncontrolled fallback for standalone mounts; EditorFlow passes both props
  // and this state stays unused there.
  const [ownView, setOwnView] = useState<TaskView>(DEFAULT_TASK_VIEW);
  const view = controlledView ?? ownView;
  const handleViewChange = onViewChange ?? setOwnView;
  const { tasks } = useVaultTasks();

  // The note-scoped surface narrows the SAME vault-wide fetch rather than asking
  // the backend for one note's tasks - `vault_indices_tasks` is deliberately
  // unparameterized, so every surface filters the one list.
  const visible = useMemo(
    () => (scope.kind === "note" ? tasks.filter((t) => t.noteId === scope.noteId) : tasks),
    [tasks, scope],
  );

  return (
    // The task DESTINATIONS are full screens, so the host supplies the page
    // frame the shared panel expects and does not carry itself: status-bar
    // clearance on top and the canon's 20px gutter on the sides. Without it the
    // search field rendered UNDER the status bar and every row sat against the
    // bezel (owner, 2026-11-27: "tasks panellerinin padding ve marginleri çok
    // yanlış").
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        paddingTop: SCREEN_TOP,
        paddingInline: 20,
      }}
    >
      <TaskListPanel
      tasks={visible}
      view={view}
      today={today ?? todayLocal()}
      // The row decides for itself what context to show: the source note is
      // redundant in a note-scoped list and essential in a vault-wide one.
      rowScope={scope.kind === "note" ? "note" : "vault"}
      // Touch-sized checkboxes: the shared dense 14px box is a mouse target.
      roomyBox
      {...(tagsOf === undefined ? {} : { tagsOf })}
      onViewChange={handleViewChange}
      // The write goes through the SHARED sequence with mobile IO - including
      // the content-hash guard, without which a sync pull-apply racing a
      // checkbox flip would be clobbered.
      onToggle={(task) => void setTaskCompleted(task, !task.completed).catch(() => {})}
      // The row's field control (myne-md/myne#884 task 8). Mobile declares the
      // docked presentation, so it opens the bottom sheet; the surface is the
      // shared list panel, so this is one prop rather than a second component.
      onWriteField={(task, kind, value) => setTaskField(task, kind, value)}
      {...(onOpen === undefined ? {} : { onOpen })}
      {...(testIdPrefix === undefined ? {} : { testIdPrefix })}
      />
    </div>
  );
}
