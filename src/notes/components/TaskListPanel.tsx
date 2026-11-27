// The task list body (MYND-616, redesigned for myne-md/myne#656).
//
// ONE body for both surfaces. The vault-wide tab and the note-scoped right-panel
// tab differ by the `rowScope` prop and by which task list they are handed.
//
// **Toolbar, as revised after review:** a long search field with a `Filters`
// button. The button opens a TWO-PANE builder that starts CLOSED (only the axis
// list) and reveals an axis's values on click, with hover feedback everywhere.
// Filters in force show as removable accent chips under the search, with a
// `Clear all` at the end of the row; the builder carries its own `Clear all` in
// a header at the top and a per-axis reset beside each applied value. The
// note-scoped panel passes `minimal` and gets just the search field. Section
// headers scroll with their rows.
//
// The list is hand-rolled WINDOWED (a vault can hold thousands of tasks), with
// fixed-height rows.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { TaskRow, type TaskRowData, type TaskRowScope } from "@myne/editor/host/notes/TaskRow";
import { Icon } from "../../components/primitives/Icon";
import { usePressSurface } from "../../components/primitives/pressSurface";
import type { InteractiveSurfaceHandlers } from "../../components/primitives/interactiveSurface";
import { taskDescription } from "../../dialect/taskFieldWriter";
import {
  DEFAULT_TASK_VIEW,
  distinctFolders,
  distinctTags,
  partitionTasks,
  type TaskDueFilter,
  type TaskPriorityFilter,
  type TaskSort,
  type TaskStatusFilter,
  type TaskView,
} from "../taskView";
import { folderInScope } from "../taskScope";
import { visibleDepths } from "../taskTree";
import { readTaskField, rewriteTaskField, taskRowKey } from "../taskWriteCore";
import type { TaskFieldKind } from "../taskWriteCore";
import { openTaskFieldMenu } from "@myne/editor/task-field-menu";
import { TASK_ROW_HEIGHT, computeTaskWindow, flattenTaskList } from "../taskWindowing";
import type { VaultTask } from "../taskIndex";
import { MIN_TARGET } from "../../components/primitives/targetSize";

export type TaskListPanelProps = {
  tasks: readonly VaultTask[];
  view: TaskView;
  today: string;
  rowScope: TaskRowScope;
  /** Show the source-note column on every row. Off for a phone-width surface: the
   *  windowed list owns a fixed row height, so a row can only be made roomier by
   *  dropping a column, not by wrapping. */
  showNoteTitle?: boolean;
  /** Host the filter builder in the caller's own surface instead of the
   *  tooltip-style popover. Mobile passes a bottom-sheet renderer: the popover
   *  is a pointer affordance and reads as a stray dropdown on a phone. */
  filterSheet?: (args: {
    view: TaskView;
    onViewChange: (next: TaskView) => void;
    onClose: () => void;
    folderOptions: readonly string[];
    noteOptions: readonly (readonly [string, string])[];
    tagOptions: readonly string[];
    testIdPrefix: string;
  }) => React.ReactNode;
  tagsOf?: (noteId: string) => readonly string[];
  rebuilding?: boolean;
  onViewChange: (next: TaskView) => void;
  onToggle?: (task: VaultTask) => void;
  onOpen?: (task: VaultTask) => void;
  testIdPrefix?: string;
  /** Strip the toolbar to a single search field (the note-scoped panel). */
  minimal?: boolean;
  /** Roomier row checkboxes for touch surfaces; desktop keeps the dense box. */
  roomyBox?: boolean;
  /**
   * Write one inline field on a task's line (myne-md/myne#884 task 8). Absent →
   * no row control, which is what a client with no field write gets.
   *
   * Injected rather than imported, exactly like `onToggle`: the panel is shared
   * by two clients whose IO differs, and neither of them may reach for the
   * other's.
   */
  onWriteField?: (task: VaultTask, kind: TaskFieldKind, value: string) => Promise<void>;
};

const NO_TAGS: readonly string[] = [];
const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;

/** Menu order, and the roster `present()` is computed over. */
const FIELD_KINDS: readonly TaskFieldKind[] = ["due", "remind", "repeat", "priority"];

/** The description as a READER sees it, not as the file spells it.
 *
 *  A task line is markdown, so it can carry `[[Writing with Markdown]]`, an
 *  `![[att:…|diagram.png]]` embed or a `[label](url)` link. The row is a list of
 *  sentences, not a source view: printing the delimiters is the phone showing
 *  the note's bytes instead of its meaning, which is what the seeded vault did
 *  on the Tasks screen (owner, 2026-11-27: "Read [[Writing with Markdown]]").
 *
 *  Display-only by construction: the row's field controls write through
 *  `onWriteField`, which is given the TASK, never this string, so nothing here
 *  can reach the file. `taskRowKey` keys off the raw line, so a display
 *  transformation cannot re-key a row either. */
