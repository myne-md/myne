// The task list body (MYND-616, tasks 4–7).
//
// ONE body for both surfaces. The vault-wide tab and the note-scoped right-panel
// tab differ by the `scope` prop and by which task list they are handed —
// nothing else. That is what makes them "literally one component with a scope
// parameter" rather than two components that happen to look alike.
//
// It carries: the four filters (with the overdue **count** on its own tab —
// task 6), the scope selector (task 4/5), the shared `TaskRow`, and the four
// distinct empty states (task 7).
//
// EMPTY-STATE TONE IS A CONSTRAINT, not a preference. The canon forbids a green
// check and the product voice is honest rather than congratulatory: an empty
// week is **stated, not celebrated**. No confetti, no "all done!", no tick. The
// copy lives in the catalogue and the E2E asserts it, because copy drift is
// exactly what a test catches and a review does not.
//
// The **rebuilding** state is distinct from a genuinely empty result. Showing
// "no tasks" while the index is still being built is a wrong answer presented as
// a finished one — the user concludes their tasks are gone.

import { useMemo, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { TaskRow, type TaskRowData, type TaskRowScope } from "@myne/editor/host/notes/TaskRow";
import { taskDescription } from "../../dialect/taskFieldWriter";
import {
  filterAndSortTasks,
  overdueCount,
  TASK_FILTERS,
  type TaskFilter,
} from "../taskFilters";
import { filterTasksByScope, isScopeEmpty, type TaskScope } from "../taskScope";
import { taskRowKey } from "../taskWriteCore";
import type { VaultTask } from "../taskIndex";

export type TaskListPanelProps = {
  tasks: readonly VaultTask[];
  scope: TaskScope;
  filter: TaskFilter;
  today: string;
  /** Which surface this is — passed straight through to every row. */
  rowScope: TaskRowScope;
  /** Per-note tags, for the scope selector's tag half. */
  tagsOf?: (noteId: string) => readonly string[];
  /** True while the index is still being built. A wrong empty list is worse
   *  than a loading state, so this is rendered distinctly. */
  rebuilding?: boolean;
  onFilterChange: (filter: TaskFilter) => void;
  onToggle?: (task: VaultTask) => void;
  onOpen?: (task: VaultTask) => void;
  testIdPrefix?: string;
  /** Two-line rows (MYND-620 task 6). Passed straight to every row; the panel
   *  does not decide the width, its caller does. */
  twoLine?: boolean;
};

const NO_TAGS: readonly string[] = [];

/**
 * Project an index record into what a row needs.
 *
 * The optional strings are spread on `== null`, not `=== undefined`: this is the
 * projection boundary, `TaskRowData` promises optional-or-absent, and a client
 * whose fetch skipped the `taskWire.ts` decoder hands a wire `null` down here.
 * `=== undefined` would copy it into the row verbatim, which is the crash the
 * row's own guard then has to survive. `lineIndex` keeps `=== null` deliberately
 * — there it is the note-task discriminator, not an absent value.
 */
function toRowData(task: VaultTask): TaskRowData {
  return {
    key: taskRowKey(task),
    // A note-task has no line; its title is the task.
    text: task.lineIndex === null ? (task.noteTitle ?? "") : taskDescription(task.rawLine),
    completed: task.completed,
    noteTitle: task.noteTitle,
    ...(task.due == null ? {} : { due: task.due }),
    ...(task.remind == null ? {} : { remind: task.remind }),
    ...(task.repeat == null ? {} : { repeat: task.repeat }),
    ...(task.priority == null ? {} : { priority: task.priority }),
    ...(task.oversized ? { oversized: true } : {}),
  };
}

const STRIP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "6px 8px",
  borderBottom: "1px solid var(--line-1)",
  flexWrap: "wrap",
};

function tabStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 9px",
    borderRadius: "var(--radius-pill)",
    // Selection is the ONE thing a fill may carry here; it is not state about
    // the tasks, it is where the user is.
    background: active ? "var(--paper-3)" : "transparent",
    color: active ? "var(--fg-1)" : "var(--fg-2)",
    border: "1px solid transparent",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
  };
}

const COUNT_STYLE: CSSProperties = {
  // A plain muted numeral. NOT a badge, NOT alarm-coloured — the canon's state
  // rules forbid a pill that reads as a status, and an alarm colour would make
  // the backlog shout every time the panel opens.
  color: "var(--fg-3)",
  fontVariantNumeric: "tabular-nums",
  fontSize: "var(--text-xs)",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  textAlign: "center",
};

export function TaskListPanel({
  tasks,
  scope,
  filter,
  today,
  rowScope,
  twoLine,
  tagsOf,
  rebuilding = false,
  onFilterChange,
  onToggle,
  onOpen,
  testIdPrefix = "tasks",
}: TaskListPanelProps): ReactElement {
  const { t } = useTranslation();

  const scoped = useMemo(
    () => filterTasksByScope(tasks, scope, tagsOf ?? (() => NO_TAGS)),
    [tasks, scope, tagsOf],
  );
  const visible = useMemo(
    () => filterAndSortTasks(scoped, filter, today),
    [scoped, filter, today],
  );
  // Counted over the SCOPED set, not the visible one: the badge must answer
  // "how much is behind" while the user is looking at Today.
  const overdue = useMemo(() => overdueCount(scoped, today), [scoped, today]);

  /**
   * Which empty state applies. Four distinct answers, and the order matters:
   * rebuilding first (a wrong empty list presented as a finished one is the
   * worst of the four), then "no tasks at all", then scope, then filter.
   */
  const emptyKind = ((): "rebuilding" | "vault" | "scope" | "filter" | null => {
    if (rebuilding) return "rebuilding";
    if (visible.length > 0) return null;
    if (tasks.length === 0) return "vault";
    if (!isScopeEmpty(scope) && scoped.length === 0) return "scope";
    return "filter";
  })();

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
      data-testid={`${testIdPrefix}.panel`}
    >
      <div style={STRIP_STYLE} role="tablist" data-testid={`${testIdPrefix}.filters`}>
        {TASK_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={f === filter}
            style={tabStyle(f === filter)}
            data-testid={`${testIdPrefix}.filter.${f}`}
            onClick={() => onFilterChange(f)}
          >
            {t(`tasks.filter.${f}`)}
            {/* Absent rather than zero: a "0" is a statement about the backlog
                that the user did not ask for. */}
            {f === "overdue" && overdue > 0 ? (
              <span style={COUNT_STYLE} data-testid={`${testIdPrefix}.overdueCount`}>
                {overdue}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "4px 0" }}>
        {emptyKind !== null ? (
          <div style={EMPTY_STYLE} data-testid={`${testIdPrefix}.empty.${emptyKind}`}>
            {t(`tasks.empty.${emptyKind}`)}
          </div>
        ) : (
          visible.map((task) => (
            <TaskRow
              key={taskRowKey(task)}
              task={toRowData(task)}
              scope={rowScope}
              {...(twoLine === undefined ? {} : { twoLine })}
              today={today}
              testIdPrefix={`${testIdPrefix}.row`}
              {...(onToggle === undefined ? {} : { onToggle: () => onToggle(task) })}
              {...(onOpen === undefined ? {} : { onOpen: () => onOpen(task) })}
            />
          ))
        )}
      </div>
    </div>
  );
}
