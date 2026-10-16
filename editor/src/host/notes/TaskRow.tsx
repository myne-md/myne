// The shared task row (MYND-616, task 1).
//
// ONE row component for every task surface: the vault-wide tab, the note-scoped
// right-panel tab, and - later - the query block. It lives in the **shared
// package from day one** rather than in the desktop tree, because the mobile
// surfaces consume it too and moving it afterwards would break two repositories
// in the same change.
//
// It **reuses `taskChipToken`** rather than restating a chip look, so a row in a
// list and a chip inside a note cannot drift apart. That token module was
// written for exactly this consumer and already exports `taskChipStyle()`.
//
// SCOPE, not caller identity. The row takes `scope` and decides for itself what
// context to show - the source note is redundant in a note-scoped panel and
// essential in a vault-wide list. Branching on "who mounted me" would put that
// knowledge in three places and let them disagree; a parameter keeps it here.
//
// Canon rules that are constraints, not preferences:
//   - **no green check, anywhere**. A completed row is expressed by a filled
//     box and struck-through text, never a tick glyph;
//   - **completion is the one ruled exception to state-never-by-fill** in this
//     panel: the box and the strike are ACCENT (`docs/design/README.md`
//     "Task completion", `design-notes/ui/0587`). Everywhere else — the date
//     chip's overdue ink, the editor's inline affordances — state stays text,
//     never a pill;
//   - the row is quiet: this is a list of work, not a scoreboard.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import i18n from "@myne/editor/i18n";
import { TASK_CHIP_TOKEN, taskChipStyle } from "./taskChipToken";
import { taskChipIcon, type ChipIconKind } from "./taskChipIcon";
import "./task-row.css";
import { formatStoredValue } from "../lib/datetimeFormat";
import { useDateTimeDisplay } from "../lib/useDateTimeDisplay";

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
  /** The task's text - marker and fields already stripped (`taskDescription`). */
  text: string;
  completed: boolean;
  /**
   * How far to indent this row, relative to the rows on screen (myne-md/myne#656
   * item 7). `0`/absent is a top-level row. The panel computes it and promotes a
   * task whose parent is filtered out back to `0`; the row only renders it.
   */
  depth?: number;
  /** Source note title, or null for an untitled note. */
  noteTitle: string | null;
  due?: string;
  remind?: string;
  repeat?: string;
  priority?: string;
  /**
   * The record's raw line was truncated, so it cannot be written (MYND-612
   * task 5). The row still renders - dropping it would make the task vanish -
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
  /** Tighter horizontal padding, for the narrow note-scoped panel
   *  (myne-md/myne#656 review). */
  compactX?: boolean;
  /**
   * Roomier checkbox (22px instead of 14) for touch surfaces. The phone's
   * task list is the same shared row, and a 14px box with an invisible
   * expander still reads as "tap exactly here" while its expanded area is
   * clipped by the windowed list's overflow. A visibly bigger box is honest
   * about where to tap. Desktop keeps the dense 14.
   */
  roomyBox?: boolean;
  /**
   * Render the date under the text as an accent icon + label instead of the
   * right-hand chip, for the narrow note-scoped panel (myne-md/myne#656 review).
   */
  inlineDate?: boolean;
  /**
   * Open the field editor for this task, anchored to the control that was
   * activated (myne-md/myne#884 task 8). Absent → no trailing control, which is
   * what a read-only mount and a client with no field write get.
   *
   * The CONTROL is passed as well as the task because the surface is anchored to
   * it: an anchored popover has to point at the thing the user pressed, and
   * `TaskRowData` is a projection without the raw line a write needs, so the
   * caller closes over its own record either way.
   */
  onEditFields?: (task: TaskRowData, control: HTMLElement) => void;
};

/** The chip's leading Lucide glyph, as a React element. `value` carries the
 *  LEVEL for `priority`, whose shapes distinguish highest from lowest without
 *  colour. */
