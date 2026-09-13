// @vitest-environment jsdom
//
// The task list body (MYND-616; redesigned for myne-md/myne#656).
//
// The claim under test is "one component with a scope parameter": the same body
// renders both surfaces, and the only differences are the ones `rowScope` and
// the supplied list produce. The redesign adds the properties the old four-tab
// panel could not express: attention-first sections, an independent completion
// axis, a search box, nesting, and a windowed render.
//
// The empty states get attention because the **tone is a constraint** - no
// celebration, no green check - and because the rebuilding state being distinct
// from a genuinely empty one is the difference between "still reading" and
// "your tasks are gone".

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { TaskListPanel } from "../../src/notes/components/TaskListPanel";
import { DEFAULT_TASK_VIEW, type TaskView } from "../../src/notes/taskView";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string; lineIndex?: number | null }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: over.lineIndex ?? 0,
    rawLine: "- [ ] pay the rent",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

function render(node: React.ReactNode): { host: HTMLElement; cleanup: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const q = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);
const all = (host: HTMLElement, id: string): HTMLElement[] =>
  [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

function panel(over: Partial<React.ComponentProps<typeof TaskListPanel>> = {}) {
  return (
    <TaskListPanel
      tasks={[task({ due: TODAY })]}
      view={DEFAULT_TASK_VIEW}
      today={TODAY}
      rowScope="vault"
      onViewChange={() => {}}
      {...over}
    />
  );
}

const view = (over: Partial<TaskView> = {}): TaskView => ({ ...DEFAULT_TASK_VIEW, ...over });

describe("sections (myne-md/myne#656)", () => {
  it("orders sections attention-first and labels each with its count", () => {
    const { host, cleanup } = render(
      panel({
        tasks: [
          task({ noteId: "a", lineIndex: 0, due: "2026-07-01" }),
          task({ noteId: "b", lineIndex: 0, due: TODAY }),
          task({ noteId: "c", lineIndex: 0, due: "2026-07-30" }),
          task({ noteId: "d", lineIndex: 0, due: "2026-09-01" }),
          task({ noteId: "e", lineIndex: 0 }),
        ],
      }),
    );
    const sections = all(host, "tasks.section.overdue");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.textContent).toContain("1");
    for (const key of ["overdue", "today", "upcoming", "later", "none"]) {
      expect(q(host, `tasks.section.${key}`)).not.toBeNull();
    }
    cleanup();
  });

  it("keeps completed tasks out of the date sections by default", () => {
    const { host, cleanup } = render(
      panel({ tasks: [task({ due: "2026-07-01" }), task({ noteId: "z", completed: true, done: "2026-07-10" })] }),
    );
    expect(q(host, "tasks.section.overdue")).not.toBeNull();
    expect(q(host, "tasks.section.done")).toBeNull();
    cleanup();
  });

  it("shows a Done section when status is all, ordered newest first", () => {
    const { host, cleanup } = render(
      panel({
        view: view({ status: "all" }),
        tasks: [
          task({ noteId: "old", completed: true, done: "2026-01-01", rawLine: "- [x] old" }),
          task({ noteId: "new", completed: true, done: "2026-07-01", rawLine: "- [x] new" }),
        ],
      }),
    );
    expect(q(host, "tasks.section.done")).not.toBeNull();
    const texts = all(host, "tasks.row.text").map((n) => n.textContent);
    expect(texts).toEqual(["new", "old"]);
    cleanup();
  });
});

describe("the filter builder (myne-md/myne#656 review)", () => {
  const openBuilder = (host: HTMLElement): void => {
    act(() =>
      q(host, "tasks.filtersButton")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
  };

  it("keeps the toolbar to search plus a Filters button until it is opened", () => {
    const { host, cleanup } = render(panel());
    expect(q(host, "tasks.search")).not.toBeNull();
    expect(q(host, "tasks.filtersButton")).not.toBeNull();
    // The axes are NOT cluttering the toolbar.
    expect(q(host, "tasks.status")).toBeNull();
    expect(q(host, "tasks.dueFilter")).toBeNull();
    cleanup();
  });

  it("opens with the axis list only, then reveals the chosen axis's values", () => {
    const { host, cleanup } = render(panel());
    openBuilder(host);
    for (const axis of ["status", "due", "folder", "note", "tag", "priority", "sort"]) {
      expect(q(host, `tasks.builderTab.${axis}`), axis).not.toBeNull();
    }
    // Open on first open: the right pane shows the "select an axis" hint, not
    // values, until an axis is chosen.
    expect(q(host, "tasks.filtersHint")).not.toBeNull();
    expect(q(host, "tasks.builderOption.status.undone")).toBeNull();
    act(() =>
      q(host, "tasks.builderTab.status")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(q(host, "tasks.filtersHint")).toBeNull();
    expect(q(host, "tasks.builderOption.status.undone")).not.toBeNull();
    cleanup();
  });

  it("resets one axis from the builder and all of them from the header or the chip row", () => {
    const onViewChange = vi.fn();
    const { host, cleanup } = render(panel({ onViewChange, view: view({ status: "all", priority: "high" }) }));
    openBuilder(host);
    act(() =>
      q(host, "tasks.builderTab.status-reset")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onViewChange).toHaveBeenCalledWith(expect.objectContaining({ status: DEFAULT_TASK_VIEW.status }));
    onViewChange.mockClear();
    act(() =>
      q(host, "tasks.clearFiltersBuilder")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onViewChange).toHaveBeenCalledWith(DEFAULT_TASK_VIEW);
    cleanup();
  });

  it("lists an active filter as a removable chip under the search", () => {
    const onViewChange = vi.fn();
    const { host, cleanup } = render(
      panel({ onViewChange, view: view({ status: "all", priority: "high" }) }),
    );
    expect(q(host, "tasks.applied.status")).not.toBeNull();
    expect(q(host, "tasks.applied.priority")).not.toBeNull();
    expect(q(host, "tasks.filtersCount")?.textContent).toBe("2");
    act(() =>
      q(host, "tasks.applied.status")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onViewChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: DEFAULT_TASK_VIEW.status }),
    );
    cleanup();
  });

  it("minimal mode (the note-scoped panel) is search only", () => {
    const { host, cleanup } = render(panel({ minimal: true }));
    expect(q(host, "tasks.search")).not.toBeNull();
    expect(q(host, "tasks.filtersButton")).toBeNull();
    cleanup();
  });
});

