// Host-side results for the task-query blocks in one pane (MYND-617).
//
// The editor package finds the blocks and renders what it is handed; deciding
// WHAT a query means is the host's job, and deliberately so: reading a `due::`
// value is the dialect's §3.6.4 type authority, and the vault-wide task list is
// an IPC surface. So the split is `taskQueryBlocks` (editor, one tree walk) →
// `parseTaskQuery` + `runTaskQuery` (here) → `setTaskQueryResults` (editor).
//
// **One tree walk, not two.** The block list comes from the editor's exported
// `taskQueryBlocks(state)`, never from a second regex over the body. A private
// scanner here would drift from the one that decides which ranges get replaced,
// and the failure mode is a block that renders results computed for a different
// query — which looks like a working list.
//
// **A missing entry is LOADING, not empty.** The map only carries blocks whose
// results are computed; the widget shows a loading state for anything absent,
// because an empty list presented as a finished answer is the worst reading
// available here.

import { dateTimeDisplay } from "../lib/datetimeFormat";
import { useEffect, useMemo, useState } from "react";
import { taskQueryBlocks } from "@myne/editor/decorations/task-query-block";
import type {
  TaskQueryRender,
  TaskQueryRow,
} from "@myne/editor/decorations/task-query-block";
import type { EditorView } from "@codemirror/view";
import { taskDescription } from "../dialect/taskFieldWriter";
import { useLocalToday } from "./useLocalToday";
import { parseTaskQuery } from "./taskQuery";
import { runTaskQuery } from "./taskQueryRun";
import { taskRowKey, type VaultTask } from "./taskWriteCore";
import { useLiveVaultTasks } from "./taskIndex";
import { byTag } from "./vaultIndices";

const EMPTY_RESULTS: ReadonlyMap<string, TaskQueryRender> = new Map();

/**
 * Project an index record into the flat, inert row shape the widget renders.
 *
 * `due` is spread on `== null` for the same reason `TaskListPanel.toRowData`
 * does: `TaskQueryRow.due` is declared optional, and the widget prints whatever
 * it is handed (`task-query-block.ts`), so a wire `null` copied through here
 * renders the literal text "null" rather than no date at all.
 */
function toQueryRow(task: VaultTask): TaskQueryRow {
  return {
    key: taskRowKey(task),
    // A note-task has no line; its title IS the task.
    text: task.lineIndex === null ? (task.noteTitle ?? "") : taskDescription(task.rawLine),
    completed: task.completed,
    noteTitle: task.noteTitle,
    ...(task.due == null ? {} : { due: task.due }),
    ...(task.oversized ? { oversized: true } : {}),
  };
}

/**
 * The distinct `tag includes …` texts across a document's queries.
 *
 * Collected so the tag lookup costs one IPC per tag actually asked about —
 * usually zero — rather than a whole-vault note→tags inversion on every
 * keystroke.
 */
function tagClauseTexts(queries: readonly string[]): string[] {
  const out = new Set<string>();
  for (const query of queries) {
    for (const clause of parseTaskQuery(query).clauses) {
      if (clause.kind === "tagIncludes") out.add(clause.text);
    }
  }
  return [...out];
}

/**
 * Results for every task-query block in `view`'s document, plus the reverse
 * lookup a row event needs.
 *
 * `body` is the recompute signal rather than a value this reads: `view.state` is
 * not reactive, so the pane's mirrored body is what tells React the document
 * moved. `indexNonce` covers the other direction — a task edited in a DIFFERENT
 * note changes no body here but must still re-run every query.
 */
export function useTaskQueryResults(
  view: EditorView | null,
  body: string,
  indexNonce: number,
): {
  results: ReadonlyMap<string, TaskQueryRender>;
  resolveRow: (rowKey: string) => VaultTask | undefined;
} {
  const tasks = useLiveVaultTasks();

  // The block list, re-walked when the document moves. `view.state` is current
  // by the time a `body` change renders — CM updates its state before the
  // `onChange` that sets it.
  const queries = useMemo(() => {
    if (view === null) return [] as string[];
    return taskQueryBlocks(view.state).map((block) => block.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, body]);

  // Which notes carry each queried tag. `byTag` is subtree-inclusive and folds
  // the tag TS-side (§3.7.8), which is exactly the `tag === want ||
  // tag.startsWith(want + "/")` semantics `runTaskQuery` applies — so the
  // canonical accessor answers the question the clause is asking, and no second
  // fold is introduced here.
  const [tagNotes, setTagNotes] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const tagKey = useMemo(() => tagClauseTexts(queries).sort().join("\u0000"), [queries]);

  useEffect(() => {
    const wanted = tagKey === "" ? [] : tagKey.split("\u0000");
    if (wanted.length === 0) {
      setTagNotes((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void (async () => {
      const pairs = await Promise.all(
        wanted.map(async (tag) => {
          try {
            return [tag, new Set(await byTag(tag))] as const;
          } catch {
            // A failed lookup must not widen the query to "every note matches".
            // An empty set excludes, which is the safe direction.
            return [tag, new Set<string>()] as const;
          }
        }),
      );
      if (!cancelled) setTagNotes(new Map(pairs));
    })();
    return () => {
      cancelled = true;
    };
  }, [tagKey, indexNonce]);

  // myne#279: "today" follows the display timezone when one is set. Resolved
  // through `useLocalToday` rather than inline, so a query block's "today"
  // re-resolves when the day rolls over instead of only when the task list or
  // the tag index happens to change (myne-md/myne#557).
  const today = useLocalToday(dateTimeDisplay().timeZone);

  const results = useMemo(() => {
    if (queries.length === 0) return EMPTY_RESULTS;
    const tagsOf = (noteId: string): readonly string[] => {
      const out: string[] = [];
      for (const [tag, ids] of tagNotes) if (ids.has(noteId)) out.push(tag);
      return out;
    };
    const map = new Map<string, TaskQueryRender>();
    for (const query of queries) {
      if (map.has(query)) continue; // two identical blocks share one answer
      const parsed = parseTaskQuery(query);
      const result = runTaskQuery(parsed, tasks, today, tagsOf);
      map.set(query, {
        rows: result.rows.map(toQueryRow),
        remainder: result.remainder,
        dropped: parsed.warnings.map((w) => w.text),
        refused: result.refused,
      });
    }
    return map;
  }, [queries, tasks, tagNotes, today]);

  const byRowKey = useMemo(() => {
    const map = new Map<string, VaultTask>();
    for (const task of tasks) map.set(taskRowKey(task), task);
    return map;
  }, [tasks]);

  return useMemo(
    () => ({ results, resolveRow: (rowKey: string) => byRowKey.get(rowKey) }),
    [results, byRowKey],
  );
}
