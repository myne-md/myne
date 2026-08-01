// Task filters, the date axis, and the sort (MYND-616 task 2).
//
// The difficulty in this module is entirely at the boundaries — the start of
// today, the inclusive end of the upcoming window, yesterday — so those are
// tested directly rather than through a representative middle case. The clock is
// injected everywhere, which is what makes that possible at all.

import { describe, expect, it } from "vitest";
import {
  filterAndSortTasks,
  matchesFilter,
  overdueCount,
  shiftDay,
  sortTasks,
  taskDate,
  todayLocal,
  UPCOMING_WINDOW_DAYS,
} from "../../src/notes/taskFilters";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Note",
    noteFolder: null,
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

describe("the date axis", () => {
  it("uses the due date", () => {
    expect(taskDate(task({ due: "2026-08-01" }))).toBe("2026-08-01");
  });

  it("falls back to the reminder, so a reminder-only task is not filed as undated", () => {
    // The case absolute reminders exist for: "remind me Tuesday to call my
    // mother" has no due date and must still appear on a dated surface.
    expect(taskDate(task({ remind: "2026-08-05" }))).toBe("2026-08-05");
  });

  it("prefers the due date when both are present", () => {
    expect(taskDate(task({ due: "2026-08-01", remind: "2026-07-30" }))).toBe("2026-08-01");
  });

  it("is day-granular — a wall-clock time never leaks into a comparison", () => {
    expect(taskDate(task({ due: "2026-08-01 14:30" }))).toBe("2026-08-01");
  });

  it("is undefined for a task with neither", () => {
    expect(taskDate(task({}))).toBeUndefined();
  });

  it("treats a wire `null` as undated rather than crashing on `.slice`", () => {
    // The `MYI1` row serializes `Option<String>` as `null`, not an absent key. A
    // client that skips the `taskWire.ts` `fromWire()` decoder hands that null
    // straight here — `=== undefined` would miss it and `.slice` a non-string,
    // which is the iOS Tasks-tab crash. `== null` catches both.
    const wireNull = task({ due: null, remind: null } as unknown as Partial<VaultTask>);
    expect(taskDate(wireNull)).toBeUndefined();
    expect(matchesFilter(wireNull, "today", TODAY)).toBe(false);
    expect(matchesFilter(wireNull, "all", TODAY)).toBe(true);
  });
});

describe("today means today", () => {
  it("contains only tasks due today", () => {
    expect(matchesFilter(task({ due: TODAY }), "today", TODAY)).toBe(true);
    expect(matchesFilter(task({ due: "2026-07-29" }), "today", TODAY)).toBe(false);
  });

  it("does NOT fold in overdue tasks", () => {
    // The decisive assertion for this feature's most-argued decision. Folding
    // them in makes the word stop meaning what it says, and the backlog stays
    // visible through the overdue count instead.
    expect(matchesFilter(task({ due: "2026-01-01" }), "today", TODAY)).toBe(false);
  });

  it("excludes undated tasks", () => {
    expect(matchesFilter(task({}), "today", TODAY)).toBe(false);
  });

  it("includes a reminder-only task on its reminder day", () => {
    expect(matchesFilter(task({ remind: TODAY }), "today", TODAY)).toBe(true);
  });
});

describe("upcoming is a rolling seven days", () => {
  it("includes today", () => {
    expect(matchesFilter(task({ due: TODAY }), "upcoming", TODAY)).toBe(true);
  });

  it("includes the last day of the window", () => {
    const last = shiftDay(TODAY, UPCOMING_WINDOW_DAYS - 1);
    expect(last).toBe("2026-08-03");
    expect(matchesFilter(task({ due: last }), "upcoming", TODAY)).toBe(true);
  });

  it("excludes the day after the window — the boundary most easily got wrong", () => {
    const past = shiftDay(TODAY, UPCOMING_WINDOW_DAYS);
    expect(past).toBe("2026-08-04");
    expect(matchesFilter(task({ due: past }), "upcoming", TODAY)).toBe(false);
  });

  it("excludes yesterday", () => {
    expect(matchesFilter(task({ due: "2026-07-27" }), "upcoming", TODAY)).toBe(false);
  });

  it("crosses a month boundary correctly", () => {
    // 28 July + 6 days is 3 August; a naive day-of-month add would give 34 July.
    expect(matchesFilter(task({ due: "2026-08-02" }), "upcoming", TODAY)).toBe(true);
  });

  it("crosses a leap-day boundary correctly", () => {
    expect(shiftDay("2028-02-26", 6)).toBe("2028-03-03");
    expect(shiftDay("2026-02-26", 6)).toBe("2026-03-04");
  });
});

