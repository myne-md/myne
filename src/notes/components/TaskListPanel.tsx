// The task list body (MYND-616, redesigned for myne-md/myne#656).
//
// ONE body for both surfaces. The vault-wide tab and the note-scoped right-panel
// tab differ by the `scope` prop and by which task list they are handed —
// nothing else.
//
// **The design, as decided in the #656 grill:**
//   - section headers (Overdue / Today / Upcoming / Later / No date, then a flat
//     Done section) REPLACE the old four date tabs; section order is fixed and
//     attention-first, and each header carries its own count;
//   - a curated filter row replaces the tabs: status (undone/all/done), due
//     window, folder, note, tag, priority, and a within-section sort;
//   - the list is hand-rolled WINDOWED (a vault can hold thousands of tasks),
//     with fixed-height rows and a sticky section header;
//   - the search box filters the live array client-side.
//
// EMPTY-STATE TONE IS A CONSTRAINT. The canon forbids a green check and the
// product voice is honest rather than congratulatory: an empty week is stated,
// not celebrated. No confetti, no tick.

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
import { Select } from "../../components/primitives/Select";
import { Segmented } from "../../components/primitives/Segmented";
import { taskDescription } from "../../dialect/taskFieldWriter";
import {
  DEFAULT_TASK_VIEW,
  distinctFolders,
  distinctTags,
  partitionTasks,
  type TaskDueFilter,
  type TaskPriorityFilter,
  type TaskSectionKey,
  type TaskSort,
  type TaskStatusFilter,
  type TaskView,
} from "../taskView";
import { visibleDepths } from "../taskTree";
import { taskRowKey } from "../taskWriteCore";
import {
  TASK_ROW_HEIGHT,
  computeTaskWindow,
  flattenTaskList,
  type TaskListItem,
} from "../taskWindowing";
import type { VaultTask } from "../taskIndex";

export type TaskListPanelProps = {
  tasks: readonly VaultTask[];
  /** The persisted view (filters + sort). */
  view: TaskView;
  today: string;
  /** Which surface this is — passed straight through to every row. */
  rowScope: TaskRowScope;
  /** Per-note tags, for the scope selector's tag half. */
  tagsOf?: (noteId: string) => readonly string[];
  /** True while the index is still being built. */
  rebuilding?: boolean;
  onViewChange: (next: TaskView) => void;
  onToggle?: (task: VaultTask) => void;
  onOpen?: (task: VaultTask) => void;
  testIdPrefix?: string;
};

const NO_TAGS: readonly string[] = [];

/**
 * Project an index record into what a row needs. `depth` is the visible-relative
 * indent the tree helper computed.
 */
function toRowData(task: VaultTask, depth: number): TaskRowData {
  return {
    key: taskRowKey(task),
    text: task.lineIndex === null ? (task.noteTitle ?? "") : taskDescription(task.rawLine),
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

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
};

const FILTER_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "6px 8px",
  borderBottom: "1px solid var(--line-1)",
};

const SEARCH_STYLE: CSSProperties = {
  flex: "1 1 120px",
  minWidth: 90,
  boxSizing: "border-box",
  padding: "var(--space-1) var(--space-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  background: "var(--paper)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const SCROLL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  height: "100%",
  overflowY: "auto",
  position: "relative",
};

const HEADER_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  boxSizing: "border-box",
  height: TASK_ROW_HEIGHT - 2,
  padding: "0 8px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: 600,
  color: "var(--fg-2)",
  background: "var(--paper)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const HEADER_COUNT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 500,
};

const STICKY_STYLE: CSSProperties = {
  ...HEADER_BASE,
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 2,
  borderBottom: "1px solid var(--line-1)",
};

const ROW_WRAP_STYLE: CSSProperties = {
  height: TASK_ROW_HEIGHT,
  boxSizing: "border-box",
  overflow: "hidden",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  textAlign: "center",
};

