// The mobile scope selector (MYND-620, task 3 — story 11).
//
// The desktop has no interactive equivalent: its `TasksPane` takes its scope
// from the workspace item it was opened as, so a saved view carries the folder
// and tags and there is nothing to pick. On a phone there is no workspace item,
// so the narrowing has to be a control — otherwise a vault-wide list on a phone
// is the "unusable dump of everything" story 11 names.
//
// The **semantics are the shared ones**, not new ones: folder narrows (AND),
// tags widen among themselves (OR), and the toggle goes through the shared
// `toggleScopeTag` rather than a local set manipulation. This file chooses what
// to *offer*, never what scoping *means*.
//
// It offers only what is actually present in the current task set. A folder with
// no tasks in it is not a narrowing a user would want and would make the strip
// scroll past things that do nothing.

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toggleScopeTag, type TaskScope } from "@myne/task-scope";
import type { VaultTask } from "../lib/tasks";

/** How many tag chips to offer before the strip stops being scannable. */
const MAX_TAG_CHIPS = 12;

const STRIP_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "6px 10px",
  overflowX: "auto",
  borderBottom: "1px solid var(--line-1)",
  // The strip scrolls; the page must not scroll sideways with it.
  scrollbarWidth: "none",
};

function chipStyle(active: boolean): CSSProperties {
  return {
    flex: "none",
    padding: "4px 10px",
    borderRadius: "var(--radius-pill, 999px)",
    // Selection is the ONE thing a fill may carry here — it is where the user
    // is, not a state of the tasks. The epic's rule forbids a fill that reads
    // as status.
    background: active ? "var(--paper-3)" : "transparent",
    color: active ? "var(--fg-1)" : "var(--fg-2)",
    border: "1px solid var(--line-1)",
    fontFamily: "var(--font-sans)",
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    whiteSpace: "nowrap",
    cursor: "pointer",
  };
}

export type TaskScopeStripProps = {
  tasks: readonly VaultTask[];
  scope: TaskScope;
  onScopeChange: (next: TaskScope) => void;
  /** Per-note tags. Omitted → the tag half is not offered at all. */
  tagsOf?: (noteId: string) => readonly string[];
};

export function TaskScopeStrip({
  tasks,
  scope,
  onScopeChange,
  tagsOf,
}: TaskScopeStripProps): ReactNode {
  const { t } = useTranslation();

  const folders = useMemo(() => {
    const seen = new Set<string>();
    for (const task of tasks) if (task.noteFolder !== null) seen.add(task.noteFolder);
    return [...seen].sort();
  }, [tasks]);

  const tags = useMemo(() => {
    if (tagsOf === undefined) return [];
    const counts = new Map<string, number>();
    const countedNotes = new Set<string>();
    for (const task of tasks) {
      // Per NOTE, not per task: a note with six tasks would otherwise make its
      // tags look six times more common than they are.
      if (countedNotes.has(task.noteId)) continue;
      countedNotes.add(task.noteId);
      for (const tag of tagsOf(task.noteId)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_TAG_CHIPS)
      .map(([tag]) => tag);
  }, [tasks, tagsOf]);

  // Nothing to narrow by is not a control — it is a bar taking a row of screen
  // to say so.
  if (folders.length === 0 && tags.length === 0) return null;

  return (
    <div style={STRIP_STYLE} data-testid="tasks.scope-strip" aria-label={t("tasks.scope.label")}>
      <button
        type="button"
        data-testid="tasks.scope-all"
        style={chipStyle(scope.folder === null)}
        onClick={() => onScopeChange({ ...scope, folder: null })}
      >
        {t("tasks.scope.allFolders")}
      </button>
      {folders.map((folder) => (
        <button
          key={`f:${folder}`}
          type="button"
          data-testid={`tasks.scope-folder-${folder}`}
          style={chipStyle(scope.folder === folder)}
          onClick={() =>
            onScopeChange({ ...scope, folder: scope.folder === folder ? null : folder })
          }
        >
          {folder}
        </button>
      ))}
      {tags.map((tag) => (
        <button
          key={`t:${tag}`}
          type="button"
          data-testid={`tasks.scope-tag-${tag}`}
          style={chipStyle(scope.tags.includes(tag))}
          onClick={() => onScopeChange(toggleScopeTag(scope, tag))}
        >
          #{tag}
        </button>
      ))}
    </div>
  );
}