function displayTaskText(line: string): string {
  const target = (raw: string): string => raw.split("/").pop() ?? raw;
  return taskDescription(line)
    // Embeds first: `![[…]]` would otherwise be matched by the plain rule and
    // leave its `!` behind.
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, alias?: string) => alias ?? target(t))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, alias?: string) => alias ?? target(t))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function toRowData(task: VaultTask, depth: number): TaskRowData {
  return {
    key: taskRowKey(task),
    text: task.lineIndex === null ? (task.noteTitle ?? "") : displayTaskText(task.rawLine),
    completed: task.completed,
    noteTitle: task.noteTitle,
    ...(depth > 0 ? { depth } : {}),
    ...(task.due == null ? {} : { due: task.due }),
    ...(task.remind == null ? {} : { remind: task.remind }),
    ...(task.repeat == null ? {} : { repeat: task.repeat }),
    ...(task.priority == null ? {} : { priority: task.priority }),
    ...(task.oversized ? { oversized: true } : {}),
  };
}

/** Inline styles cannot express `:hover` or press, so each interactive row owns
 *  its flags and folds them into the fill it computes. The press half comes from
 *  `usePressSurface`, which owns the press step and its value; this helper only
 *  names the pair for a row and merges the two handler sets. */
function useHover(): {
  hover: boolean;
  pressed: boolean;
  pressBg: string;
  handlers: InteractiveSurfaceHandlers;
} {
  const [hover, setHover] = useState(false);
  const { pressed, pressBg, handlers: pressHandlers } = usePressSurface();
  return {
    hover,
    pressed,
    pressBg,
    handlers: {
      ...pressHandlers,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
  };
}

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

const TOOLBAR_STYLE: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-3)",
};

// The note-scoped panel is narrow; its horizontal padding is a third of the
// vault panel's (myne-md/myne#656 review).
const MINIMAL_TOOLBAR_STYLE: CSSProperties = {
  ...TOOLBAR_STYLE,
  padding: "var(--space-2) var(--space-1)",
};

// The rule under the toolbar spans the CONTENT width, so it lines up with the
// search field rather than the panel edges (myne-md/myne#656 review).
const SEPARATOR_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
};

const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

const SEARCH_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const FILTERS_BUTTON_STYLE: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper)",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  cursor: "pointer",
};

const FILTERS_BUTTON_HOVER_STYLE: CSSProperties = {
  ...FILTERS_BUTTON_STYLE,
  background: "var(--paper-2)",
  color: "var(--fg-1)",
};

const FILTERS_COUNT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontVariantNumeric: "tabular-nums",
};

const CHIPS_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-1)",
};

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "2px 8px",
  border: "1px solid var(--accent-soft)",
  borderRadius: "var(--radius-pill)",
  background: "var(--accent-soft)",
  color: "var(--accent)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
};

const CHIP_HOVER_STYLE: CSSProperties = {
  ...CHIP_STYLE,
  border: "1px solid var(--accent)",
};

const INLINE_CLEAR_STYLE: CSSProperties = {
  marginLeft: "var(--space-1)",
  padding: 0,
  border: "none",
  background: "none",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  cursor: "pointer",
  textDecoration: "underline",
};

const INLINE_CLEAR_HOVER_STYLE: CSSProperties = {
  ...INLINE_CLEAR_STYLE,
  color: "var(--danger)",
};

const BUILDER_BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: "0",
  zIndex: 40,
};

// An OVERLAY anchored to the toolbar (right-aligned), not a flow child: opening
// the builder must not push the list down (myne-md/myne#656 review). Anchoring
// to the full-width toolbar and capping the width at the pane keeps it on
// screen, which anchoring to the narrow button did not.
const BUILDER_STYLE: CSSProperties = {
  position: "absolute",
  top: "100%",
  right: "var(--space-3)",
  zIndex: 41,
  display: "flex",
  flexDirection: "column",
  width: "min(calc(100% - var(--space-6)), 420px)",
  boxSizing: "border-box",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper)",
  overflow: "hidden",
};

const BUILDER_HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
};

const BUILDER_TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
};

const BUILDER_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "row",
};

const BUILDER_LEFT_STYLE: CSSProperties = {
  flex: "0 0 168px",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  borderRight: "1px solid var(--line-1)",
  background: "var(--paper-2)",
};

const BUILDER_LEFT_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
};

const BUILDER_LEFT_ITEM_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-2)",
  border: "none",
  borderRadius: "var(--radius-2)",
  background: "transparent",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  textAlign: "left",
  cursor: "pointer",
};