describe("overdue", () => {
  it("is anything strictly before today", () => {
    expect(matchesFilter(task({ due: "2026-07-27" }), "overdue", TODAY)).toBe(true);
    expect(matchesFilter(task({ due: TODAY }), "overdue", TODAY)).toBe(false);
  });

  it("never contains a completed task, however old", () => {
    // Otherwise finishing something late would leave it in the backlog forever.
    expect(matchesFilter(task({ due: "2020-01-01", completed: true }), "overdue", TODAY)).toBe(
      false,
    );
  });

  it("counts independently of the selected filter", () => {
    const tasks = [
      task({ due: "2026-07-01" }),
      task({ due: "2026-07-02" }),
      task({ due: "2026-07-02", completed: true }),
      task({ due: TODAY }),
      task({}),
    ];
    expect(overdueCount(tasks, TODAY)).toBe(2);
  });
});

describe("all", () => {
  it("includes undated tasks — the only filter that does", () => {
    expect(matchesFilter(task({}), "all", TODAY)).toBe(true);
    for (const f of ["today", "upcoming", "overdue"] as const) {
      expect(matchesFilter(task({}), f, TODAY)).toBe(false);
    }
  });

  it("includes completed and overdue alike", () => {
    expect(matchesFilter(task({ due: "2020-01-01", completed: true }), "all", TODAY)).toBe(true);
  });
});

describe("sort", () => {
  it("is date ascending with undated last", () => {
    const sorted = sortTasks([
      task({ noteId: "c" }),
      task({ noteId: "b", due: "2026-08-05" }),
      task({ noteId: "a", due: "2026-07-01" }),
    ]);
    expect(sorted.map((t) => t.noteId)).toEqual(["a", "b", "c"]);
  });

  it("files a wire-`null` task last, the same as a genuinely undated one", () => {
    // Reaches `taskDate` from inside the comparator rather than directly — a
    // path the axis test above does not exercise, and the one that runs on every
    // surface before a row is ever rendered.
    const sorted = sortTasks([
      task({ noteId: "c", due: null, remind: null } as unknown as Partial<VaultTask>),
      task({ noteId: "a", due: "2026-07-01" }),
    ]);
    expect(sorted.map((t) => t.noteId)).toEqual(["a", "c"]);
  });

  it("breaks a date tie by priority, most urgent first", () => {
    const sorted = sortTasks([
      task({ noteId: "low", due: TODAY, priority: "low" }),
      task({ noteId: "highest", due: TODAY, priority: "highest" }),
      task({ noteId: "none", due: TODAY }),
      task({ noteId: "medium", due: TODAY, priority: "medium" }),
    ]);
    expect(sorted.map((t) => t.noteId)).toEqual(["highest", "medium", "low", "none"]);
  });

  it("breaks a date-and-priority tie by source note", () => {
    const sorted = sortTasks([
      task({ noteId: "2", noteTitle: "Zebra", due: TODAY }),
      task({ noteId: "1", noteTitle: "Apple", due: TODAY }),
    ]);
    expect(sorted.map((t) => t.noteTitle)).toEqual(["Apple", "Zebra"]);
  });

  it("is TOTAL — two otherwise-identical tasks keep a stable order", () => {
    // Without a final tiebreak, rows alike in every visible way can swap places
    // between renders, which reads as the list twitching.
    const a = task({ noteId: "n", noteTitle: "N", due: TODAY, lineIndex: 9 });
    const b = task({ noteId: "n", noteTitle: "N", due: TODAY, lineIndex: 2 });
    expect(sortTasks([a, b]).map((t) => t.lineIndex)).toEqual([2, 9]);
    expect(sortTasks([b, a]).map((t) => t.lineIndex)).toEqual([2, 9]);
  });

  it("does not mutate its input — the shared cached list is frozen", () => {
    const input = Object.freeze([
      task({ noteId: "b", due: "2026-08-05" }),
      task({ noteId: "a", due: "2026-07-01" }),
    ]);
    expect(() => sortTasks(input)).not.toThrow();
    expect(input[0]!.noteId).toBe("b");
  });

  it("does not group — the flat order answers 'what is next' directly", () => {
    // A grouped list would emit today's tasks before an overdue one; a flat
    // date-ascending list does not.
    const sorted = filterAndSortTasks(
      [task({ noteId: "today", due: TODAY }), task({ noteId: "old", due: "2026-01-01" })],
      "all",
      TODAY,
    );
    expect(sorted.map((t) => t.noteId)).toEqual(["old", "today"]);
  });
});

describe("the clock is injected", () => {
  it("todayLocal formats the LOCAL calendar day", () => {
    // Local, not UTC: "today" is the user's today. A UTC read would show
    // tomorrow's list to anyone east of Greenwich after their evening.
    const at = new Date(2026, 6, 28, 23, 30);
    expect(todayLocal(at)).toBe("2026-07-28");
  });

  it("pads single-digit months and days", () => {
    expect(todayLocal(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("no filter reads an ambient clock — every one takes `today`", () => {
    // Structural: the same task lands in different filters purely by moving the
    // injected day, with nothing else changed.
    const t = task({ due: "2026-07-28" });
    expect(matchesFilter(t, "today", "2026-07-28")).toBe(true);
    expect(matchesFilter(t, "overdue", "2026-07-29")).toBe(true);
    expect(matchesFilter(t, "upcoming", "2026-07-27")).toBe(true);
  });
});
