// @vitest-environment jsdom
//
// The task-query block builder (MYND-617 task 10).
//
// This surface is the entire answer to "English-only": the roster is a
// specification artifact and translating it would cost 24 contracts, 24 vector
// sets, and a vault that stops being portable between a user's own devices — so
// keywords must never have to be memorized, only read. That makes two properties
// correctness rather than polish: the builder writes **canonical** syntax, and it
// is operable by keyboard alone.

import { describe, expect, it, vi } from "vitest";
import {
  buildQueryBlock,
  buildQueryText,
  DEFAULT_CHOICE,
  openTaskQueryBuilder,
  type QueryBuilderChoice,
} from "@myne/editor/task-query-builder";
import { parseTaskQuery } from "../../src/notes/taskQuery";

const choice = (over: Partial<QueryBuilderChoice> = {}): QueryBuilderChoice => ({
  ...DEFAULT_CHOICE,
  ...over,
});

const q = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`);

function cleanup(): void {
  document.querySelectorAll('[data-testid="editor.task-query-builder"]').forEach((n) => {
    n.parentElement?.remove();
  });
}

describe("it writes canonical syntax", () => {
  it("the default choice is a working query", () => {
    expect(buildQueryText(DEFAULT_CHOICE)).toBe("not done\nsort by due");
  });

  it("every due window maps to a roster clause", () => {
    expect(buildQueryText(choice({ due: "overdue" }))).toContain("due before today");
    expect(buildQueryText(choice({ due: "today" }))).toContain("due on today");
    expect(buildQueryText(choice({ due: "week" }))).toContain("due before in 1 week");
    expect(buildQueryText(choice({ due: "none" }))).toContain("no due date");
    // "any" emits no due CLAUSE. (`sort by due` legitimately contains the word,
    // so the assertion has to be about the clause, not the substring.)
    expect(buildQueryText(choice({ due: "any" }))).not.toMatch(/^(due |no due date)/m);
  });

  it("folder, tag and priority become their clauses; empty ones are omitted", () => {
    const text = buildQueryText(choice({ path: "Projects", tag: "#work", priority: "high" }));
    expect(text).toContain("path includes Projects");
    // The leading `#` is stripped — the roster's clause takes a bare tag.
    expect(text).toContain("tag includes work");
    expect(text).toContain("priority is high");
    expect(buildQueryText(choice({ path: "  ", tag: "  " }))).not.toContain("includes");
  });

  it("an explicit limit is emitted only when set", () => {
    expect(buildQueryText(choice({ limit: 0 }))).not.toContain("limit");
    expect(buildQueryText(choice({ limit: 25 }))).toContain("limit 25");
  });

  it("EVERYTHING it can emit parses back with zero dropped clauses", () => {
    // The decisive property. The builder is the reference writer, so a form it
    // emits that the parser drops would teach a syntax the spec does not freeze.
    const combos: QueryBuilderChoice[] = [];
    for (const status of ["any", "todo", "done"] as const) {
      for (const due of ["any", "overdue", "today", "week", "none"] as const) {
        for (const priority of ["any", "high", "lowest"] as const) {
          for (const sort of ["due", "priority", "path"] as const) {
            combos.push(choice({ status, due, priority, sort, path: "P", tag: "t", limit: 7 }));
          }
        }
      }
    }
    expect(combos.length).toBeGreaterThan(100);
    for (const c of combos) {
      const parsed = parseTaskQuery(buildQueryText(c));
      expect(parsed.warnings, `dropped a clause for ${JSON.stringify(c)}`).toHaveLength(0);
      expect(parsed.refused).toBe(false);
    }
  });

  it("wraps the query in a closed fence with the recognized info string", () => {
    const block = buildQueryBlock(DEFAULT_CHOICE);
    expect(block.startsWith("```tasks\n")).toBe(true);
    expect(block).toContain("\n```\n");
  });
});

describe("the surface", () => {
  it("opens with every choice as a real control", () => {
    const handle = openTaskQueryBuilder({ onInsert: () => {} });
    expect(q("editor.task-query-builder")).not.toBeNull();
    for (const id of ["status", "due", "path", "tag", "priority", "sort"]) {
      expect(q(`editor.task-query-builder.${id}`), id).not.toBeNull();
    }
    handle.close();
    cleanup();
  });

  it("shows a live preview of the canonical text — the roster taught by example", () => {
    const handle = openTaskQueryBuilder({ onInsert: () => {} });
    expect(q("editor.task-query-builder.preview")?.textContent).toBe("not done\nsort by due");

    const due = q("editor.task-query-builder.due") as HTMLSelectElement;
    due.value = "overdue";
    due.dispatchEvent(new Event("change", { bubbles: true }));
    expect(q("editor.task-query-builder.preview")?.textContent).toContain("due before today");

    handle.close();
    cleanup();
  });

  it("inserts a valid block", () => {
    const onInsert = vi.fn();
    openTaskQueryBuilder({ onInsert });
    (q("editor.task-query-builder.insert") as HTMLElement).click();

    expect(onInsert).toHaveBeenCalledTimes(1);
    const block = onInsert.mock.calls[0]![0] as string;
    expect(block.startsWith("```tasks")).toBe(true);
    // And what it inserted parses clean.
    const body = block.split("\n").slice(1, -2).join("\n");
    expect(parseTaskQuery(body).warnings).toHaveLength(0);
    cleanup();
  });

  it("is operable by keyboard alone — focus lands on the first control", () => {
    // A surface that is the only comfortable route to a feature cannot be
    // mouse-only, which is the same reason the chip editor traps focus.
    const handle = openTaskQueryBuilder({ onInsert: () => {} });
    expect(document.activeElement).toBe(q("editor.task-query-builder.status"));
    handle.close();
    cleanup();
  });

  it("every control is focusable", () => {
    const handle = openTaskQueryBuilder({ onInsert: () => {} });
    const focusables = q("editor.task-query-builder")!.querySelectorAll(
      "input, select, button",
    );
    // six choices + cancel + insert
    expect(focusables.length).toBe(8);
    handle.close();
    cleanup();
  });

  it("Escape dismisses without inserting", () => {
    const onInsert = vi.fn();
    const onCancel = vi.fn();
    openTaskQueryBuilder({ onInsert, onCancel });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onInsert).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    cleanup();
  });

  it("cancel dismisses without inserting", () => {
    const onInsert = vi.fn();
    openTaskQueryBuilder({ onInsert });
    (q("editor.task-query-builder.cancel") as HTMLElement).click();
    expect(onInsert).not.toHaveBeenCalled();
    cleanup();
  });

  it("does not fire cancel after an insert", () => {
    const onCancel = vi.fn();
    openTaskQueryBuilder({ onInsert: () => {}, onCancel });
    (q("editor.task-query-builder.insert") as HTMLElement).click();
    expect(onCancel).not.toHaveBeenCalled();
    cleanup();
  });

  it("inserts at most once", () => {
    const onInsert = vi.fn();
    openTaskQueryBuilder({ onInsert });
    const button = q("editor.task-query-builder.insert") as HTMLElement;
    button.click();
    button.click();
    expect(onInsert).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("the slash command leads to the builder, not to a bare fence", () => {
  it("is registered with the builder as its action", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("editor/src/slash/commands.ts", "utf-8"),
    );
    expect(src).toContain('id: "task-query"');
    expect(src).toContain("openTaskQueryBuilder(");
  });
});