const BUILDER_LEFT_ITEM_HOVER_STYLE: CSSProperties = {
  ...BUILDER_LEFT_ITEM_STYLE,
  background: "var(--paper-3)",
};

const BUILDER_LEFT_ITEM_ACTIVE_STYLE: CSSProperties = {
  ...BUILDER_LEFT_ITEM_STYLE,
  background: "var(--paper)",
  color: "var(--fg-1)",
};

const BUILDER_APPLIED_STYLE: CSSProperties = {
  color: "var(--accent)",
  fontSize: "var(--text-xs)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
};

const RESET_X_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  ...MIN_TARGET,
  padding: 0,
  border: "none",
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
};

const RESET_X_HOVER_STYLE: CSSProperties = {
  ...RESET_X_STYLE,
  color: "var(--danger)",
  background: "var(--paper-3)",
};

const BUILDER_RIGHT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  padding: "var(--space-2)",
  maxHeight: 300,
  overflowY: "auto",
};

const BUILDER_EMPTY_STYLE: CSSProperties = {
  flex: "1 1 auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-2)",
  padding: "var(--space-5) var(--space-3)",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  textAlign: "center",
};

const BUILDER_RIGHT_TITLE_STYLE: CSSProperties = {
  padding: "0 var(--space-2) var(--space-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const BUILDER_VALUE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  padding: "var(--space-2) var(--space-2)",
  border: "none",
  borderRadius: "var(--radius-2)",
  background: "transparent",
  color: "var(--fg-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  textAlign: "left",
  cursor: "pointer",
};

const BUILDER_VALUE_HOVER_STYLE: CSSProperties = {
  ...BUILDER_VALUE_STYLE,
  background: "var(--paper-2)",
  color: "var(--fg-1)",
};

const BUILDER_VALUE_ACTIVE_STYLE: CSSProperties = {
  ...BUILDER_VALUE_STYLE,
  background: "var(--paper-3)",
  color: "var(--fg-1)",
  fontWeight: "var(--weight-medium)",
};

const BUILDER_VALUE_LABEL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const SCROLL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  height: "100%",
  overflowY: "auto",
  position: "relative",
};

/**
 * A section heading, and it paints **no ground of its own** (myne-md/myne#867).
 *
 * It used to fill with `--paper`, the LIGHTEST stop of the surface ramp, while
 * the panel it sits in is on a darker one. That floor is right for a FIELD (
 * `SEARCH_STYLE` and `FILTERS_BUTTON_STYLE` below are `--paper` on purpose,
 * because an input reads as inset into its panel) and wrong for a heading,
 * because a full-width opaque band is not inset into anything: it reads as a
 * surface belonging to something else, so "No date" looked like a different
 * panel had been spliced into the Tasks view. It was also the only thing in that
 * panel painting a surface of its own.
 *
 * The separation a heading needs is a hairline, which is what the canon asks for
 * a divider. It follows that the fix holds in every theme by construction rather
 * than by three measurements: with no fill declared, the heading shows whatever
 * ground the theme gives the panel behind it.
 */
const HEADER_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  boxSizing: "border-box",
  height: TASK_ROW_HEIGHT - 2,
  // Same gutter var as the rows, so headings and rows share one edge.
  padding: "0 calc(8px + var(--task-row-gutter, 0px))",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--fg-2)",
  borderBottom: "1px solid var(--line-1)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const HEADER_COUNT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 500,
};

const ROW_WRAP_STYLE: CSSProperties = {
  height: TASK_ROW_HEIGHT,
  boxSizing: "border-box",
  overflow: "hidden",
  // The row no longer carries `height: 100%`, so the fixed-height window box
  // centres it (myne-md/myne#656 review).
  display: "flex",
  alignItems: "center",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  textAlign: "center",
};

/** A removable applied-filter chip; only the remove glyph turns red on hover. */
function FilterChip({
  label,
  testId,
  onRemove,
}: {
  label: string;
  testId: string;
  onRemove: () => void;
}): ReactElement {
  const { hover, pressed, pressBg, handlers } = useHover();
  return (
    <button
      type="button"
      style={pressed ? { ...CHIP_STYLE, background: pressBg } : hover ? CHIP_HOVER_STYLE : CHIP_STYLE}
      data-testid={testId}
      {...handlers}
      onClick={onRemove}
    >
      {label}
      <span style={{ display: "inline-flex", color: hover ? "var(--danger)" : "inherit" }}>
        <Icon name="x" size={12} />
      </span>
    </button>
  );
}

type BuilderSection = "status" | "due" | "folder" | "note" | "tag" | "priority" | "sort";
const BUILDER_SECTIONS: readonly BuilderSection[] = [
  "status",
  "due",
  "folder",
  "note",
  "tag",
  "priority",
  "sort",
];

