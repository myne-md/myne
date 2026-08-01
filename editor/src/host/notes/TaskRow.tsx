// The shared task row (MYND-616, task 1).
//
// ONE row component for every task surface: the vault-wide tab, the note-scoped
// right-panel tab, and — later — the query block. It lives in the **shared
// package from day one** rather than in the desktop tree, because the mobile
// surfaces consume it too and moving it afterwards would break two repositories
// in the same change.
//
// It **reuses `taskChipToken`** rather than restating a chip look, so a row in a
// list and a chip inside a note cannot drift apart. That token module was
// written for exactly this consumer and already exports `taskChipStyle()`.
//
// SCOPE, not caller identity. The row takes `scope` and decides for itself what
// context to show — the source note is redundant in a note-scoped panel and
// essential in a vault-wide list. Branching on "who mounted me" would put that
// knowledge in three places and let them disagree; a parameter keeps it here.
//
// Canon rules that are constraints, not preferences:
//   - **no green check, anywhere**. A completed row is expressed by a filled
//     neutral box and struck-through muted text;
//   - **state is never carried by a fill.** Overdue is coloured *text* on the
//     date chip, never a red pill;
//   - the row is quiet: this is a list of work, not a scoreboard.

import type { CSSProperties, KeyboardEvent, ReactElement } from "react";
import i18n from "@myne/editor/i18n";
import { TASK_CHIP_TOKEN, taskChipStyle } from "./taskChipToken";

/**
 * Which surface the row is rendering in.
 *
 * `note` hides the source note (you are looking at it); `vault` and `query`
 * show it, because a task without its note is unlocatable.
 */
export type TaskRowScope = "vault" | "note" | "query";

/** The data one row needs. A projection of the index record, not the record. */
export type TaskRowData = {
  /** Stable identity for React keys and for the toggle callback. */
  key: string;
  /** The task's text — marker and fields already stripped (`taskDescription`). */
  text: string;
  completed: boolean;
  /** Source note title, or null for an untitled note. */
  noteTitle: string | null;
  due?: string;
  remind?: string;
  repeat?: string;
  priority?: string;
  /**
   * The record's raw line was truncated, so it cannot be written (MYND-612
   * task 5). The row still renders — dropping it would make the task vanish —
   * but its checkbox is disabled and says why.
   */
  oversized?: boolean;
};

export type TaskRowProps = {
  task: TaskRowData;
  scope: TaskRowScope;
  /** Today as `YYYY-MM-DD`, injected. There is no hidden clock in a row. */
  today: string;
  /** Omitted for a read-only mount; the checkbox then renders inert. */
  onToggle?: (task: TaskRowData) => void;
  /** Open the task's note at its line. */
  onOpen?: (task: TaskRowData) => void;
  /** Test-id prefix, so three mount points produce distinguishable ids. */
  testIdPrefix?: string;
  /**
   * Two-line layout: the task text on the first line, the date and source note
   * as quiet metadata on the second (MYND-620 task 6).
   *
   * Chosen for narrow widths, and the single-line alternatives were rejected for
   * concrete reasons rather than taste: truncating the task text removes the one
   * thing on the row that matters, and dropping the source note removes half the
   * context in a vault-wide list, where the tasks come from different notes.
   * Since one component serves every surface, the row has to work for the harder
   * case.
   */
  twoLine?: boolean;
};

/**
 * The date the row files this task under: the due date, **falling back to the
 * reminder**.
 *
 * A task carrying only a reminder would otherwise read as undated and drop out
 * of every dated view — which is the case `remind` being absolute exists to
 * support ("remind me Tuesday to call my mother"). The same axis is used by the
 * filter predicates; this function is display-side only and does not define it.
 *
 * Normalizes here rather than at each consumer. `TaskRowData` promises
 * optional-or-absent, but the `MYI1` row serializes `Option<String>` as `null`,
 * so a client whose boundary skipped the `taskWire.ts` decoder hands one down —
 * and `undefined ?? null` is `null`, which `=== undefined` misses. Both
 * consumers then break differently: `isOverdue` slices a non-string (the iOS
 * Tasks-tab crash), and the render guard emits an empty date chip. One `== null`
 * on the axis closes both, and any third consumer.
 */
function rowDate(task: TaskRowData): string | undefined {
  const raw = task.due ?? task.remind;
  return raw == null ? undefined : raw;
}

/**
 * Whether the row's date is in the past.
 *
 * Compares `YYYY-MM-DD` prefixes as strings, which is exact for that format and
 * needs no date library — the shape is fixed normatively by
 * `markdown-dialect.md` §3.6.4, so this is consuming the type authority rather
 * than adding a second one. A date carrying a time still compares correctly
 * because the day prefix is what is sliced.
 */
