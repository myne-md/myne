// @vitest-environment jsdom
//
// The task list body (MYND-616 tasks 4–7).
//
// The claim under test is "one component with a scope parameter": the same body
// renders both surfaces, and the only differences are the ones `scope` and the
// supplied list produce. So the tests render it twice and compare.
//
// The empty states get more attention than their size suggests, because the
// **tone is a constraint** — no celebration, no green check — and because the
// rebuilding state being distinct from a genuinely empty one is the difference
// between "still reading" and "your tasks are gone".

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { TaskListPanel } from "../../src/notes/components/TaskListPanel";
import { EMPTY_SCOPE } from "../../src/notes/taskScope";
import type { VaultTask } from "../../src/notes/taskIndex";

const TODAY = "2026-07-28";

function task(over: Partial<VaultTask> & { noteId?: string }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 0,
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
      scope={EMPTY_SCOPE}
      filter="today"
      today={TODAY}
      rowScope="vault"
      onFilterChange={() => {}}
      {...over}
    />
  );
}

describe("the filter strip", () => {
  it("offers all four filters and marks the selected one", () => {
    const { host, cleanup } = render(panel());
    for (const f of ["today", "upcoming", "overdue", "all"]) {
      expect(q(host, `tasks.filter.${f}`)).not.toBeNull();
    }
    expect(q(host, "tasks.filter.today")?.getAttribute("aria-selected")).toBe("true");
    expect(q(host, "tasks.filter.all")?.getAttribute("aria-selected")).toBe("false");
    cleanup();
  });

  it("reports a filter change rather than owning the state", () => {
    const onFilterChange = vi.fn();
    const { host, cleanup } = render(panel({ onFilterChange }));
    act(() =>
      q(host, "tasks.filter.overdue")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onFilterChange).toHaveBeenCalledWith("overdue");
    cleanup();
  });
});