function ChipGlyph({
  kind,
  value = "",
}: {
  kind: ChipIconKind;
  value?: string;
}): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el !== null) el.replaceChildren(taskChipIcon(kind, value));
  }, [kind, value]);
  return (
    <span
      ref={ref}
      style={{ display: "inline-flex", width: 12, height: 12, flex: "0 0 auto" }}
      aria-hidden="true"
    />
  );
}

/**
 * The date the row files this task under: the due date, **falling back to the
 * reminder**.
 *
 * A task carrying only a reminder would otherwise read as undated and drop out
 * of every dated view - which is the case `remind` being absolute exists to
 * support ("remind me Tuesday to call my mother"). The same axis is used by the
 * filter predicates; this function is display-side only and does not define it.
 *
 * Normalizes here rather than at each consumer. `TaskRowData` promises
 * optional-or-absent, but the `MYI1` row serializes `Option<String>` as `null`,
 * so a client whose boundary skipped the `taskWire.ts` decoder hands one down -
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
 * needs no date library - the shape is fixed normatively by
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
  alignItems: "center",
  gap: "var(--space-2)",
  // NO fixed height here: the windowed list wraps each row in a fixed-height
  // box that centres it, while the note-scoped panel renders rows in flow with
  // their natural (two-line) height (myne-md/myne#656 review).
  width: "100%",
  boxSizing: "border-box",
  padding: "var(--space-1) 8px",
  borderRadius: "var(--radius-2, 6px)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.45,
  color: "var(--fg-1)",
};

const BOX_BASE: CSSProperties = {
  flex: "0 0 auto",
  width: 14,
  height: 14,
  borderRadius: "var(--radius-1)",
  border: "1px solid var(--line-2, var(--line-1))",
  background: "transparent",
  padding: 0,
  cursor: "pointer",
};

/** The touch size matches the mobile `Checkbox` primitive (22px), so a task
 *  box and a settings checkbox read as the same control. */
const ROOMY_BOX = 22;

function boxStyle(completed: boolean, disabled: boolean, roomy: boolean): CSSProperties {
  return {
    ...BOX_BASE,
    ...(roomy ? { width: ROOMY_BOX, height: ROOMY_BOX } : {}),
    // A completed box is FILLED, not ticked - the canon forbids a green check.
    // The fill is the ACCENT (myne-md/myne#656, decided in the panel grill),
    // which is the one place completion is allowed to read as state; the editor
    // keeps its neutral inline treatment.
    background: completed ? "var(--accent)" : "transparent",
    borderColor: completed ? "var(--accent)" : "var(--line-2, var(--line-1))",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}

/**
 * The row's box, indented by nesting depth. The base padding lives in
 * `ROW_STYLE`; this only overrides the leading edge, so depth 0 is byte-identical
 * to the flat row and only nested rows move. The step is a spacing token, so a
 * theme that re-scales the scale re-scales the tree with it.
 */
function rowStyle(depth: number, compactX: boolean): CSSProperties {
  const start = compactX ? "var(--space-1)" : "var(--space-2)";
  const base = compactX
    ? { ...ROW_STYLE, padding: `0 ${start}` }
    : ROW_STYLE;
  if (depth <= 0) return base;
  return {
    ...base,
    paddingInlineStart: `calc(${start} + var(--space-4) * ${depth})`,
  };
}

function textStyle(completed: boolean): CSSProperties {
  return {
    flex: "1 1 auto",
    minWidth: 0,
    // One line, ellipsis: the windowed list has a FIXED row height, so wrapping
    // would break the offset maths. The full text is on the `title` attr.
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    textDecoration: completed ? "line-through" : "none",
    // Completion is the one state this panel renders in accent (myne-md/myne#656).
    color: completed ? "var(--accent)" : "var(--fg-1)",
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
 *  single-line meta block - a right-aligned second line reads as a separate
 *  column rather than as this row's own detail. */
const SECOND_LINE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  minWidth: 0,
};

const INLINE_DATE_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  color: "var(--accent)",
  fontSize: "var(--text-xs)",
};

const META_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flex: "0 0 auto",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

/**
 * An icon-only field mark beside the date (myne-md/myne#884 task 6).
 *
 * **A mark, not a chip**: no background, no border, no pill. The canon carries
 * state as a mark or as text and reserves the fill for completion, and a row is a
 * list of work rather than a scoreboard. Nothing but the glyph's own colour is
 * set, and that comes from a token, so a theme repaints it like everything else.
 *
 * The glyph is `taskChipIcon`, the same source the note's own field chips and the
 * field menu draw from, so one priority level has one shape in all three places.
 * That matters most for `priority`, whose five levels are shapes (two chevrons up
 * through two down) rather than colours, which is what survives a monochrome or
 * colour-blind reading.
 */
const MARK_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  color: "var(--fg-2)",
  flex: "0 0 auto",
};