function BuilderLeftRow({
  label,
  applied,
  active,
  onSelect,
  onReset,
  testId,
}: {
  label: string;
  applied: string | null;
  active: boolean;
  onSelect: () => void;
  onReset: () => void;
  testId: string;
}): ReactElement {
  const { hover, pressed, pressBg, handlers } = useHover();
  const { hover: resetHover, handlers: resetHandlers } = useHover();
  return (
    <div style={BUILDER_LEFT_ROW_STYLE}>
      <button
        type="button"
        style={
          pressed
            ? { ...BUILDER_LEFT_ITEM_STYLE, background: pressBg }
            : active
              ? BUILDER_LEFT_ITEM_ACTIVE_STYLE
              : hover
                ? BUILDER_LEFT_ITEM_HOVER_STYLE
                : BUILDER_LEFT_ITEM_STYLE
        }
        {...handlers}
        aria-expanded={active}
        data-testid={testId}
        onClick={onSelect}
      >
        <span>{label}</span>
        {applied === null ? null : (
          <span style={BUILDER_APPLIED_STYLE} data-testid={`${testId}-applied`}>
            {applied}
          </span>
        )}
      </button>
      {applied === null ? null : (
        <button
          type="button"
          style={resetHover ? RESET_X_HOVER_STYLE : RESET_X_STYLE}
          {...resetHandlers}
          aria-label={`Clear ${label}`}
          data-testid={`${testId}-reset`}
          onClick={onReset}
        >
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
}

function BuilderValueRow({
  label,
  active,
  onSelect,
  testId,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  testId: string;
}): ReactElement {
  const { hover, pressed, pressBg, handlers } = useHover();
  return (
    <button
      type="button"
        style={pressed ? { ...BUILDER_VALUE_STYLE, background: pressBg } : active ? BUILDER_VALUE_ACTIVE_STYLE : hover ? BUILDER_VALUE_HOVER_STYLE : BUILDER_VALUE_STYLE}
      {...handlers}
      aria-checked={active}
      role="menuitemradio"
      data-testid={testId}
      onClick={onSelect}
    >
      <Icon
        name="check"
        size={14}
        style={{ flex: "0 0 auto", color: "var(--accent)", opacity: active ? 1 : 0 }}
      />
      <span style={BUILDER_VALUE_LABEL_STYLE}>{label}</span>
    </button>
  );
}

/**
 * The two-pane filter builder. It opens with only the axis list; clicking an
 * axis reveals its values on the right. The header carries `Clear all`, and each
 * applied axis has its own reset beside it.
 *
 * Keyboard contract (myne-md/myne#656 review): the panel takes focus on open,
 * Escape closes it, and focus returns to the Filters button that opened it.
 * It is an inline non-modal builder (no focus trap): Tab may leave it, and
 * Escape is the keyboard close.
 */
export function TaskFilterBuilder({
  view,
  onViewChange,
  onClose,
  folderOptions,
  noteOptions,
  tagOptions,
  testIdPrefix,
}: {
  view: TaskView;
  onViewChange: (next: TaskView) => void;
  onClose: () => void;
  folderOptions: readonly string[];
  noteOptions: readonly (readonly [string, string])[];
  tagOptions: readonly string[];
  testIdPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  // Starts CLOSED: no axis is chosen until the user clicks one.
  const [section, setSection] = useState<BuilderSection | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus into the panel on open, and close on Escape (myne-md/myne#656
  // review). The caller returns focus to the Filters button.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = dialogRef.current;
    if (el === null) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { hover: clearHover, handlers: clearHandlers } = useHover();
  const setView = (patch: Partial<TaskView>): void => onViewChange({ ...view, ...patch });

  const axisLabel: Record<BuilderSection, string> = {
    status: t("tasks.axis.status"),
    due: t("tasks.axis.due"),
    folder: t("tasks.axis.folder"),
    note: t("tasks.axis.note"),
    tag: t("tasks.axis.tag"),
    priority: t("common.priority"),
    sort: t("tasks.axis.sort"),
  };

  const currentValue = (s: BuilderSection): string => {
    switch (s) {
      case "status":
        return view.status;
      case "due":
        return view.due;
      case "folder":
        return "";
      case "note":
        return view.noteId ?? "";
      case "tag":
        return "";
      case "priority":
        return view.priority;
      case "sort":
        return view.sort;
    }
  };

  /** Whether a value row reads as checked - membership for multi axes. */
  const isActive = (s: BuilderSection, value: string): boolean => {
    if (s === "folder") return value === "" ? view.folders.length === 0 : view.folders.includes(value);
    if (s === "tag") return value === "" ? view.tags.length === 0 : view.tags.includes(value);
    return value === currentValue(s);
  };

  const appliedLabel = (s: BuilderSection): string | null => {
    // Multi-select axes show the FIRST value plus a "+N" count, so the fixed
    // left column never widens or wraps (myne-md/myne#656 review).
    const multi = (list: readonly string[]): string | null =>
      list.length === 0 ? null : list.length === 1 ? list[0]! : `${list[0]!} +${list.length - 1}`;
    if (s === "folder") return multi(view.folders);
    if (s === "tag") return multi(view.tags);
    const v = currentValue(s);
    switch (s) {
      case "status":
        return v === DEFAULT_TASK_VIEW.status ? null : t(`tasks.status.${v}`);
      case "due":
        return v === "any" ? null : t(`tasks.due.${v}`);
      case "note":
        return v === "" ? null : (noteOptions.find(([id]) => id === v)?.[1] ?? null);
      case "priority":
        return v === "any" ? null : t(`tasks.priority.${v}`);
      case "sort":
        return v === "due" ? null : t(`tasks.sort.${v}`);
    }
  };

  const clearAxis = (s: BuilderSection): void => {
    switch (s) {
      case "status":
        setView({ status: DEFAULT_TASK_VIEW.status });
        break;
      case "due":
        setView({ due: "any" });
        break;
      case "folder":
        setView({ folders: [] });
        break;
      case "note":
        setView({ noteId: null });
        break;
      case "tag":
        setView({ tags: [] });
        break;
      case "priority":
        setView({ priority: "any" });
        break;
      case "sort":
        setView({ sort: "due" });
        break;
    }
  };

  const valuesFor = (s: BuilderSection): { value: string; label: string }[] => {
    switch (s) {
      case "status":
        return [
          { value: "undone", label: t("tasks.status.undone") },
          { value: "all", label: t("tasks.status.all") },
          { value: "done", label: t("common.done") },
        ];
      case "due":
        return [
          { value: "any", label: t("tasks.due.any") },
          { value: "overdue", label: t("tasks.due.overdue") },
          { value: "today", label: t("common.today") },
          { value: "upcoming", label: t("tasks.due.upcoming") },
          { value: "later", label: t("tasks.due.later") },
          { value: "none", label: t("common.nodate") },
        ];
      case "folder":
        return [
          { value: "", label: t("tasks.view.allFolders") },
          ...folderOptions.map((f) => ({ value: f, label: f })),
        ];
      case "note":
        return [
          { value: "", label: t("common.allnotes") },
          ...noteOptions.map(([id, title]) => ({ value: id, label: title })),
        ];
      case "tag":
        return [
          { value: "", label: t("tasks.view.anyTag") },
          ...tagOptions.map((tag) => ({ value: tag, label: tag })),
        ];
      case "priority":
        return [
          { value: "any", label: t("tasks.view.anyPriority") },
          ...PRIORITIES.map((p) => ({ value: p, label: t(`tasks.priority.${p}`) })),
        ];
      case "sort":
        return [
          { value: "due", label: t("common.duedate") },
          { value: "dueDesc", label: t("tasks.sort.dueDesc") },
          { value: "priority", label: t("common.priority") },
          { value: "note", label: t("tasks.sort.note") },
        ];
    }
  };

  const choose = (s: BuilderSection, value: string): void => {
    switch (s) {
      case "status":
        setView({ status: value as TaskStatusFilter });
        break;
      case "due":
        setView({ due: value as TaskDueFilter });
        break;
      case "folder":
        setView({
          folders:
            value === ""
              ? []
              : view.folders.includes(value)
                ? view.folders.filter((f) => f !== value)
                : [...view.folders, value],
        });
        break;
      case "note":
        setView({ noteId: value === "" ? null : value });
        break;
      case "tag":
        setView({
          tags:
            value === ""
              ? []
              : view.tags.includes(value)
                ? view.tags.filter((x) => x !== value)
                : [...view.tags, value],
        });
        break;
      case "priority":
        setView({ priority: value as TaskPriorityFilter });
        break;
      case "sort":
        setView({ sort: value as TaskSort });
        break;
    }
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={BUILDER_STYLE}
      role="dialog"
      aria-label={t("tasks.filters.title")}
      data-testid={`${testIdPrefix}.filtersPanel`}
    >
      <div style={BUILDER_HEADER_STYLE}>
        <span style={BUILDER_TITLE_STYLE}>{t("tasks.filters.title")}</span>
        <button
          type="button"
          style={clearHover ? INLINE_CLEAR_HOVER_STYLE : INLINE_CLEAR_STYLE}
          {...clearHandlers}
          data-testid={`${testIdPrefix}.clearFiltersBuilder`}
          onClick={() => onViewChange(DEFAULT_TASK_VIEW)}
        >
          {t("tasks.filters.clearAll")}
        </button>
      </div>
      <div style={BUILDER_BODY_STYLE}>
        <div style={BUILDER_LEFT_STYLE}>
          {BUILDER_SECTIONS.map((s) => (
            <BuilderLeftRow
              key={s}
              label={axisLabel[s]}
              applied={appliedLabel(s)}
              active={s === section}
              testId={`${testIdPrefix}.builderTab.${s}`}
              onSelect={() => setSection(s)}
              onReset={() => clearAxis(s)}
            />
          ))}
        </div>
        <div style={BUILDER_RIGHT_STYLE} data-testid={`${testIdPrefix}.filtersValues`}>
          {section === null ? (
            <div style={BUILDER_EMPTY_STYLE} data-testid={`${testIdPrefix}.filtersHint`}>
              <Icon name="list" size={20} />
              <span>{t("tasks.filters.selectHint")}</span>
            </div>
          ) : (
            <>
              <span style={BUILDER_RIGHT_TITLE_STYLE}>{axisLabel[section]}</span>
              {valuesFor(section).map((opt) => (
                <BuilderValueRow
                  key={opt.value === "" ? "__any" : opt.value}
                  label={opt.label}
                  active={isActive(section, opt.value)}
                  testId={`${testIdPrefix}.builderOption.${section}.${opt.value === "" ? "any" : opt.value}`}
                  onSelect={() => choose(section, opt.value)}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskListPanel({
  tasks,
  view,
  today,
  rowScope,
  showNoteTitle = true,
  filterSheet,
  tagsOf,
  rebuilding = false,
  onViewChange,
  onToggle,
  onOpen,
  testIdPrefix = "tasks",
  minimal = false,
  roomyBox = false,
  onWriteField,
}: TaskListPanelProps): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [builderOpen, setBuilderOpen] = useState(false);
  const { hover: filtersHover, handlers: filtersHandlers } = useHover();
  const { hover: clearHover, handlers: clearHandlers } = useHover();
  const filtersButtonRef = useRef<HTMLButtonElement>(null);
  // Escape close returns focus to the button that opened the builder
  // (myne-md/myne#656 review); the backdrop path is a mouse close and moves
  // no focus.
  const closeBuilder = useCallback(() => {
    setBuilderOpen(false);
    filtersButtonRef.current?.focus();
  }, []);

  const sections = useMemo(
    () => partitionTasks(tasks, view, today, tagsOf ?? (() => NO_TAGS), search),
    [tasks, view, today, tagsOf, search],
  );

  const depths = useMemo(() => {
    const visible = new Set<string>();
    for (const section of sections) for (const task of section.tasks) visible.add(taskRowKey(task));
    return visibleDepths(tasks, visible);
  }, [tasks, sections]);

  const items = useMemo(() => flattenTaskList(sections, depths), [sections, depths]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  /**
   * Open the field menu for one row, in the presentation the client declared
   * (myne-md/myne#884 task 8).
   *
   * **The line is held here rather than read from the record**, because a
   * record's `rawLine` is as old as the index's last apply and the writer refuses
   * a line that no longer matches disk. The local copy is kept current with the
   * byte-identical rewrite `writeTaskField` applies, so a second edit in the same
   * session is not refused.
   */
  const openFields = useCallback(
    (task: VaultTask, control: HTMLElement): void => {
      if (onWriteField === undefined) return;
      const held = { line: task.rawLine };
      openTaskFieldMenu({
        anchor: control,
        target: {
          present: () => {
            const out = new Set<TaskFieldKind>();
            for (const kind of FIELD_KINDS) {
              if (readTaskField(held.line, kind) !== undefined) out.add(kind);
            }
            return out;
          },
          valueOf: (kind) => readTaskField(held.line, kind) ?? "",
          lineText: () => held.line,
          commit: async (kind, value) => {
            await onWriteField({ ...task, rawLine: held.line }, kind, value);
            held.line = rewriteTaskField(held.line, kind, value) ?? held.line;
          },
        },
      });
    },
    [onWriteField],
  );

  /** Per-row binding, or undefined so a client with no field write renders no
   *  control. Built per row because the surface must be anchored to the control
   *  AND write THAT row's task.
   *
   *  Two rows are excluded because their write cannot succeed, and offering a
   *  control that quietly does nothing is worse than not offering one: a
   *  note-task has no line to rewrite (`line-missing`), and an over-cap record's
   *  raw line is truncated, so it cannot be verified (`oversized`). Both would
   *  otherwise open the menu, commit, and refuse behind a `console.warn`. */
  const editFieldsFor = (
    task: VaultTask,
  ): ((row: TaskRowData, control: HTMLElement) => void) | undefined => {
    if (onWriteField === undefined) return undefined;
    if (task.lineIndex === null || task.oversized) return undefined;
    return (_row, control) => openFields(task, control);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void => setViewport(el.clientHeight);
    measure();
    const onScroll = (): void => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [view, search]);

  const window_ = computeTaskWindow(items, scrollTop, viewport);
  const slice = items.slice(window_.start, window_.end);

  const folderOptions = useMemo(() => distinctFolders(tasks), [tasks]);
  const tagOptions = useMemo(() => distinctTags(tasks, tagsOf ?? (() => NO_TAGS)), [tasks, tagsOf]);
  // A note is only offered when it is inside a selected folder, so the Folder
  // and Note axes cannot contradict each other (myne-md/myne#656 review).
  const noteOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) {
      if (view.folders.length > 0 && !view.folders.some((f) => folderInScope(f, task.noteFolder))) {
        continue;
      }
      if (!seen.has(task.noteId)) seen.set(task.noteId, task.noteTitle ?? t("common.untitled"));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks, t, view.folders]);

  // If a folder is (re)selected that excludes the chosen note, drop the note
  // filter rather than showing an impossible combination.
  useEffect(() => {
    if (view.noteId === null || view.folders.length === 0) return;
    const task = tasks.find((x) => x.noteId === view.noteId);
    if (task === undefined) return;
    if (!view.folders.some((f) => folderInScope(f, task.noteFolder))) {
      onViewChange({ ...view, noteId: null });
    }
  }, [view, tasks, onViewChange]);

  const setView = useCallback(
    (patch: Partial<TaskView>): void => onViewChange({ ...view, ...patch }),
    [onViewChange, view],
  );

  const chips = useMemo(() => {
    const out: { key: string; label: string; clear: () => void }[] = [];
    if (view.status !== DEFAULT_TASK_VIEW.status) {
      out.push({ key: "status", label: t(`tasks.status.${view.status}`), clear: () => setView({ status: DEFAULT_TASK_VIEW.status }) });
    }
    if (view.due !== "any") {
      out.push({ key: "due", label: `${t("tasks.axis.due")}: ${t(`tasks.due.${view.due}`)}`, clear: () => setView({ due: "any" }) });
    }
    for (const folder of view.folders) {
      out.push({
        key: `folder:${folder}`,
        label: `${t("tasks.axis.folder")}: ${folder}`,
        clear: () => setView({ folders: view.folders.filter((f) => f !== folder) }),
      });
    }
    if (view.noteId !== null) {
      const title = noteOptions.find(([id]) => id === view.noteId)?.[1] ?? t("common.untitled");
      out.push({ key: "note", label: `${t("tasks.axis.note")}: ${title}`, clear: () => setView({ noteId: null }) });
    }
    for (const tag of view.tags) {
      out.push({ key: `tag:${tag}`, label: `${t("tasks.axis.tag")}: ${tag}`, clear: () => setView({ tags: view.tags.filter((x) => x !== tag) }) });
    }
    if (view.priority !== "any") {
      out.push({ key: "priority", label: `${t("common.priority")}: ${t(`tasks.priority.${view.priority}`)}`, clear: () => setView({ priority: "any" }) });
    }
    if (view.sort !== "due") {
      out.push({ key: "sort", label: `${t("tasks.axis.sort")}: ${t(`tasks.sort.${view.sort}`)}`, clear: () => setView({ sort: "due" }) });
    }
    return out;
  }, [view, t, noteOptions, setView]);

  const emptyKind = ((): "rebuilding" | "search" | "vault" | "filter" | null => {
    if (rebuilding) return "rebuilding";
    if (items.length > 0) return null;
    if (search.trim() !== "") return "search";
    if (tasks.length === 0) return "vault";
    return "filter";
  })();

  return (
    <div style={PANEL_STYLE} data-testid={`${testIdPrefix}.panel`}>
      <div style={minimal ? MINIMAL_TOOLBAR_STYLE : TOOLBAR_STYLE}>
        <div style={SEARCH_ROW_STYLE}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("tasks.search.placeholder")}
            aria-label={t("tasks.search.label")}
            style={SEARCH_STYLE}
            data-testid={`${testIdPrefix}.search`}
          />
          {minimal ? null : (
            <button
              type="button"
              ref={filtersButtonRef}
              style={filtersHover ? FILTERS_BUTTON_HOVER_STYLE : FILTERS_BUTTON_STYLE}
              {...filtersHandlers}
              aria-expanded={builderOpen}
              aria-haspopup="dialog"
              data-testid={`${testIdPrefix}.filtersButton`}
              onClick={() => setBuilderOpen((o) => !o)}
            >
              <Icon name="settings" size={13} />
              {t("tasks.filters.button")}
              {chips.length > 0 ? (
                <span style={FILTERS_COUNT_STYLE} data-testid={`${testIdPrefix}.filtersCount`}>
                  {chips.length}
                </span>
              ) : null}
            </button>
          )}
        </div>

        {!minimal && builderOpen
          ? filterSheet === undefined
            ? (
              <>
                <div style={BUILDER_BACKDROP_STYLE} onClick={() => setBuilderOpen(false)} />
                <TaskFilterBuilder
                  view={view}
                  onViewChange={onViewChange}
                  onClose={closeBuilder}
                  folderOptions={folderOptions}
                  noteOptions={noteOptions}
                  tagOptions={tagOptions}
                  testIdPrefix={testIdPrefix}
                />
              </>
            )
            : filterSheet({
                view,
                onViewChange,
                onClose: closeBuilder,
                folderOptions,
                noteOptions,
                tagOptions,
                testIdPrefix,
              })
          : null}

        {!minimal && chips.length > 0 ? (
          <div style={CHIPS_ROW_STYLE} data-testid={`${testIdPrefix}.appliedFilters`}>
            {chips.map((chip) => (
              <FilterChip
                key={chip.key}
                label={chip.label}
                testId={`${testIdPrefix}.applied.${chip.key}`}
                onRemove={chip.clear}
              />
            ))}
            <button
              type="button"
              style={clearHover ? INLINE_CLEAR_HOVER_STYLE : INLINE_CLEAR_STYLE}
              {...clearHandlers}
              data-testid={`${testIdPrefix}.clearFilters`}
              onClick={() => onViewChange(DEFAULT_TASK_VIEW)}
            >
              {t("tasks.filters.clearAll")}
            </button>
          </div>
        ) : null}

        <div style={SEPARATOR_STYLE} aria-hidden="true" />
      </div>

      <div ref={scrollRef} style={SCROLL_STYLE} data-testid={`${testIdPrefix}.scroll`}>
        {emptyKind !== null ? (
          <div style={EMPTY_STYLE} data-testid={`${testIdPrefix}.empty.${emptyKind}`}>
            {t(`tasks.empty.${emptyKind}`, { query: search.trim() })}
          </div>
        ) : minimal ? (
          // The note-scoped panel is small and its rows carry an inline date
          // under the text, so they are variable-height: render them in flow
          // rather than through the fixed-height window (myne-md/myne#656).
          items.map((item) =>
            item.kind === "header" ? (
              <div key={item.id} style={HEADER_BASE} data-testid={`${testIdPrefix}.section.${item.section}`}>
                <span>{t(`tasks.section.${item.section}`)}</span>
                <span style={HEADER_COUNT_STYLE}>{item.count}</span>
              </div>
            ) : (
              <TaskRow
                key={item.id}
                task={toRowData(item.task, item.depth)}
                scope={rowScope}
                today={today}
                compactX
                inlineDate
                roomyBox={roomyBox}
                {...(showNoteTitle ? {} : { hideNoteTitle: true })}
                testIdPrefix={`${testIdPrefix}.row`}
                {...(onToggle === undefined ? {} : { onToggle: () => onToggle(item.task) })}
                {...(onOpen === undefined ? {} : { onOpen: () => onOpen(item.task) })}
                {...(() => {
                  const edit = editFieldsFor(item.task);
                  return edit === undefined ? {} : { onEditFields: edit };
                })()}
              />
            ),
          )
        ) : (
          <>
            <div style={{ height: window_.topPad }} aria-hidden="true" />
            {slice.map((item) =>
              item.kind === "header" ? (
                <div key={item.id} style={HEADER_BASE} data-testid={`${testIdPrefix}.section.${item.section}`}>
                  <span>{t(`tasks.section.${item.section}`)}</span>
                  <span style={HEADER_COUNT_STYLE}>{item.count}</span>
                </div>
              ) : (
                <div key={item.id} style={ROW_WRAP_STYLE}>
                  <TaskRow
                    task={toRowData(item.task, item.depth)}
                    scope={rowScope}
                    today={today}
                    roomyBox={roomyBox}
                    {...(showNoteTitle ? {} : { hideNoteTitle: true })}
                    testIdPrefix={`${testIdPrefix}.row`}
                    {...(onToggle === undefined ? {} : { onToggle: () => onToggle(item.task) })}
                    {...(onOpen === undefined ? {} : { onOpen: () => onOpen(item.task) })}
                    {...(() => {
                      const edit = editFieldsFor(item.task);
                      return edit === undefined ? {} : { onEditFields: edit };
                    })()}
                  />
                </div>
              ),
            )}
            <div style={{ height: window_.bottomPad }} aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}

/** The default every caller starts from; re-exported so callers import one module. */
export { DEFAULT_TASK_VIEW };
