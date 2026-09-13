// Hand-rolled windowing for the Tasks panel (myne-md/myne#656, folded).
//
// A vault with thousands of tasks mounted every row; the panel needs only the
// slice on screen. No dependency: the list has a few fixed-height item shapes
// (a section header, a single-line row), so a prefix-sum offset table and a
// binary search are all the machinery a virtual list needs here.
//
// The pure half lives here so the scroll maths is unit-testable without a DOM;
// the component supplies `scrollTop` and the viewport height from a ref.

import type { VaultTask } from "./taskIndex";
import type { TaskSection, TaskSectionKey } from "./taskView";
import { taskRowKey } from "./taskWriteCore";

/** Fixed item heights - the whole virtual list depends on these being constant. */
export const TASK_ROW_HEIGHT = 32;
export const TASK_HEADER_HEIGHT = 30;

/** Rows rendered beyond each edge, so a fast scroll does not flash blank. */
export const TASK_OVERSCAN = 8;

/** Used when the viewport has not been measured yet (jsdom, first paint). */
export const TASK_DEFAULT_VIEWPORT = 640;

export type TaskListItem =
  | { readonly kind: "header"; readonly id: string; readonly section: TaskSectionKey; readonly count: number }
  | { readonly kind: "row"; readonly id: string; readonly task: VaultTask; readonly depth: number };

/** Flatten sections (plus each section's header) into one virtual list. */
export function flattenTaskList(
  sections: readonly TaskSection[],
  depths: ReadonlyMap<string, number>,
): TaskListItem[] {
  const items: TaskListItem[] = [];
  for (const section of sections) {
    items.push({
      kind: "header",
      id: `header:${section.key}`,
      section: section.key,
      count: section.tasks.length,
    });
    for (const task of section.tasks) {
      const key = taskRowKey(task);
      items.push({ kind: "row", id: key, task, depth: depths.get(key) ?? 0 });
    }
  }
  return items;
}

export function taskItemHeight(item: TaskListItem): number {
  return item.kind === "header" ? TASK_HEADER_HEIGHT : TASK_ROW_HEIGHT;
}

export type TaskWindow = {
  /** Slice bounds: `items.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Spacer heights that keep the scrollbar honest around the slice. */
  readonly topPad: number;
  readonly bottomPad: number;
};

const EMPTY_WINDOW: TaskWindow = {
  start: 0,
  end: 0,
  topPad: 0,
  bottomPad: 0,
};

/**
 * Which items to render for a given scroll position.
 *
 * `offsets[i]` is the top of item `i`; the first visible item is the last whose
 * top is at or above `scrollTop`. Everything is integer pixels because every
 * item height is.
 */
export function computeTaskWindow(
  items: readonly TaskListItem[],
  scrollTop: number,
  viewportHeight: number,
): TaskWindow {
  const n = items.length;
  if (n === 0) return EMPTY_WINDOW;

  const offsets = new Array<number>(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i += 1) offsets[i + 1] = offsets[i]! + taskItemHeight(items[i]!);
  const total = offsets[n]!;
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, total - 1)));
  const height = viewportHeight > 0 ? viewportHeight : TASK_DEFAULT_VIEWPORT;

  // Binary search: the last index whose top offset is <= `top`.
  let lo = 0;
  let hi = n; // exclusive
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= top) lo = mid + 1;
    else hi = mid;
  }
  const first = Math.max(0, lo - 1);

  let end = first;
  while (end < n && offsets[end]! < top + height) end += 1;

  const start = Math.max(0, first - TASK_OVERSCAN);
  const endWithOverscan = Math.min(n, end + TASK_OVERSCAN);

  return {
    start,
    end: endWithOverscan,
    topPad: offsets[start]!,
    bottomPad: total - offsets[endWithOverscan]!,
  };
}