describe("the search box", () => {
  function type(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("narrows to tasks whose text matches, case-insensitively", () => {
    const { host, cleanup } = render(
      panel({
        tasks: [
          task({ noteId: "a", rawLine: "- [ ] pay the rent" }),
          task({ noteId: "b", rawLine: "- [ ] buy milk" }),
        ],
      }),
    );
    type(q(host, "tasks.search") as HTMLInputElement, "MILK");
    expect(all(host, "tasks.row.text").map((n) => n.textContent)).toEqual(["buy milk"]);
    cleanup();
  });

  it("says the QUERY matched nothing, not that the vault is empty", () => {
    const { host, cleanup } = render(panel({ tasks: [task({ rawLine: "- [ ] pay the rent" })] }));
    type(q(host, "tasks.search") as HTMLInputElement, "zzz");
    expect(q(host, "tasks.empty.search")).not.toBeNull();
    expect(q(host, "tasks.empty.vault")).toBeNull();
    cleanup();
  });
});

describe("rows", () => {
  it("strips a due field that carries a time (myne-md/myne#656 review)", () => {
    const { host, cleanup } = render(
      panel({
        view: view({ status: "all" }),
        tasks: [
          task({
            due: "2026-09-13 12:30",
            rawLine: "- [ ] left ribbon implementation [due:: 2026-09-13 12:30]",
          }),
        ],
      }),
    );
    expect(q(host, "tasks.row.text")?.textContent).toBe("left ribbon implementation");
    cleanup();
  });
});

describe("nesting", () => {
  it("indents a child row under its visible parent", () => {
    const { host, cleanup } = render(
      panel({
        tasks: [
          task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] parent" }),
          task({ noteId: "n", lineIndex: 1, rawLine: "  - [ ] child" }),
        ],
      }),
    );
    const rows = all(host, "tasks.row.row");
    expect(rows[0]!.getAttribute("data-depth")).toBeNull();
    expect(rows[1]!.getAttribute("data-depth")).toBe("1");
    cleanup();
  });
});

describe("one component, two surfaces", () => {
  it("passes its scope straight through to every row", () => {
    const vault = render(panel({ rowScope: "vault" }));
    expect(q(vault.host, "tasks.row.row")?.getAttribute("data-task-scope")).toBe("vault");
    expect(q(vault.host, "tasks.row.note")).not.toBeNull();
    vault.cleanup();

    const note = render(panel({ rowScope: "note" }));
    expect(q(note.host, "tasks.row.row")?.getAttribute("data-task-scope")).toBe("note");
    expect(q(note.host, "tasks.row.note")).toBeNull();
    note.cleanup();
  });

  it("takes a test-id prefix so two mounted surfaces do not collide", () => {
    const { host, cleanup } = render(panel({ testIdPrefix: "notePanel.tasks" }));
    expect(q(host, "notePanel.tasks.panel")).not.toBeNull();
    expect(q(host, "tasks.panel")).toBeNull();
    cleanup();
  });
});

describe("the four empty states", () => {
  it("no tasks in the vault at all - and it says how to make one", () => {
    const { host, cleanup } = render(panel({ tasks: [] }));
    const empty = q(host, "tasks.empty.vault");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("- [ ]");
    cleanup();
  });

  it("nothing in this filter", () => {
    // A task exists, but the completion axis excludes it.
    const { host, cleanup } = render(
      panel({ view: view({ status: "done" }), tasks: [task({ due: "2026-12-31" })] }),
    );
    expect(q(host, "tasks.empty.filter")).not.toBeNull();
    cleanup();
  });

  it("rebuilding is distinct from a genuinely empty result", () => {
    const { host, cleanup } = render(panel({ tasks: [], rebuilding: true }));
    expect(q(host, "tasks.empty.rebuilding")).not.toBeNull();
    expect(q(host, "tasks.empty.vault")).toBeNull();
    cleanup();
  });

  it("no celebratory language and no green check, in any state", () => {
    const forbidden = /all done|well done|congrat|great job|nice work|you'?re all caught up|🎉|🎊|✅|✓|✔/i;
    for (const props of [
      { tasks: [] as VaultTask[] },
      { tasks: [task({ due: "2026-12-31" })] },
      { tasks: [] as VaultTask[], rebuilding: true },
    ]) {
      const { host, cleanup } = render(panel(props));
      expect(host.textContent ?? "").not.toMatch(forbidden);
      cleanup();
    }
  });
});
