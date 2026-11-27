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
import { TaskFilterBuilder, TaskListPanel } from "@myne/task-panel";
import { Sheet } from "./misc";
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
  /** True when the caller already renders a page header (the AppHeader) above
   *  this surface, so the surface must not add its own status-bar clearance. */
  insideHeader?: boolean;
  /** Drop the source-note column, for a phone-width surface. The vault-wide list
   *  keeps it on a tablet, where there is room for one more fact per row. */
  compactWidth?: boolean;
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
  insideHeader = false,
  compactWidth = false,
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
        // The host owns the frame: `SCREEN_TOP` unless an AppHeader already sits
        // above this surface, and no extra gutter — the panel's own row padding
        // is the gutter, and adding 20pt to it made every row sit 32pt in from
        // the bezel (owner, 2026-11-27 round 2: "sol sağ padding şimdi de aşırı
        // fazla").
        ...(insideHeader ? { paddingTop: 0 } : { paddingTop: SCREEN_TOP }),
        // The shared panel insets its rows 8pt and its toolbar 12pt (its own
        // desktop geometry). On a phone that 4pt shows as rows riding left of the
        // search field, so the host closes the gap instead of forking either
        // padding.
        paddingInline: "var(--space-1)",
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
      // One line, because the windowed list owns a FIXED row height and a
      // two-line row overflowed into its neighbour (owner, 2026-11-27 round 3:
      // "rowlarda bir crop var"). The narrow screen is answered by dropping the
      // source-note column instead — see `showNoteTitle`.
      {...(compactWidth ? { showNoteTitle: false } : {})}
      // The desktop builder is a two-pane popover anchored to the toolbar. On a
      // phone that reads as a stray dropdown floating over the list, so the same
      // content is hosted in a bottom sheet instead.
      filterSheet={({ view: filterView, onViewChange, onClose, folderOptions, noteOptions, tagOptions, testIdPrefix: prefix }) => (
        <Sheet onClose={onClose}>
          <TaskFilterBuilder
            view={filterView}
            onViewChange={onViewChange}
            onClose={onClose}
            folderOptions={folderOptions}
            noteOptions={noteOptions}
            tagOptions={tagOptions}
            testIdPrefix={prefix}
          />
        </Sheet>
      )}
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