describe("the overdue count (task 6)", () => {
  it("shows the count on the overdue tab", () => {
    const { host, cleanup } = render(
      panel({ tasks: [task({ due: "2026-07-01" }), task({ due: "2026-07-02" })] }),
    );
    expect(q(host, "tasks.overdueCount")?.textContent).toBe("2");
    cleanup();
  });

  it("is ABSENT rather than zero when nothing is overdue", () => {
    // A "0" is a statement about the backlog the user did not ask for.
    const { host, cleanup } = render(panel({ tasks: [task({ due: TODAY })] }));
    expect(q(host, "tasks.overdueCount")).toBeNull();
    cleanup();
  });

  it("counts the whole scoped set, not the visible filter", () => {
    // The badge's entire job is to answer "how much is behind" WHILE the user
    // looks at Today. Counting the visible list would make it always zero there.
    const { host, cleanup } = render(
      panel({ filter: "today", tasks: [task({ due: TODAY }), task({ due: "2026-01-01" })] }),
    );
    expect(q(host, "tasks.overdueCount")?.textContent).toBe("1");
    cleanup();
  });

  it("is a muted numeral, not an alarm-coloured badge", () => {
    const { host, cleanup } = render(panel({ tasks: [task({ due: "2026-07-01" })] }));
    const count = q(host, "tasks.overdueCount")!;
    expect(count.style.color).toContain("--fg-3");
    expect(count.style.color).not.toContain("--danger");
    expect(count.style.background).toBe("");
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
    // The note-scoped surface hides the source note — you are looking at it.
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

describe("rows", () => {
  it("renders the task's description, with marker and fields stripped", () => {
    const { host, cleanup } = render(
      panel({ tasks: [task({ due: TODAY, rawLine: "- [ ] pay the rent [due:: 2026-07-28]" })] }),
    );
    expect(q(host, "tasks.row.text")?.textContent).toBe("pay the rent");
    cleanup();
  });

  it("renders a note-task using its note title", () => {
    // A note-task has no line; the note IS the task.
    const { host, cleanup } = render(
      panel({
        filter: "all",
        tasks: [task({ lineIndex: null, rawLine: "", noteTitle: "Ship the release" })],
      }),
    );
    expect(q(host, "tasks.row.text")?.textContent).toBe("Ship the release");
    cleanup();
  });

  it("sorts by date ascending", () => {
    const { host, cleanup } = render(
      panel({
        filter: "all",
        tasks: [
          task({ noteId: "b", due: "2026-08-05", rawLine: "- [ ] later" }),
          task({ noteId: "a", due: "2026-07-01", rawLine: "- [ ] earlier" }),
        ],
      }),
    );
    expect(all(host, "tasks.row.text").map((n) => n.textContent)).toEqual([
      "earlier",
      "later",
    ]);
    cleanup();
  });

  it("renders an undated task whose dates arrived as wire `null` (the All filter)", () => {
    // The reported crash, at the layer that caused it (myne-md/myne-mobile#36).
    // `all` is deliberately the filter here and not an incidental choice: it is
    // the ONLY one that reaches a row without passing the null-safe `taskDate`
    // first (`matchesFilter` short-circuits on it), so it is the only filter an
    // undated task appears under — and therefore the only one that ever handed
    // `TaskRow` a `null` to slice.
    const { host, cleanup } = render(
      panel({
        filter: "all",
        tasks: [
          task({
            due: null,
            remind: null,
            repeat: null,
            priority: null,
            rawLine: "- [ ] buy bread",
          } as unknown as Partial<VaultTask>),
        ],
      }),
    );
    expect(q(host, "tasks.row.text")?.textContent).toBe("buy bread");
    // The projection strips the nulls rather than copying them into the row, so
    // there is no date chip — not an empty one.
    expect(all(host, "tasks.row.due")).toHaveLength(0);
    cleanup();
  });

  it("reports a toggle with the INDEX record, not the row projection", () => {
    // The writer needs `rawLine` and `lineIndex` to verify and patch; the row
    // projection carries neither.
    const onToggle = vi.fn();
    const target = task({ due: TODAY });
    const { host, cleanup } = render(panel({ tasks: [target], onToggle }));
    act(() =>
      q(host, "tasks.row.checkbox")!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onToggle).toHaveBeenCalledWith(target);
    cleanup();
  });
});

describe("the four empty states (task 7)", () => {
  it("no tasks in the vault at all — and it says how to make one", () => {
    const { host, cleanup } = render(panel({ tasks: [] }));
    const empty = q(host, "tasks.empty.vault");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("- [ ]");
    cleanup();
  });

  it("nothing in this filter", () => {
    const { host, cleanup } = render(
      panel({ filter: "today", tasks: [task({ due: "2026-12-31" })] }),
    );
    expect(q(host, "tasks.empty.filter")).not.toBeNull();
    cleanup();
  });

  it("nothing in this scope — and it suggests widening", () => {
    const { host, cleanup } = render(
      panel({
        filter: "all",
        scope: { folder: "Projects", tags: [] },
        tasks: [task({ noteFolder: "Personal" })],
      }),
    );
    const empty = q(host, "tasks.empty.scope");
    expect(empty).not.toBeNull();
    expect(empty!.textContent!.toLowerCase()).toContain("widen");
    cleanup();
  });

  it("rebuilding is distinct from a genuinely empty result", () => {
    // Showing "no tasks" while the index is still building is a wrong answer
    // presented as a finished one — the user concludes their tasks are gone.
    const { host, cleanup } = render(panel({ tasks: [], rebuilding: true }));
    expect(q(host, "tasks.empty.rebuilding")).not.toBeNull();
    expect(q(host, "tasks.empty.vault")).toBeNull();
    cleanup();
  });

  it("rebuilding wins even when a stale list would render", () => {
    const { host, cleanup } = render(panel({ rebuilding: true }));
    expect(q(host, "tasks.empty.rebuilding")).not.toBeNull();
    expect(q(host, "tasks.row.row")).toBeNull();
    cleanup();
  });

  it("all four states are distinguishable", () => {
    const kinds = new Set<string>();
    for (const props of [
      { tasks: [] },
      { filter: "today" as const, tasks: [task({ due: "2026-12-31" })] },
      {
        filter: "all" as const,
        scope: { folder: "Projects", tags: [] },
        tasks: [task({ noteFolder: "Personal" })],
      },
      { tasks: [], rebuilding: true },
    ]) {
      const { host, cleanup } = render(panel(props));
      const el = host.querySelector('[data-testid^="tasks.empty."]');
      kinds.add(el!.getAttribute("data-testid")!);
      cleanup();
    }
    expect(kinds.size).toBe(4);
  });

  it("no celebratory language and no green check, in any state", () => {
    // The tone rule is binding: an empty week is STATED, not celebrated.
    const forbidden =
      /all done|well done|congrat|great job|nice work|you'?re all caught up|🎉|🎊|✅|✓|✔/i;
    for (const props of [
      { tasks: [] },
      { filter: "today" as const, tasks: [task({ due: "2026-12-31" })] },
      { tasks: [], rebuilding: true },
    ]) {
      const { host, cleanup } = render(panel(props));
      expect(host.textContent ?? "").not.toMatch(forbidden);
      cleanup();
    }
  });
});