/**
 * The trailing field control (myne-md/myne#884 task 8): the row's way into the
 * field editor for a task whose note is not open. A bare glyph, no border and no
 * fill, because the row is a list of work and this is its third affordance.
 */
const FIELDS_BUTTON_STYLE: CSSProperties = {
  flex: "0 0 auto",
  width: 24,
  height: 24,
  padding: 0,
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "var(--fg-3)",
  fontFamily: "inherit",
  fontSize: "var(--text-lg)",
  lineHeight: 1,
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
  compactX = false,
  inlineDate = false,
  roomyBox = false,
  onEditFields,
}: TaskRowProps): ReactElement {
  const stacked = twoLine || inlineDate;
  const overdue = isOverdue(task, today);
  // myne#279: the row used to render the raw stored string, which meant a raw
  // ISO date and a time that was silently dropped by the `[0,10]` slice on the
  // way in. It now goes through the one shared formatter, so the user's chosen
  // format applies and a task written for 09:00 says so.
  const display = useDateTimeDisplay();
  const raw = rowDate(task);
  const date = raw === undefined ? undefined : formatStoredValue(raw, display);
  const depth = task.depth ?? 0;
  const [hover, setHover] = useState(false);
  const disabled = task.oversized === true || onToggle === undefined;

  const toggle = (): void => {
    if (disabled) return;
    onToggle?.(task);
  };
  const onBoxKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    // The row itself opens on Enter/Space: without this, a keyboard toggle
    // would bubble up and fire onOpen as well (myne-md/myne#656 review).
    e.stopPropagation();
    toggle();
  };

  // Built ONCE and arranged by whichever layout is active. Building the chips
  // per layout would let the two diverge on which pieces they show, which is
  // exactly the drift one shared component exists to prevent.
  const meta = (
    <>
      {/* Field marks, beside the date (myne-md/myne#884 task 6). Nothing renders
          for a field the record does not carry: an empty glyph would claim a
          value the line does not have. */}
      {task.priority == null ? null : (
        <span
          style={MARK_STYLE}
          role="img"
          // The field's name plus what the mark shows, the shape the note's own
          // chip announces with. Literal keys so `check-i18n.mjs` sees them
          // (`decorations/task-chip.ts`'s FIELD_NAME records why). The value half
          // is the STORED bytes: the chip localizes a recurrence rule through
          // `recurrenceLabel`, and this row does not import a decoration-layer
          // module to do the same.
          aria-label={`${i18n.t("editor.taskField.title.priority")}, ${task.priority}`}
          data-testid={`${testIdPrefix}.priority`}
        >
          <ChipGlyph kind="priority" value={task.priority} />
        </span>
      )}
      {task.repeat == null ? null : (
        <span
          style={MARK_STYLE}
          role="img"
          aria-label={`${i18n.t("editor.taskField.title.repeat")}, ${task.repeat}`}
          data-testid={`${testIdPrefix}.repeat`}
        >
          <ChipGlyph kind="repeat" />
        </span>
      )}

      {date === undefined ? null : inlineDate ? (
        // Inline date (note-scoped panel): accent icon + text, no pill.
        <span
          style={INLINE_DATE_STYLE}
          data-testid={`${testIdPrefix}.due`}
          data-overdue={overdue ? "true" : undefined}
        >
          <ChipGlyph kind={task.due != null ? "due" : "remind"} />
          {date}
        </span>
      ) : (
        <span
          style={{
            ...taskChipStyle(),
            // State as coloured TEXT, never as a fill - the canon's rule, and
            // the reason this chip's background stays neutral while overdue.
            color: overdue ? "var(--danger)" : TASK_CHIP_TOKEN.ink,
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
          onClick={(e) => {
            e.stopPropagation();
            onOpen?.(task);
          }}
          // A keyboard activation clicks the button AND bubbles its keydown to
          // the row, which would fire onOpen a second time (myne-md/myne#656
          // review). The click already opens; the bubble must not.
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          title={task.noteTitle}
        >
          {task.noteTitle}
        </button>
      )}
    </>
  );

  return (
    <div
      style={{
        ...rowStyle(depth, compactX),
        // A clearly visible hover: the row is a navigation target, and a
        // pointer alone was not enough to read (myne-md/myne#656 review).
        background: hover ? "var(--paper-3)" : "transparent",
        // A two-line row aligns its checkbox with the FIRST line, not the
        // block's vertical centre (myne-md/myne#656 review).
        alignItems: stacked ? "flex-start" : "center",
        // The whole row is the navigation target when the caller can open the
        // task (myne-md/myne#656 review).
        cursor: onOpen === undefined ? "default" : "pointer",
      }}
      data-testid={`${testIdPrefix}.row`}
      data-task-scope={scope}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...(onOpen === undefined
        ? {}
        : {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => onOpen(task),
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                // Inner controls (checkbox, note button) stop their own
                // keydowns; this guard is the second half, for any control
                // that does not (myne-md/myne#656 review).
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                onOpen(task);
              }
            },
          })}
      {...(depth > 0 ? { "data-depth": String(depth) } : {})}
    >
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
        // myne#284: the class carries a touch-only hit-area expander. The box
        // stays 14×14 visually - the density is the point of this row - while
        // a coarse pointer gets the 44×44 the platform minimums ask for.
        className="myne-task-checkbox"
        style={{ ...boxStyle(task.completed, disabled, roomyBox), ...(stacked ? { marginTop: 3 } : {}) }}
        data-testid={`${testIdPrefix}.checkbox`}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={onBoxKey}
      />

      {stacked ? (
        <span style={STACK_STYLE} data-testid={`${testIdPrefix}.stack`}>
          <span
            style={{
              ...textStyle(task.completed),
              flex: "0 1 auto",
              // The two-line layout exists to WRAP rather than truncate; the
              // single-line one is the fixed-height windowed row.
              whiteSpace: "normal",
              overflow: "visible",
              textOverflow: "clip",
              overflowWrap: "anywhere",
            }}
            data-testid={`${testIdPrefix}.text`}
            title={task.text === "" ? undefined : task.text}
          >
            {task.text === "" ? i18n.t("tasks.row.untitled") : task.text}
          </span>
          <span style={SECOND_LINE_STYLE} data-testid={`${testIdPrefix}.meta`}>
            {meta}
          </span>
        </span>
      ) : (
        <>
          <span
            style={textStyle(task.completed)}
            data-testid={`${testIdPrefix}.text`}
            title={task.text === "" ? undefined : task.text}
          >
            {task.text === "" ? i18n.t("tasks.row.untitled") : task.text}
          </span>
          <span style={META_STYLE} data-testid={`${testIdPrefix}.meta`}>
            {meta}
          </span>
        </>
      )}

      {onEditFields === undefined ? null : (
        <button
          type="button"
          className="myne-task-fields"
          style={FIELDS_BUTTON_STYLE}
          data-testid={`${testIdPrefix}.fields`}
          aria-label={i18n.t("tasks.row.editFields")}
          // No native `title`: the sheet's own controls carry an aria-label and
          // nothing else, and `check-tooltip-convention.mjs` counts a native
          // title on an interactive element as drift (the editor has no Tooltip
          // primitive to use instead - that one lives in the desktop tree).
          // The row is a navigation target, and so is the checkbox and the source
          // note. This control stops its own events for the same reason they do:
          // opening the field editor must not also open the note.
          onClick={(e) => {
            e.stopPropagation();
            onEditFields(task, e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
        >
          {"\u22ef"}
        </button>
      )}
    </div>
  );
}