/** A section header: label + count, used both in flow and pinned. */
function SectionHeader({
  section,
  count,
  testIdPrefix,
}: {
  section: TaskSectionKey;
  count: number;
  testIdPrefix: string;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div style={HEADER_BASE} data-testid={`${testIdPrefix}.section.${section}`}>
      <span>{t(`tasks.section.${section}`)}</span>
      <span style={HEADER_COUNT_STYLE}>{count}</span>
    </div>
  );
}

export function TaskListPanel({
  tasks,
  view,
  today,
  rowScope,
  tagsOf,
  rebuilding = false,
  onViewChange,
  onToggle,
  onOpen,
  testIdPrefix = "tasks",
}: TaskListPanelProps): ReactElement {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const sections = useMemo(
    () => partitionTasks(tasks, view, today, tagsOf ?? (() => NO_TAGS), search),
    [tasks, view, today, tagsOf, search],
  );

  // Nesting resolved against the FULL live set, so a parent filtered out still
  // promotes its child to depth 0 rather than hiding it.
  const depths = useMemo(() => {
    const visible = new Set<string>();
    for (const section of sections) for (const task of section.tasks) visible.add(taskRowKey(task));
    return visibleDepths(tasks, visible);
  }, [tasks, sections]);

  const items = useMemo(() => flattenTaskList(sections, depths), [sections, depths]);

  // ── Windowing ──────────────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

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

  // A new filter/search means a new list; keeping the old scroll offset would
  // strand the user mid-way down rows that no longer exist.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [view, search]);

  const window_ = computeTaskWindow(items, scrollTop, viewport);
  const slice = items.slice(window_.start, window_.end);
  const sticky =
    window_.stickyPinned && window_.stickyIndex >= 0
      ? (items[window_.stickyIndex] as Extract<TaskListItem, { kind: "header" }>)
      : null;

  // ── Filter options, derived from the live set (no separate data source) ─────
  const folderOptions = useMemo(() => distinctFolders(tasks), [tasks]);
  const tagOptions = useMemo(() => distinctTags(tasks, tagsOf ?? (() => NO_TAGS)), [tasks, tagsOf]);
  const noteOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) if (!seen.has(task.noteId)) seen.set(task.noteId, task.noteTitle ?? t("tasks.view.untitled"));
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks, t]);

  const setView = useCallback(
    (patch: Partial<TaskView>): void => onViewChange({ ...view, ...patch }),
    [onViewChange, view],
  );

  const emptyKind = ((): "rebuilding" | "search" | "vault" | "filter" | null => {
    if (rebuilding) return "rebuilding";
    if (items.length > 0) return null;
    if (search.trim() !== "") return "search";
    if (tasks.length === 0) return "vault";
    return "filter";
  })();

  const statusOptions = useMemo(
    () => [
      { value: "undone", label: t("tasks.status.undone") },
      { value: "all", label: t("tasks.status.all") },
      { value: "done", label: t("tasks.status.done") },
    ],
    [t],
  );

  return (
    <div style={PANEL_STYLE} data-testid={`${testIdPrefix}.panel`}>
      <div style={FILTER_ROW_STYLE} data-testid={`${testIdPrefix}.filters`}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("tasks.search.placeholder")}
          aria-label={t("tasks.search.label")}
          style={SEARCH_STYLE}
          data-testid={`${testIdPrefix}.search`}
        />
        <Segmented
          options={statusOptions}
          value={view.status}
          onChange={(v) => setView({ status: v as TaskStatusFilter })}
          ariaLabel={t("tasks.view.statusLabel")}
          testId={`${testIdPrefix}.status`}
        />
        <Select
          value={view.due}
          options={[
            { value: "any", label: t("tasks.due.any") },
            { value: "overdue", label: t("tasks.due.overdue") },
            { value: "today", label: t("tasks.due.today") },
            { value: "upcoming", label: t("tasks.due.upcoming") },
            { value: "later", label: t("tasks.due.later") },
            { value: "none", label: t("tasks.due.none") },
          ]}
          onChange={(v) => setView({ due: v as TaskDueFilter })}
          aria-label={t("tasks.view.dueLabel")}
          testId={`${testIdPrefix}.dueFilter`}
        />
        <Select
          value={view.folder ?? ""}
          options={[{ value: "", label: t("tasks.view.allFolders") }, ...folderOptions.map((f) => ({ value: f, label: f }))]}
          onChange={(v) => setView({ folder: v === "" ? null : v })}
          aria-label={t("tasks.view.folderLabel")}
          testId={`${testIdPrefix}.folderFilter`}
        />
        <Select
          value={view.noteId ?? ""}
          options={[{ value: "", label: t("tasks.view.allNotes") }, ...noteOptions.map(([id, title]) => ({ value: id, label: title }))]}
          onChange={(v) => setView({ noteId: v === "" ? null : v })}
          aria-label={t("tasks.view.noteLabel")}
          testId={`${testIdPrefix}.noteFilter`}
        />
        <Select
          value={view.tags[0] ?? ""}
          options={[{ value: "", label: t("tasks.view.anyTag") }, ...tagOptions.map((tag) => ({ value: tag, label: tag }))]}
          onChange={(v) => setView({ tags: v === "" ? [] : [v] })}
          aria-label={t("tasks.view.tagLabel")}
          testId={`${testIdPrefix}.tagFilter`}
        />
        <Select
          value={view.priority}
          options={[
            { value: "any", label: t("tasks.view.anyPriority") },
            ...(["highest", "high", "medium", "low", "lowest"] as const).map((p) => ({ value: p, label: t(`tasks.priority.${p}`) })),
          ]}
          onChange={(v) => setView({ priority: v as TaskPriorityFilter })}
          aria-label={t("tasks.view.priorityLabel")}
          testId={`${testIdPrefix}.priorityFilter`}
        />
        <Select
          value={view.sort}
          options={[
            { value: "due", label: t("tasks.sort.due") },
            { value: "dueDesc", label: t("tasks.sort.dueDesc") },
            { value: "priority", label: t("tasks.sort.priority") },
            { value: "note", label: t("tasks.sort.note") },
          ]}
          onChange={(v) => setView({ sort: v as TaskSort })}
          aria-label={t("tasks.view.sortLabel")}
          testId={`${testIdPrefix}.sort`}
        />
      </div>

      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }}>
        <div ref={scrollRef} style={SCROLL_STYLE} data-testid={`${testIdPrefix}.scroll`}>
          {emptyKind !== null ? (
            <div style={EMPTY_STYLE} data-testid={`${testIdPrefix}.empty.${emptyKind}`}>
              {t(`tasks.empty.${emptyKind}`, { query: search.trim() })}
            </div>
          ) : (
            <>
              <div style={{ height: window_.topPad }} aria-hidden="true" />
              {slice.map((item) =>
                item.kind === "header" ? (
                  <SectionHeader
                    key={item.id}
                    section={item.section}
                    count={item.count}
                    testIdPrefix={testIdPrefix}
                  />
                ) : (
                  <div key={item.id} style={ROW_WRAP_STYLE}>
                    <TaskRow
                      task={toRowData(item.task, item.depth)}
                      scope={rowScope}
                      today={today}
                      testIdPrefix={`${testIdPrefix}.row`}
                      {...(onToggle === undefined ? {} : { onToggle: () => onToggle(item.task) })}
                      {...(onOpen === undefined ? {} : { onOpen: () => onOpen(item.task) })}
                    />
                  </div>
                ),
              )}
              <div style={{ height: window_.bottomPad }} aria-hidden="true" />
            </>
          )}
        </div>
        {sticky !== null && emptyKind === null ? (
          <div style={STICKY_STYLE} data-testid={`${testIdPrefix}.stickyHeader`}>
            <span>{t(`tasks.section.${sticky.section}`)}</span>
            <span style={HEADER_COUNT_STYLE}>{sticky.count}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The default every caller starts from; re-exported so callers import one module. */
export { DEFAULT_TASK_VIEW };
