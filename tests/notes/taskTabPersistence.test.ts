// Task-tab state persistence (MYND-616 task 9).
//
// Filter and scope ride the **workspace descriptor**, per tab. Not a preference:
// preferences are for stated choices like theme and auto-lock, and "which filter
// am I looking at" is where the user is. Riding the descriptor also avoids the
// roughly thirteen-site preference registration surface — of which the
// specification roster is the one nothing verifies.
//
// The descriptor is opaque to the storage codec, so none of this is a protocol
// change. What the tests below actually pin is the two properties that make that
// safe: **omit-when-default**, so an untouched task tab serializes
// byte-identical to one written before this existed, and **degrade-don't-error**,
// so junk or a future build's filter name cannot reject the whole blob and lose
// every open tab.

import { describe, expect, it } from "vitest";
import {
  emptyWorkspace,
  openInFocusedTab,
  setTaskTabState,
  tasksItem,
  TASKS_TAB_ID,
  parseItemKey,
  itemKey,
  type WorkspaceState,
} from "../../src/notes/workspaceState";
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
  it("a fresh task tab carries neither key", () => {
    // Byte-identical to a descriptor written before this feature existed.
    const t = tab(withTasksTab());
    expect(t.taskFilter).toBeUndefined();
    expect(t.taskScope).toBeUndefined();
  });

  it("selecting the default filter DROPS the key rather than writing it", () => {
    let s = setTaskTabState(withTasksTab(), "p1", { filter: "overdue" });
    expect(tab(s).taskFilter).toBe("overdue");
    s = setTaskTabState(s, "p1", { filter: "today" });
    expect(tab(s).taskFilter).toBeUndefined();
  });

  it("clearing the scope drops the key entirely", () => {
    let s = setTaskTabState(withTasksTab(), "p1", { folder: "Projects", tags: ["work"] });
    expect(tab(s).taskScope).toEqual({ folder: "Projects", tags: ["work"] });
    s = setTaskTabState(s, "p1", { folder: null, tags: [] });
    expect(tab(s).taskScope).toBeUndefined();
  });

  it("an empty tag list is omitted, not persisted as []", () => {
    const s = setTaskTabState(withTasksTab(), "p1", { folder: "Projects", tags: [] });
    expect(tab(s).taskScope).toEqual({ folder: "Projects" });
  });
});

describe("state survives a restart", () => {
  it("filter and scope both round-trip", () => {
    const s = setTaskTabState(withTasksTab(), "p1", {
      filter: "upcoming",
      folder: "Projects",
      tags: ["work", "home"],
    });
    const back = tab(roundTrip(s));
    expect(back.taskFilter).toBe("upcoming");
    expect(back.taskScope).toEqual({ folder: "Projects", tags: ["work", "home"] });
  });

  it("a default-state tab round-trips carrying neither key", () => {
    expect(tab(roundTrip(withTasksTab())).taskFilter).toBeUndefined();
    expect(tab(roundTrip(withTasksTab())).taskScope).toBeUndefined();
  });

  it("partial updates preserve the other half", () => {
    let s = setTaskTabState(withTasksTab(), "p1", { folder: "Projects" });
    s = setTaskTabState(s, "p1", { filter: "all" });
    expect(tab(s).taskScope).toEqual({ folder: "Projects" });
    expect(tab(s).taskFilter).toBe("all");
  });
});

describe("state is per tab, not global", () => {
  it("a second pane's task tab is untouched", () => {
    // Two panes each showing a task list must not fight over one setting.
    const s = setTaskTabState(withTasksTab(), "p1", { filter: "overdue" });
    // Applying to a pane id that does not exist changes nothing.
    const other = setTaskTabState(s, "does-not-exist", { filter: "all" });
    expect(tab(other).taskFilter).toBe("overdue");
  });

  it("leaves non-task tabs alone", () => {
    const s = setTaskTabState(withTasksTab(), "p1", { filter: "overdue" });
    const leaf = s.root as { tabs: Array<Record<string, unknown>> };
    for (const t of leaf.tabs) {
      if (t.kind !== "tasks") expect(t.taskFilter).toBeUndefined();
    }
  });
});

describe("an unknown persisted value degrades to the default", () => {
  const blob = (taskFilter: unknown, taskScope?: unknown): string =>
    JSON.stringify({
      root: {
        kind: "leaf",
        id: "p1",
        tabs: [{ kind: "tasks", id: "tasks", taskFilter, taskScope }],
        activeTab: { kind: "tasks", id: "tasks" },
      },
      focusedPaneId: "p1",
    });

  it("a filter name this build does not know becomes the default", () => {
    // A future build might write `"this-week"`. Rejecting the blob would lose
    // every open tab over one unknown string.
    const parsed = deserializeWorkspace(blob("this-week"));
    expect(parsed).not.toBeNull();
    expect(tab(parsed!).taskFilter).toBeUndefined();
  });

  it("junk in the filter slot does not reject the workspace", () => {
    for (const junk of [42, null, {}, [], true]) {
      const parsed = deserializeWorkspace(blob(junk));
      expect(parsed).not.toBeNull();
      expect(tab(parsed!).taskFilter).toBeUndefined();
    }
  });

  it("junk in the scope slot degrades to the unset scope", () => {
    for (const junk of ["nope", 7, [], { folder: 5 }, { tags: "work" }]) {
      const parsed = deserializeWorkspace(blob("all", junk));
      expect(parsed).not.toBeNull();
      expect(tab(parsed!).taskScope).toBeUndefined();
    }
  });

  it("keeps the good half of a half-junk scope", () => {
    const parsed = deserializeWorkspace(blob("all", { folder: "Projects", tags: [1, "work", null] }));
    expect(tab(parsed!).taskScope).toEqual({ folder: "Projects", tags: ["work"] });
  });

  it("no preference field was added", async () => {
    // The whole reason this rides the descriptor: a preference would need
    // registration at roughly thirteen sites, one of which (the specification
    // roster) nothing verifies. Read the prefs module's source and assert no
    // task-panel key appears in it.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/prefs.ts", "utf-8");
    expect(src).not.toContain("task_filter");
    expect(src).not.toContain("task_scope");
    expect(src).not.toContain("tasks_filter");
  });
});
