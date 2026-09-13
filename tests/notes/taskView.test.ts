// The vault-wide panel's view model (myne-md/myne#656, folded).
//
// The behaviours worth pinning are the ones the old four-tab model could not
// express: attention-first section order, an independent completion axis, a
// single Done section ordered by when it was completed, and a per-axis filter
// set that does not drift from the query engine's predicates.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_VIEW,
  distinctFolders,
  dueSection,
  matchesView,
  partitionTasks,
  type TaskView,
} from "../../src/notes/taskView";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string; lineIndex?: number | null }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Note",
    noteFolder: null,
    lineIndex: over.lineIndex ?? 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

const view = (over: Partial<TaskView> = {}): TaskView => ({ ...DEFAULT_TASK_VIEW, ...over });
const noTags = () => [] as readonly string[];

describe("dueSection", () => {
  it("buckets by attention, mutually exclusively", () => {
    expect(dueSection(undefined, TODAY)).toBe("none");
    expect(dueSection("2026-07-01", TODAY)).toBe("overdue");
    expect(dueSection(TODAY, TODAY)).toBe("today");
    expect(dueSection("2026-07-30", TODAY)).toBe("upcoming");
    expect(dueSection("2026-09-01", TODAY)).toBe("later");
  });
});

describe("matchesView", () => {
  it("filters completion independently of the date axis", () => {
    const done = task({ completed: true });
    const open = task({});
    expect(matchesView(done, view({ status: "undone" }), TODAY)).toBe(false);
    expect(matchesView(done, view({ status: "done" }), TODAY)).toBe(true);
    expect(matchesView(open, view({ status: "done" }), TODAY)).toBe(false);
    expect(matchesView(open, view({ status: "all" }), TODAY)).toBe(true);
  });

  it("narrows the due axis", () => {
    expect(matchesView(task({ due: "2026-07-01" }), view({ due: "overdue" }), TODAY)).toBe(true);
    expect(matchesView(task({ due: "2026-07-01" }), view({ due: "today" }), TODAY)).toBe(false);
    expect(matchesView(task({}), view({ due: "none" }), TODAY)).toBe(true);
    expect(matchesView(task({}), view({ due: "any" }), TODAY)).toBe(true);
  });

  it("narrows by priority", () => {
    expect(matchesView(task({ priority: "high" }), view({ priority: "high" }), TODAY)).toBe(true);
    expect(matchesView(task({ priority: "low" }), view({ priority: "high" }), TODAY)).toBe(false);
  });
});

describe("partitionTasks", () => {
  const spread = () => [
    task({ noteId: "a", lineIndex: 0, due: "2026-07-01" }),
    task({ noteId: "b", lineIndex: 0, due: TODAY }),
    task({ noteId: "c", lineIndex: 0, due: "2026-07-30" }),
    task({ noteId: "d", lineIndex: 0, due: "2026-09-01" }),
    task({ noteId: "e", lineIndex: 0 }),
  ];

  it("orders sections attention-first", () => {
    const keys = partitionTasks(spread(), view(), TODAY, noTags).map((s) => s.key);
    expect(keys).toEqual(["overdue", "today", "upcoming", "later", "none"]);
  });

  it("keeps completed tasks out of the date sections and in one Done section", () => {
    const tasks = [
      ...spread(),
      task({ noteId: "z", lineIndex: 0, completed: true, due: "2026-07-01", done: "2026-07-10" }),
    ];
    const sections = partitionTasks(tasks, view({ status: "all" }), TODAY, noTags);
    expect(sections.at(-1)?.key).toBe("done");
    expect(sections.at(-1)?.tasks).toHaveLength(1);
    // Not duplicated into Overdue.
    expect(sections.find((s) => s.key === "overdue")?.tasks).toHaveLength(1);
  });

  it("status=undone hides Done entirely", () => {
    const tasks = [task({ completed: true, done: "2026-07-10" })];
    expect(partitionTasks(tasks, view({ status: "undone" }), TODAY, noTags)).toEqual([]);
  });

  it("status=done shows only the Done section", () => {
    const tasks = [task({}), task({ noteId: "b", completed: true, done: "2026-07-10" })];
    const sections = partitionTasks(tasks, view({ status: "done" }), TODAY, noTags);
    expect(sections.map((s) => s.key)).toEqual(["done"]);
  });

  it("orders Done newest completion first, undated completions last", () => {
    const tasks = [
      task({ noteId: "old", completed: true, done: "2026-01-01" }),
      task({ noteId: "new", completed: true, done: "2026-07-01" }),
      task({ noteId: "none", completed: true }),
    ];
    const done = partitionTasks(tasks, view({ status: "done" }), TODAY, noTags)[0]!;
    expect(done.tasks.map((t) => t.noteId)).toEqual(["new", "old", "none"]);
  });

  it("orders within a section by the chosen axis, not only by date", () => {
    const tasks = [
      task({ noteId: "a", lineIndex: 0, due: "2026-07-01", priority: "low" }),
      task({ noteId: "b", lineIndex: 0, due: "2026-07-02", priority: "highest" }),
    ];
    const byPriority = partitionTasks(tasks, view({ sort: "priority" }), TODAY, noTags)[0]!;
    expect(byPriority.tasks.map((t) => t.noteId)).toEqual(["b", "a"]);
    const byDue = partitionTasks(tasks, view({ sort: "due" }), TODAY, noTags)[0]!;
    expect(byDue.tasks.map((t) => t.noteId)).toEqual(["a", "b"]);
    const byDueDesc = partitionTasks(tasks, view({ sort: "dueDesc" }), TODAY, noTags)[0]!;
    expect(byDueDesc.tasks.map((t) => t.noteId)).toEqual(["b", "a"]);
  });

  it("filters by note id — the 'separate by file' the tabs could not express", () => {
    const tasks = [task({ noteId: "a" }), task({ noteId: "b" })];
    const sections = partitionTasks(tasks, view({ noteId: "a" }), TODAY, noTags);
    expect(sections.flatMap((s) => s.tasks).map((t) => t.noteId)).toEqual(["a"]);
  });

  it("filters by search over the displayed text", () => {
    const tasks = [
      task({ noteId: "a", rawLine: "- [ ] pay the rent" }),
      task({ noteId: "b", rawLine: "- [ ] buy milk" }),
    ];
    const sections = partitionTasks(tasks, view(), TODAY, noTags, "MILK");
    expect(sections.flatMap((s) => s.tasks).map((t) => t.noteId)).toEqual(["b"]);
  });
});

describe("distinctFolders", () => {
  it("lists the present folders once, sorted", () => {
    const tasks = [
      task({ noteFolder: "Work" }),
      task({ noteFolder: "Archive" }),
      task({ noteFolder: "Work" }),
      task({ noteFolder: null }),
    ];
    expect(distinctFolders(tasks)).toEqual(["Archive", "Work"]);
  });
});
