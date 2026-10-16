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

/**
 * A minimal `visualViewport` stand-in: jsdom does not implement one. The same
 * shape `floatingViewport.test.ts` uses, because the two specs assert the same
 * two numbers on two different surfaces.
 */
function stubVisualViewport(init: { height: number; offsetTop: number }): {
  set: (next: { height: number; offsetTop: number }) => void;
  fire: (type: "resize" | "scroll") => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  const vv = {
    height: init.height,
    offsetTop: init.offsetTop,
    addEventListener: (type: string, cb: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners.get(type)?.delete(cb);
    },
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return {
    set: (next) => {
      vv.height = next.height;
      vv.offsetTop = next.offsetTop;
    },
    fire: (type) => {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

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

describe("the dialog fits a phone (myne-md/myne#884 task 9)", () => {
  /** A `readFileSync` return is untyped here (`@types/node` is not a dep), and an
   *  inferred parameter from one is an implicit any - which is the trap
   *  `check-test-typecheck` counts. Annotate rather than infer. */
  function sheetSection(): string {
    const fs = require("node:fs") as {
      readFileSync: (p: string, enc: string) => string;
    };
    const css: string = fs.readFileSync("editor/src/task-surfaces.css", "utf8");
    // SLICE to the builder's own section before asserting anything about it. An
    // assertion over the whole sheet passes on a rule that lives in some other
    // section, which is exactly the drift this is meant to catch.
    const start = css.indexOf("── The task-query builder");
    expect(start, "the builder's section marker is gone").toBeGreaterThan(-1);
    const end = css.indexOf("── The `+` add-field affordance", start);
    return css.slice(start, end === -1 ? undefined : end);
  }

  it("caps the dialog by the VISIBLE height, not `100vh`", () => {
    const section = sheetSection();
    expect(section).toContain("max-height: calc(var(--cm-visible-h, 100vh) - 32px)");
    // Non-vacuity: the static basis must be gone from this section, or the
    // assertion above could hold while the old rule still won on source order.
    expect(section).not.toContain("max-height: calc(100vh - 32px)");
    // And the scroll it already had, which the stacking must not take away.
    expect(section).toContain("overflow-y: auto");
  });

  it("stacks each label above its control under a coarse pointer or a narrow width", () => {
    const section = sheetSection();
    const media = /@media \(pointer: coarse\), \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(section);
    expect(media, "the stacking media query is gone").not.toBeNull();
    expect(media![1]).toContain(".cm-task-query-builder-row");
    expect(media![1]).toContain("flex-direction: column");
    // Desktop keeps the row layout, so the un-queried rule must stay a row.
    const base = /\.cm-task-query-builder-row \{([\s\S]*?)\n\}/.exec(section);
    expect(base).not.toBeNull();
    expect(base![1]).toContain("display: flex");
    expect(base![1]).not.toContain("flex-direction: column");
  });

  it("follows the visible viewport's height and its keyboard offset", () => {
    // jsdom has no `visualViewport` of its own; this is the platform shape iOS
    // has with the software keyboard up: the layout viewport keeps its height,
    // the visible area does not.
    const innerHeight = window.innerHeight;
    const vv = stubVisualViewport({ height: innerHeight - 300, offsetTop: 0 });
    openTaskQueryBuilder({ onInsert: () => {} });

    const surface = q("editor.task-query-builder")!;
    const backdrop = surface.parentElement as HTMLElement;
    expect(surface.style.getPropertyValue("--cm-visible-h")).toBe(`${innerHeight - 300}px`);
    // The card is centred in the BACKDROP, so the keyboard's 300px must come off
    // the backdrop's content box or a short dialog is still centred behind it.
    expect(backdrop.style.paddingBottom).toBe(`300px`);

    // A rotation, or the keyboard moving, re-measures...
    vv.set({ height: innerHeight - 100, offsetTop: 0 });
    vv.fire("resize");
    expect(surface.style.getPropertyValue("--cm-visible-h")).toBe(`${innerHeight - 100}px`);
    expect(backdrop.style.paddingBottom).toBe(`100px`);

    // ...and closing stops it: a stale listener would keep writing inline styles
    // into a detached node, which reads as a leak rather than as an error.
    const closed = openTaskQueryBuilder({ onInsert: () => {} });
    (q("editor.task-query-builder.insert") as HTMLElement).click();
    closed.close();
    const before = surface.style.getPropertyValue("--cm-visible-h");
    vv.fire("resize");
    expect(surface.style.getPropertyValue("--cm-visible-h")).toBe(before);
    cleanup();
    delete (window as unknown as { visualViewport?: unknown }).visualViewport;
  });

  it("falls back to the layout viewport where there is no visible one", () => {
    // A platform without `visualViewport` gets exactly what it had before this
    // task: the layout height, and no offset.
    delete (window as unknown as { visualViewport?: unknown }).visualViewport;
    openTaskQueryBuilder({ onInsert: () => {} });
    const surface = q("editor.task-query-builder")!;
    const backdrop = surface.parentElement as HTMLElement;
    expect(surface.style.getPropertyValue("--cm-visible-h")).toBe(`${window.innerHeight}px`);
    expect(backdrop.style.paddingBottom).toBe("0px");
    cleanup();
  });
});
