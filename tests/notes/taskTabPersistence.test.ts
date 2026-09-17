// Task-tab view persistence (MYND-616 task 9; view redesigned myne-md/myne#656).
//
// The view (filters + sort) rides the **workspace descriptor**, per tab. Not a
// preference: "which filter am I looking at" is where the user is, and riding
// the descriptor also avoids the roughly thirteen-site preference registration
// surface.
//
// The descriptor is opaque to the storage codec, so none of this is a protocol
// change. What the tests pin is the two properties that make that safe:
// **omit-when-default**, so an untouched task tab serializes byte-identical to
// one written before this existed, and **degrade-don't-error**, so junk or a
// future build's value cannot reject the whole blob and lose every open tab.

import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  openInFocusedTab,
  setTaskViewState,
  taskViewOf,
  tasksItem,
  TASKS_TAB_ID,
  parseItemKey,
  itemKey,
  type WorkspaceItem,
  type WorkspaceState,
} from "../../src/notes/workspaceState";
import { DEFAULT_TASK_VIEW, type TaskView } from "../../src/notes/taskView";
import { deserializeWorkspace, serializeWorkspace } from "../../src/lib/workspace-persist";

function withTasksTab(): WorkspaceState {
  return openInFocusedTab(emptyWorkspace("p1"), tasksItem());
}

/** The task tab as it stands in `state`'s focused pane. */
function tab(state: WorkspaceState): Record<string, unknown> {
  const leaf = state.root as { tabs: Array<Record<string, unknown>> };
  return leaf.tabs.find((t) => t.kind === "tasks")!;
}

function roundTrip(state: WorkspaceState): WorkspaceState {
  const parsed = deserializeWorkspace(serializeWorkspace(state));
  if (parsed === null) throw new Error("workspace failed to round-trip");
  return parsed;
}

const view = (over: Partial<TaskView> = {}): TaskView => ({ ...DEFAULT_TASK_VIEW, ...over });

describe("the tab kind itself", () => {
  it("is a singleton, like the graph", () => {
    const twice = openInFocusedTab(withTasksTab(), tasksItem());
    const leaf = twice.root as { tabs: unknown[] };
    expect(leaf.tabs.filter((t) => (t as { kind: string }).kind === "tasks")).toHaveLength(1);
  });

  it("round-trips through its item key", () => {
    expect(parseItemKey(itemKey(tasksItem()))).toEqual({ kind: "tasks", id: TASKS_TAB_ID });
  });
});

describe("omit-when-default", () => {
  it("a fresh task tab carries no view key", () => {
    expect(tab(withTasksTab()).taskView).toBeUndefined();
  });

  it("a non-default field writes the view; the default drops the whole key", () => {
    let s = setTaskViewState(withTasksTab(), "p1", view({ sort: "priority" }));
    expect(tab(s).taskView).toEqual({ sort: "priority" });
    s = setTaskViewState(s, "p1", view());
    expect(tab(s).taskView).toBeUndefined();
  });

  it("an empty tag list is omitted, not persisted as []", () => {
    const s = setTaskViewState(withTasksTab(), "p1", view({ folders: ["Projects"], tags: [] }));
    expect(tab(s).taskView).toEqual({ folders: ["Projects"] });
  });
});

describe("state survives a restart", () => {
  it("every axis round-trips", () => {
    const s = setTaskViewState(
      withTasksTab(),
      "p1",
      view({
        status: "all",
        due: "upcoming",
        folders: ["Projects"],
        noteId: "n7",
        priority: "high",
        sort: "note",
      }),
    );
    expect(taskViewOf(tab(roundTrip(s)) as unknown as WorkspaceItem)).toEqual({
      status: "all",
      due: "upcoming",
      folders: ["Projects"],
      noteId: "n7",
      tags: [],
      priority: "high",
      sort: "note",
    });
  });

  it("a default-state tab round-trips carrying no view key", () => {
    expect(tab(roundTrip(withTasksTab())).taskView).toBeUndefined();
  });
});

describe("state is per tab, not global", () => {
  it("applying to a missing pane changes nothing", () => {
    const s = setTaskViewState(withTasksTab(), "p1", view({ sort: "priority" }));
    const other = setTaskViewState(s, "does-not-exist", view({ sort: "note" }));
    expect(tab(other).taskView).toEqual({ sort: "priority" });
  });
});

describe("an unknown persisted value degrades to the default", () => {
  const blob = (taskView: unknown, legacy: Record<string, unknown> = {}): string =>
    JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [{ kind: "tasks", id: "tasks", taskView, ...legacy }],
        activeTab: { kind: "tasks", id: "tasks" },
      },
      focusedPaneId: "p1",
    });

  it("a value this build does not know becomes the default", () => {
    const parsed = deserializeWorkspace(blob({ status: "this-week", sort: "nonsense" }));
    expect(parsed).not.toBeNull();
    expect(tab(parsed!).taskView).toBeUndefined();
  });

  it("junk in the view slot does not reject the workspace", () => {
    for (const junk of [42, null, "nope", [], true]) {
      const parsed = deserializeWorkspace(blob(junk));
      expect(parsed).not.toBeNull();
      expect(tab(parsed!).taskView).toBeUndefined();
    }
  });

  it("keeps the good half of a half-junk view", () => {
    const parsed = deserializeWorkspace(
      blob({ folders: ["Projects"], tags: [1, "work", null], sort: "bogus" }),
    );
    expect(taskViewOf(tab(parsed!) as unknown as WorkspaceItem)).toEqual({
      ...DEFAULT_TASK_VIEW,
      folders: ["Projects"],
      tags: ["work"],
    });
  });

  it("migrates a pre-redesign taskFilter/taskScope into the view", () => {
    // The shape an already-open tab had before the redesign: a date bucket plus
    // folder/tags. It must not silently lose its narrowing.
    const parsed = deserializeWorkspace(blob(undefined, { taskFilter: "upcoming", taskScope: { folder: "Projects", tags: ["work"] } }));
    expect(taskViewOf(tab(parsed!) as unknown as WorkspaceItem)).toEqual({
      ...DEFAULT_TASK_VIEW,
      due: "upcoming",
      folders: ["Projects"],
      tags: ["work"],
    });
  });
});

describe("no preference field was added", () => {
  it("the task view lives in the descriptor, not prefs", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/prefs.ts", "utf-8");
    expect(src).not.toContain("task_filter");
    expect(src).not.toContain("task_scope");
    expect(src).not.toContain("task_view");
  });
});