function isOverdue(task: TaskRowData, today: string): boolean {
  const date = rowDate(task);
  if (date === undefined || task.completed) return false;
  return date.slice(0, 10) < today;
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "6px 8px",
  borderRadius: "var(--radius-2, 6px)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.45,
  color: "var(--fg-1)",
};

const BOX_BASE: CSSProperties = {
  flex: "0 0 auto",
  width: 14,
  height: 14,
  marginTop: 3,
  borderRadius: 3,
  border: "1px solid var(--line-2, var(--line-1))",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
};

function boxStyle(completed: boolean, disabled: boolean): CSSProperties {
  return {
    ...BOX_BASE,
    // A completed box is FILLED, not ticked. The canon forbids a green check,
    // and a neutral fill says "done" without congratulating anyone.
    background: completed ? "var(--fg-3)" : "transparent",
    borderColor: completed ? "var(--fg-3)" : "var(--line-2, var(--line-1))",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

function textStyle(completed: boolean): CSSProperties {
  return {
    flex: "1 1 auto",
    minWidth: 0,
    textDecoration: completed ? "line-through" : "none",
    color: completed ? "var(--fg-3)" : "var(--fg-1)",
    overflowWrap: "anywhere",
  };
}

/** Two-line: the row becomes a column, and the metadata sits under the text. */
const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: "1 1 auto",
  minWidth: 0,
};

/** The second line. Left-aligned under the text, not right-aligned like the
 *  single-line meta block — a right-aligned second line reads as a separate
 *  column rather than as this row's own detail. */
const SECOND_LINE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  minWidth: 0,
};

const META_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "0 0 auto",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const NOTE_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  minWidth: 0,
  fontSize: 12,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 160,
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: "inherit",
};

export function TaskRow({
  task,
  scope,
  today,
  onToggle,
  onOpen,
  testIdPrefix = "task-row",
  twoLine = false,
}: TaskRowProps): ReactElement {
  const overdue = isOverdue(task, today);
  const date = rowDate(task);
  const disabled = task.oversized === true || onToggle === undefined;

  const toggle = (): void => {
    if (disabled) return;
    onToggle?.(task);
  };
  const onBoxKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    toggle();
  };

  // Built ONCE and arranged by whichever layout is active. Building the chips
  // per layout would let the two diverge on which pieces they show, which is
  // exactly the drift one shared component exists to prevent.
  const meta = (
    <>
      {date === undefined ? null : (
        <span
          style={{
            ...taskChipStyle(),
            // State as coloured TEXT, never as a fill — the canon's rule, and
            // the reason this chip's background stays neutral while overdue.
            // On the two-line layout this is also where the overdue indicator
            // lives, which is what the second line is for.
            color: overdue ? "var(--danger)" : TASK_CHIP_TOKEN.fg,
          }}
          data-testid={`${testIdPrefix}.due`}
          data-overdue={overdue ? "true" : undefined}
        >
          {date}
        </span>
      )}

      {/* The source note is a SCOPE decision, not a caller decision. */}
      {scope === "note" || task.noteTitle === null ? null : (
        <button
          type="button"
          style={NOTE_STYLE}
          data-testid={`${testIdPrefix}.note`}
          onClick={() => onOpen?.(task)}
          title={task.noteTitle}
        >
          {task.noteTitle}
        </button>
      )}
    </>
  );

  return (
    <div style={ROW_STYLE} data-testid={`${testIdPrefix}.row`} data-task-scope={scope}>
      <span
        role="checkbox"
        aria-checked={task.completed}
        aria-disabled={disabled ? true : undefined}
        aria-label={
          task.oversized === true
            ? i18n.t("tasks.row.tooLongToWrite")
            : task.completed
              ? i18n.t("tasks.row.completed")
              : i18n.t("tasks.row.notCompleted")
        }
        title={task.oversized === true ? i18n.t("tasks.row.tooLongToWrite") : undefined}
        tabIndex={disabled ? -1 : 0}
        style={boxStyle(task.completed, disabled)}
        data-testid={`${testIdPrefix}.checkbox`}
        onClick={toggle}
        onKeyDown={onBoxKey}
      />

      {twoLine ? (
        <span style={STACK_STYLE} data-testid={`${testIdPrefix}.stack`}>
          <span
            style={{ ...textStyle(task.completed), flex: "0 1 auto" }}
            data-testid={`${testIdPrefix}.text`}
          >
            {task.text === "" ? i18n.t("tasks.row.untitled") : task.text}
          </span>
          <span style={SECOND_LINE_STYLE} data-testid={`${testIdPrefix}.meta`}>
            {meta}
          </span>
        </span>
      ) : (
        <>
          <span style={textStyle(task.completed)} data-testid={`${testIdPrefix}.text`}>
            {task.text === "" ? i18n.t("tasks.row.untitled") : task.text}
          </span>
          <span style={META_STYLE} data-testid={`${testIdPrefix}.meta`}>
            {meta}
          </span>
        </>
      )}
    </div>
  );
}

