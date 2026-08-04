// @vitest-environment jsdom
//
// The shared task row (MYND-616 task 1).
//
// Three of the four acceptance criteria are structural — where the component
// lives, which tokens it reuses, whether it takes a scope parameter — and the
// tests that can see those are the ones that assert the *consequences*: the row
// renders identical chip geometry to the editor's inline chip, and the same
// component produces two different layouts from `scope` alone.
//
// The canon rules are tested as rules, not by eye: no green anywhere, no state
// carried by a fill.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { TaskRow, type TaskRowData } from "@myne/editor/host/notes/TaskRow";
import { taskChipStyle, TASK_CHIP_TOKEN } from "@myne/editor/host/notes/taskChipToken";
import {
  DEFAULT_DISPLAY,
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "../../src/lib/datetimeFormat";

// myne#279: the row prints its date through the shared formatter now, so pin an
// explicit format rather than depending on the runner's locale. That the raw
// stored string is NO LONGER what lands on screen is the point of the change —
// it used to emit raw ISO and silently drop any time.
beforeEach(() => setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "iso" }));
afterEach(() => __resetDateTimeDisplayForTest());

const TASK: TaskRowData = {
  key: "n1:3",
  text: "pay the rent",
  completed: false,
  noteTitle: "Bills",
  due: "2026-08-01",
};

const TODAY = "2026-07-28";

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

function byTestId(host: HTMLElement, id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}

describe("everything the row must show", () => {
  it("renders checkbox, text, due chip and source note", () => {
    const { host, cleanup } = render(<TaskRow task={TASK} scope="vault" today={TODAY} />);
    expect(byTestId(host, "task-row.checkbox")).not.toBeNull();
    expect(byTestId(host, "task-row.text")?.textContent).toBe("pay the rent");
    expect(byTestId(host, "task-row.due")?.textContent).toBe("2026-08-01");
    expect(byTestId(host, "task-row.note")?.textContent).toBe("Bills");
    cleanup();
  });

  it("files a reminder-only task on its reminder date", () => {
    // Without the fallback a task carrying only a reminder reads as undated and
    // vanishes from every dated view — the case absolute reminders exist for.
    const { host, cleanup } = render(
      <TaskRow
        task={{ ...TASK, due: undefined, remind: "2026-08-05" }}
        scope="vault"
        today={TODAY}
      />,
    );
    expect(byTestId(host, "task-row.due")?.textContent).toBe("2026-08-05");
    cleanup();
  });

  it("shows no date chip at all for an undated task", () => {
    const { host, cleanup } = render(
      <TaskRow task={{ ...TASK, due: undefined }} scope="vault" today={TODAY} />,
    );
    expect(byTestId(host, "task-row.due")).toBeNull();
    cleanup();
  });

  it("treats a wire `null` date as undated — no chip, and no crash", () => {
    // `TaskRowData` promises optional-or-absent, but the `MYI1` row serializes
    // `Option<String>` as `null`, so a client whose fetch skipped the
    // `taskWire.ts` decoder hands one down. `undefined ?? null` is `null`, which
    // a `=== undefined` guard misses — the row then slices a non-string and
    // takes the whole subtree down (myne-md/myne-mobile#36). Rendering at all is
    // half of what this asserts.
    const { host, cleanup } = render(
      <TaskRow
        task={{ ...TASK, due: null, remind: null } as unknown as TaskRowData}
        scope="vault"
        today={TODAY}
      />,
    );
    expect(byTestId(host, "task-row.text")?.textContent).toBe("pay the rent");
    expect(byTestId(host, "task-row.due")).toBeNull();
    cleanup();
  });
});

describe("scope decides context, not the caller", () => {
  it("hides the source note in note scope and shows it in vault scope", () => {
    const noteScoped = render(<TaskRow task={TASK} scope="note" today={TODAY} />);
    expect(byTestId(noteScoped.host, "task-row.note")).toBeNull();
    noteScoped.cleanup();

    const vaultScoped = render(<TaskRow task={TASK} scope="vault" today={TODAY} />);
    expect(byTestId(vaultScoped.host, "task-row.note")).not.toBeNull();
    vaultScoped.cleanup();
  });

  it("query scope behaves as vault scope — three mount points, one component", () => {
    const { host, cleanup } = render(<TaskRow task={TASK} scope="query" today={TODAY} />);
    expect(byTestId(host, "task-row.note")).not.toBeNull();
    expect(byTestId(host, "task-row.row")?.getAttribute("data-task-scope")).toBe("query");
    cleanup();
  });
});

