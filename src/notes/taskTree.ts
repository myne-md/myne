// Task nesting for the Tasks panel (myne-md/myne#656 item 7).
//
// `VaultTask` deliberately carries no depth or parent (the index is a flat
// list), so the authored structure lives in exactly one place: the leading
// whitespace on `rawLine`. `taskFieldWriter` already reads it with `/^[ \t]*/`,
// and ordering within a note comes from `lineIndex` - no wire change is needed.
//
// The panel renders a FLAT, date-sorted list, so "depth" here is not a tree
// index; it is how far a row should be indented relative to the rows actually
// on screen. A task whose authored parent is filtered out is promoted to depth
// 0 rather than rendered as an indent hanging under nothing:
//
//   - hiding it would drop a real task from a filtered view (the invisible
//     failure myne-md/myne#658 records), and
//   - rendering its authored indent would show a step with no visible step
//     above it, which reads as a rendering bug.
//
// This module is pure and React-free so the two design answers above are
// testable without a DOM.

import type { VaultTask } from "./taskIndex";
import { taskRowKey } from "./taskWriteCore";

/** A tab advances to the next multiple of this many columns, per GFM. */
const TAB_WIDTH = 4;

/**
 * The visual column width of a line's leading whitespace. Tabs advance to the
 * next tab stop rather than counting as one, so `\t- [ ]` and `    - [ ]` sit at
 * the same depth - which is what the parser sees and what a reader sees.
 */
export function taskIndentWidth(rawLine: string): number {
  const lead = /^[ \t]*/.exec(rawLine)?.[0] ?? "";
  let width = 0;
  for (const ch of lead) {
    width += ch === "\t" ? TAB_WIDTH - (width % TAB_WIDTH) : 1;
  }
  return width;
}

/** Tasks grouped by note, each group in line order (note-tasks last). */
function byNoteInLineOrder(tasks: readonly VaultTask[]): VaultTask[][] {
  const groups = new Map<string, VaultTask[]>();
  for (const task of tasks) {
    const list = groups.get(task.noteId);
    if (list === undefined) groups.set(task.noteId, [task]);
    else list.push(task);
  }
  const sorted: VaultTask[][] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.lineIndex ?? Infinity) - (b.lineIndex ?? Infinity));
    sorted.push(list);
  }
  return sorted;
}

/**
 * The key of each task's authored parent, from a per-note indent stack. A task
 * whose indent is not greater than the previous task's has no parent at that
 * level - the stack pops back to a shallower line. Note-tasks (no line, no
 * indent) are always roots and never become parents.
 */
function authoredParents(tasks: readonly VaultTask[]): Map<string, string> {
  const parent = new Map<string, string>();
  for (const list of byNoteInLineOrder(tasks)) {
    const stack: VaultTask[] = [];
    for (const task of list) {
      if (task.lineIndex === null) continue;
      const indent = taskIndentWidth(task.rawLine);
      while (
        stack.length > 0 &&
        taskIndentWidth(stack[stack.length - 1]!.rawLine) >= indent
      ) {
        stack.pop();
      }
      const above = stack[stack.length - 1];
      if (above !== undefined) parent.set(taskRowKey(task), taskRowKey(above));
      stack.push(task);
    }
  }
  return parent;
}

/**
 * The depth each VISIBLE task should render at, keyed by `taskRowKey`. A task
 * with no visible authored parent is depth 0 (the promotion rule above); a task
 * whose parent is visible follows it one level down. Parents precede children in
 * line order, so a single pass resolves every chain.
 *
 * @param tasks       the full live set, so an authored parent is found even when
 *                    the current filter would drop it
 * @param visibleKeys the keys currently on screen (`matched` in the panel)
 */
export function visibleDepths(
  tasks: readonly VaultTask[],
  visibleKeys: ReadonlySet<string>,
): Map<string, number> {
  const parent = authoredParents(tasks);
  const depth = new Map<string, number>();
  for (const list of byNoteInLineOrder(tasks)) {
    for (const task of list) {
      const key = taskRowKey(task);
      const parentKey = parent.get(key);
      const d =
        parentKey !== undefined && visibleKeys.has(parentKey)
          ? (depth.get(parentKey) ?? 0) + 1
          : 0;
      depth.set(key, d);
    }
  }
  return depth;
}
