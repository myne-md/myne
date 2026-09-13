// Hand-rolled windowing (myne-md/myne#656, folded).
//
// The scroll maths is the part that breaks silently: an off-by-one in the
// offsets clips the last row, a wrong `first` index makes fast scrolling flash
// blank, and a wrong sticky index pins the wrong section. All of it is pure, so
// it is pinned here rather than through a DOM.

import { describe, expect, it } from "vitest";
import {
  TASK_HEADER_HEIGHT,
  TASK_OVERSCAN,
  TASK_ROW_HEIGHT,
  computeTaskWindow,
  flattenTaskList,
  taskItemHeight,
} from "../../src/notes/taskWindowing";
import type { TaskSection } from "../../src/notes/taskView";
import type { VaultTask } from "../../src/notes/taskIndex";

function task(noteId: string, lineIndex: number): VaultTask {
  return {
    noteId,
    noteTitle: "N",
    noteFolder: null,
    lineIndex,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
  } as VaultTask;
}

const sections: TaskSection[] = [
  { key: "overdue", tasks: [task("a", 0), task("b", 1)] },
  { key: "today", tasks: [task("c", 0)] },
];

describe("flattenTaskList", () => {
  it("puts a header before each section's rows", () => {
    const items = flattenTaskList(sections, new Map());
    expect(items.map((i) => (i.kind === "header" ? `H:${i.section}` : `R:${i.task.noteId}`))).toEqual([
      "H:overdue",
      "R:a",
      "R:b",
      "H:today",
      "R:c",
    ]);
  });

  it("carries the section count onto the header, replacing the old badge", () => {
    const items = flattenTaskList(sections, new Map());
    expect(items[0]).toMatchObject({ kind: "header", count: 2 });
  });

  it("carries depth from the lookup", () => {
    const items = flattenTaskList([{ key: "none", tasks: [task("a", 0)] }], new Map([["a:0", 3]]));
    expect(items[1]).toMatchObject({ kind: "row", depth: 3 });
  });

  it("heights are the fixed constants", () => {
    const items = flattenTaskList(sections, new Map());
    expect(taskItemHeight(items[0]!)).toBe(TASK_HEADER_HEIGHT);
    expect(taskItemHeight(items[1]!)).toBe(TASK_ROW_HEIGHT);
  });
});

describe("computeTaskWindow", () => {
  it("is empty for no items", () => {
    expect(computeTaskWindow([], 0, 400)).toEqual({
      start: 0,
      end: 0,
      topPad: 0,
      bottomPad: 0,
      stickyIndex: -1,
      stickyPinned: false,
    });
  });

  it("renders the first slice at the top, with the whole list below as bottom pad", () => {
    const items = flattenTaskList(sections, new Map());
    const w = computeTaskWindow(items, 0, 2 * TASK_ROW_HEIGHT);
    const total = TASK_HEADER_HEIGHT * 2 + TASK_ROW_HEIGHT * 3;
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
    // Everything past the slice is pad, so the scrollbar still spans the list.
    expect(w.topPad + w.bottomPad + total).toBeGreaterThan(total - 1);
    const sliceHeight = items
      .slice(w.start, w.end)
      .reduce((sum, i) => sum + taskItemHeight(i), 0);
    expect(w.topPad + sliceHeight + w.bottomPad).toBe(total);
    expect(w.end).toBeGreaterThan(0);
  });

  it("moves the slice down as the scroll advances, and topPad tracks it", () => {
    const items = flattenTaskList(
      [{ key: "none", tasks: Array.from({ length: 200 }, (_, i) => task(`n${i}`, i)) }],
      new Map(),
    );
    const below = computeTaskWindow(items, 0, 300);
    const scrolled = computeTaskWindow(items, 3000, 300);
    expect(scrolled.start).toBeGreaterThan(below.start);
    expect(scrolled.topPad).toBeGreaterThan(below.topPad);
    // Overscan is what keeps a fast scroll from flashing blank.
    const firstVisible = Math.floor((3000 - TASK_HEADER_HEIGHT) / TASK_ROW_HEIGHT) + 1;
    expect(scrolled.start).toBeLessThanOrEqual(firstVisible);
    expect(scrolled.start).toBeGreaterThanOrEqual(firstVisible - TASK_OVERSCAN);
  });

  it("clamps past the end instead of throwing or over-slicing", () => {
    const items = flattenTaskList(sections, new Map());
    const w = computeTaskWindow(items, 999_999, 300);
    expect(w.end).toBe(items.length);
    expect(w.bottomPad).toBe(0);
  });

  it("points sticky at the section header governing the first visible row", () => {
    const items = flattenTaskList(
      [
        { key: "overdue", tasks: Array.from({ length: 20 }, (_, i) => task(`o${i}`, i)) },
        { key: "today", tasks: [task("t", 0)] },
      ],
      new Map(),
    );
    const nearTop = computeTaskWindow(items, 0, 100);
    expect(items[nearTop.stickyIndex]).toMatchObject({ kind: "header", section: "overdue" });
    expect(nearTop.stickyPinned).toBe(false);
    // Into the second section's rows, the second header sticks.
    const intoToday = computeTaskWindow(items, TASK_HEADER_HEIGHT + 20 * TASK_ROW_HEIGHT + 4, 100);
    expect(items[intoToday.stickyIndex]).toMatchObject({ kind: "header", section: "today" });
    expect(intoToday.stickyPinned).toBe(true);
  });

  it("falls back to a viewport when the region has not been measured", () => {
    // jsdom reports 0; a measured 0 would mean "render nothing", which blanks
    // every test and the first paint.
    const items = flattenTaskList(sections, new Map());
    const w = computeTaskWindow(items, 0, 0);
    expect(w.end).toBeGreaterThan(0);
  });
});