describe("the chip token is reused, not restated", () => {
  it("the row's date chip carries the shared token's geometry", () => {
    // The criterion is "reuses the existing chip tokens rather than redefining
    // them"; the observable consequence is identical geometry. If someone
    // hand-rolled a second look, these stop matching.
    const { host, cleanup } = render(<TaskRow task={TASK} scope="vault" today={TODAY} />);
    const chip = byTestId(host, "task-row.due")!;
    const token = taskChipStyle();
    expect(chip.style.borderRadius).toBe(String(token.borderRadius));
    expect(chip.style.fontSize).toBe(`${TASK_CHIP_TOKEN.fontSize}px`);
    expect(chip.style.background).toContain("--paper-2");
    cleanup();
  });
});

describe("canon rules are constraints", () => {
  it("a completed row uses a filled neutral box and struck text — never a green check", () => {
    const { host, cleanup } = render(
      <TaskRow task={{ ...TASK, completed: true }} scope="vault" today={TODAY} />,
    );
    const box = byTestId(host, "task-row.checkbox")!;
    const text = byTestId(host, "task-row.text")!;
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(text.style.textDecoration).toBe("line-through");
    // No tick glyph, and nothing green anywhere in the row.
    expect(host.innerHTML).not.toMatch(/✓|✔|&#10003;/);
    expect(host.innerHTML.toLowerCase()).not.toContain("green");
    expect(host.innerHTML).not.toMatch(/--(success|ok|positive)\b/);
    cleanup();
  });

  it("overdue is coloured TEXT, never a fill", () => {
    const { host, cleanup } = render(
      <TaskRow task={{ ...TASK, due: "2026-07-01" }} scope="vault" today={TODAY} />,
    );
    const chip = byTestId(host, "task-row.due")!;
    expect(chip.getAttribute("data-overdue")).toBe("true");
    expect(chip.style.color).toContain("--danger");
    // The fill stays neutral — the canon forbids state-as-fill.
    expect(chip.style.background).toContain("--paper-2");
    expect(chip.style.background).not.toContain("--danger");
    cleanup();
  });

  it("a completed task is never overdue, however old its date", () => {
    const { host, cleanup } = render(
      <TaskRow
        task={{ ...TASK, due: "2020-01-01", completed: true }}
        scope="vault"
        today={TODAY}
      />,
    );
    expect(byTestId(host, "task-row.due")?.getAttribute("data-overdue")).toBeNull();
    cleanup();
  });

  it("today is not overdue — the boundary, asserted rather than assumed", () => {
    const { host, cleanup } = render(
      <TaskRow task={{ ...TASK, due: TODAY }} scope="vault" today={TODAY} />,
    );
    expect(byTestId(host, "task-row.due")?.getAttribute("data-overdue")).toBeNull();
    cleanup();
  });

  it("a wire-`null` date is not overdue — the guard answers false, it does not throw", () => {
    // The undated rule and the null rule have to agree: a row with no date is
    // not late, and a row whose date arrived as `null` has no date. Asserted on
    // the whole row rather than on the chip, because the chip is absent and an
    // `?.` on it would pass whatever the row did.
    const { host, cleanup } = render(
      <TaskRow
        task={{ ...TASK, due: null, remind: null } as unknown as TaskRowData}
        scope="vault"
        today={TODAY}
      />,
    );
    expect(host.querySelector("[data-overdue]")).toBeNull();
    cleanup();
  });
});

describe("toggling", () => {
  it("calls back on click and on Space", () => {
    const onToggle = vi.fn();
    const { host, cleanup } = render(
      <TaskRow task={TASK} scope="vault" today={TODAY} onToggle={onToggle} />,
    );
    const box = byTestId(host, "task-row.checkbox")!;
    act(() => box.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggle).toHaveBeenCalledWith(TASK);

    act(() =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })),
    );
    expect(onToggle).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("an oversized record renders but refuses to be written, and says why", () => {
    // Dropping the row would make the task vanish from every surface; writing
    // it is impossible because the raw line is truncated and cannot be verified.
    const onToggle = vi.fn();
    const { host, cleanup } = render(
      <TaskRow
        task={{ ...TASK, oversized: true }}
        scope="vault"
        today={TODAY}
        onToggle={onToggle}
      />,
    );
    const box = byTestId(host, "task-row.checkbox")!;
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(box.getAttribute("title")).toBeTruthy();
    act(() => box.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggle).not.toHaveBeenCalled();
    cleanup();
  });

  it("renders inert with no toggle handler — a read-only mount", () => {
    const { host, cleanup } = render(<TaskRow task={TASK} scope="query" today={TODAY} />);
    expect(byTestId(host, "task-row.checkbox")?.getAttribute("tabindex")).toBe("-1");
    cleanup();
  });

  it("opening the source note is a real control, keyboard-reachable", () => {
    const onOpen = vi.fn();
    const { host, cleanup } = render(
      <TaskRow task={TASK} scope="vault" today={TODAY} onOpen={onOpen} />,
    );
    const note = byTestId(host, "task-row.note")!;
    expect(note.tagName).toBe("BUTTON");
    act(() => note.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onOpen).toHaveBeenCalledWith(TASK);
    cleanup();
  });
});

describe("test ids are distinguishable per mount point", () => {
  it("honours a prefix, so three surfaces do not collide", () => {
    const { host, cleanup } = render(
      <TaskRow task={TASK} scope="note" today={TODAY} testIdPrefix="notePanel.task" />,
    );
    expect(byTestId(host, "notePanel.task.row")).not.toBeNull();
    expect(byTestId(host, "notePanel.task.checkbox")).not.toBeNull();
    expect(byTestId(host, "task-row.row")).toBeNull();
    cleanup();
  });
});

// The two-line layout (MYND-620 task 6). It exists because the single-line
// alternatives each drop something: truncating the task text removes the one
// thing on the row that matters, and dropping the source note removes half the
// context in a vault-wide list. One component serves every surface, so the row
// has to work for the harder case.
describe("two-line layout at narrow width", () => {
  const LONG: TaskRowData = {
    ...TASK,
    text: "renew the buildings insurance before the policy lapses at the end of the month",
  };

  it("stacks the text above its metadata", () => {
    const { host, cleanup } = render(
      <TaskRow task={LONG} scope="vault" today={TODAY} twoLine />,
    );
    const stack = byTestId(host, "task-row.stack");
    expect(stack).not.toBeNull();
    expect(stack!.style.flexDirection).toBe("column");
    // The metadata is INSIDE the stack — that is what makes it a second line
    // rather than a third column.
    expect(stack!.contains(byTestId(host, "task-row.meta"))).toBe(true);
    cleanup();
  });

  it("wraps the task text rather than truncating it", () => {
    const { host, cleanup } = render(
      <TaskRow task={LONG} scope="vault" today={TODAY} twoLine />,
    );
    const text = byTestId(host, "task-row.text")!;
    // Every one of these would cut the text off. The whole point of two lines
    // is that none of them is needed.
    expect(text.style.whiteSpace).not.toBe("nowrap");
    expect(text.style.textOverflow).not.toBe("ellipsis");
    expect(text.style.overflow).not.toBe("hidden");
    expect(text.textContent).toBe(LONG.text);
    cleanup();
  });

  it("keeps both the date and the source note", () => {
    const { host, cleanup } = render(
      <TaskRow task={LONG} scope="vault" today={TODAY} twoLine />,
    );
    expect(byTestId(host, "task-row.due")!.textContent).toBe("2026-08-01");
    expect(byTestId(host, "task-row.note")!.textContent).toBe("Bills");
    cleanup();
  });

  it("puts the overdue indicator on the second line, as coloured text", () => {
    const overdue: TaskRowData = { ...LONG, due: "2026-07-01" };
    const { host, cleanup } = render(
      <TaskRow task={overdue} scope="vault" today={TODAY} twoLine />,
    );
    const chip = byTestId(host, "task-row.due")!;
    expect(chip.dataset.overdue).toBe("true");
    // Inside the second line, and carried by COLOUR rather than by a fill —
    // the canon forbids a status pill.
    expect(byTestId(host, "task-row.meta")!.contains(chip)).toBe(true);
    expect(chip.style.background).toBe(taskChipStyle().background);
    cleanup();
  });

  it("still shows no green check when completed", () => {
    const { host, cleanup } = render(
      <TaskRow task={{ ...LONG, completed: true }} scope="vault" today={TODAY} twoLine />,
    );
    expect(host.innerHTML).not.toMatch(/green|#0f0|✓|✔/i);
    // A filled neutral box, not a tick.
    expect(byTestId(host, "task-row.checkbox")!.textContent).toBe("");
    cleanup();
  });

  it("shows the same pieces as the single-line layout", () => {
    const two = render(<TaskRow task={LONG} scope="vault" today={TODAY} twoLine />);
    const one = render(<TaskRow task={LONG} scope="vault" today={TODAY} />);
    for (const id of ["task-row.text", "task-row.due", "task-row.note"]) {
      expect(byTestId(two.host, id)!.textContent).toBe(byTestId(one.host, id)!.textContent);
    }
    two.cleanup();
    one.cleanup();
  });
});
