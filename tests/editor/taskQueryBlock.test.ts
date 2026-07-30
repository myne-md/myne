// @vitest-environment jsdom
//
// The task-query fenced block (MYND-617 tasks 4, 6, 9, 12).
//
// The properties worth testing are the ones invisible when broken: the block
// renders as a widget rather than a code card, the raw bytes are never touched,
// caret entry reveals the WHOLE block, the dropped-clause notice is permanent
// (not a toast), the refusal looks different from an empty result, and a block
// cannot match itself.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import {
  buildTaskQueryDecorations,
  setTaskQueryResults,
  TASK_QUERY_INFO,
  TASK_QUERY_TOGGLE_EVENT,
  taskQueryBlockDecorations,
  taskQueryBlocks,
  type TaskQueryRender,
} from "@myne/editor/decorations/task-query-block";
import { extractLineTasks } from "../../src/dialect/visitors/lineTasks";

const DOC = ["# Review", "", "```tasks", "not done", "sort by due", "```", "", "after"].join("\n");

function mount(doc = DOC): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: { parser } as never }), taskQueryBlockDecorations()],
    }),
  });
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement): void {
  view.destroy();
  host.remove();
}

const q = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);
const all = (host: HTMLElement, id: string): HTMLElement[] =>
  [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

function push(view: EditorView, query: string, render: TaskQueryRender): void {
  view.dispatch({ effects: setTaskQueryResults.of(new Map([[query, render]])) });
}

const RENDER: TaskQueryRender = {
  rows: [
    { key: "n1:3", text: "pay the rent", completed: false, noteTitle: "Bills", due: "2026-08-01" },
    { key: "n2:0", text: "buy milk", completed: true, noteTitle: "Errands" },
  ],
  remainder: 0,
  dropped: [],
  refused: false,
};

describe("block detection", () => {
  it("finds the block and hands back its query text", () => {
    const { view, host } = mount();
    const blocks = taskQueryBlocks(view.state);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.query).toBe("not done\nsort by due");
    teardown(view, host);
  });

  it("ignores an unclosed fence — it is still being typed", () => {
    const { view, host } = mount("```tasks\nnot done\n");
    expect(taskQueryBlocks(view.state)).toHaveLength(0);
    teardown(view, host);
  });

  it("ignores a fence with a different info string", () => {
    const { view, host } = mount("```js\nnot done\n```\n");
    expect(taskQueryBlocks(view.state)).toHaveLength(0);
    teardown(view, host);
  });

  it("finds several blocks in one note", () => {
    const { view, host } = mount(
      "```tasks\ndone\n```\n\ntext\n\n```tasks\nnot done\n```\n",
    );
    expect(taskQueryBlocks(view.state)).toHaveLength(2);
    teardown(view, host);
  });
});

describe("rendering", () => {
  it("replaces the block with a widget, not a code card", () => {
    const { view, host } = mount();
    expect(q(host, "editor.task-query")).not.toBeNull();
    teardown(view, host);
  });

  it("shows a LOADING state before results arrive, not an empty list", () => {
    // An empty list here is a wrong answer presented as a finished one.
    const { view, host } = mount();
    expect(q(host, "editor.task-query.loading")).not.toBeNull();
    expect(q(host, "editor.task-query.empty")).toBeNull();
    teardown(view, host);
  });

  it("renders the rows it is handed", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", RENDER);
    const texts = all(host, "editor.task-query.text").map((n) => n.textContent);
    expect(texts).toEqual(["pay the rent", "buy milk"]);
    expect(q(host, "editor.task-query.due")?.textContent).toBe("2026-08-01");
    teardown(view, host);
  });

  it("a completed row is a filled box and struck text — no green check", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", RENDER);
    const boxes = all(host, "editor.task-query.checkbox");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("true");
    expect(boxes[1]!.className).toContain("cm-task-query-box-done");
    expect(host.innerHTML).not.toMatch(/✓|✔|✅/);
    teardown(view, host);
  });

  it("renders an empty result distinctly from a refusal", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", { ...RENDER, rows: [] });
    expect(q(host, "editor.task-query.empty")).not.toBeNull();
    expect(q(host, "editor.task-query.refused")).toBeNull();
    teardown(view, host);
  });
});

describe("the remainder is stated, never silently truncated", () => {
  it("shows how many more matched", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", { ...RENDER, remainder: 150 });
    expect(q(host, "editor.task-query.remainder")?.textContent).toContain("150");
    teardown(view, host);
  });

  it("says nothing when nothing was cut", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", RENDER);
    expect(q(host, "editor.task-query.remainder")).toBeNull();
    teardown(view, host);
  });
});

describe("dropped clauses are reported inside the widget, permanently", () => {
  it("names how many were dropped", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", { ...RENDER, dropped: ["group by heading"] });
    const notice = q(host, "editor.task-query.dropped");
    expect(notice).not.toBeNull();
    expect(notice!.getAttribute("data-dropped-count")).toBe("1");
    teardown(view, host);
  });

  it("the specific clauses are discoverable", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", {
      ...RENDER,
      dropped: ["group by heading", "hide task count"],
    });
    const clauses = all(host, "editor.task-query.dropped-clause").map((n) => n.textContent);
    expect(clauses).toEqual(["group by heading", "hide task count"]);
    teardown(view, host);
  });

  it("renders a clause as TEXT, never as markup", () => {
    // The string came out of the user's own file.
    const { view, host } = mount();
    push(view, "not done\nsort by due", { ...RENDER, dropped: ["<img src=x onerror=1>"] });
    expect(host.querySelector("img")).toBeNull();
    expect(q(host, "editor.task-query.dropped-clause")?.textContent).toBe("<img src=x onerror=1>");
    teardown(view, host);
  });

  it("survives a re-render — it is not a show-once notice", () => {
    // A toast would nag on every note open; a show-once toast goes silent,
    // which is precisely the failure the visible-drop rule prevents.
    const { view, host } = mount();
    push(view, "not done\nsort by due", { ...RENDER, dropped: ["group by heading"] });
    view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(q(host, "editor.task-query.dropped")).not.toBeNull();
    teardown(view, host);
  });
});

describe("an all-dropped query refuses, visibly", () => {
  it("shows the refusal instead of rows", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", {
      rows: [],
      remainder: 0,
      dropped: ["group by heading"],
      refused: true,
    });
    expect(q(host, "editor.task-query.refused")).not.toBeNull();
    expect(q(host, "editor.task-query.empty")).toBeNull();
    expect(all(host, "editor.task-query.row")).toHaveLength(0);
    teardown(view, host);
  });

  it("still names what it could not read", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", {
      rows: [],
      remainder: 0,
      dropped: ["group by heading"],
      refused: true,
    });
    expect(q(host, "editor.task-query.dropped-clause")?.textContent).toBe("group by heading");
    teardown(view, host);
  });
});

// Reveal gating is a pure function of (state, focused) — tested directly rather
// than through jsdom focus events, which the table suite already documents as
// unreliable. A view is mounted only to force a complete parse; focus is passed
// explicitly.
describe("reveal is whole-block (buildTaskQueryDecorations)", () => {
  function parsedState(doc = DOC): { state: EditorState; done: () => void } {
    const { view, host } = mount(doc);
    forceParsing(view, doc.length, 5000);
    return { state: view.state, done: () => teardown(view, host) };
  }

  it("renders the block when the caret is outside it", () => {
    const { state, done } = parsedState();
    const at = state.update({ selection: { anchor: 0 } }).state;
    expect(buildTaskQueryDecorations(at, true).size).toBe(1);
    done();
  });

  it("caret entry reveals the WHOLE block — the widget goes entirely", () => {
    const { state, done } = parsedState();
    const inside = state.doc.line(4).from + 2;
    const at = state.update({ selection: { anchor: inside } }).state;
    // Not a fragment: a block widget is atomic, so there is no partial state
    // between rendered and raw.
    expect(buildTaskQueryDecorations(at, true).size).toBe(0);
    done();
  });

  it("an UNFOCUSED editor keeps the widget even with the caret inside", () => {
    // Otherwise every background pane would sit showing raw source.
    const { state, done } = parsedState();
    const inside = state.doc.line(4).from + 2;
    const at = state.update({ selection: { anchor: inside } }).state;
    expect(buildTaskQueryDecorations(at, false).size).toBe(1);
    done();
  });

  it("the fence markers themselves count as inside the block", () => {
    const { state, done } = parsedState();
    const onOpeningFence = state.doc.line(3).from + 1;
    const at = state.update({ selection: { anchor: onOpeningFence } }).state;
    expect(buildTaskQueryDecorations(at, true).size).toBe(0);
    done();
  });
});

describe("byte stability", () => {
  it("rendering never modifies the file", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", RENDER);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });

  it("revealing and re-hiding leaves the bytes untouched", () => {
    const { view, host } = mount();
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });
});

describe("a block cannot match itself", () => {
  it("a task-looking line inside the fence produces no task", () => {
    // Self-reference is impossible by construction: the tokenizer never
    // descends into a code node, so no cycle guard is needed.
    const doc = "```tasks\n- [ ] this looks like a task\nnot done\n```\n";
    expect(extractLineTasks(doc)).toHaveLength(0);
  });

  it("a task outside the fence is still found", () => {
    const doc = "- [ ] a real task\n\n```tasks\n- [ ] not a task\n```\n";
    const tasks = extractLineTasks(doc);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.rawLine).toBe("- [ ] a real task");
  });
});

describe("row activation reaches the host", () => {
  it("clicking a checkbox emits a toggle event naming the row", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", RENDER);

    let detail: { queryKey: string; rowKey: string } | null = null;
    view.dom.addEventListener(TASK_QUERY_TOGGLE_EVENT, (e) => {
      detail = (e as CustomEvent<{ queryKey: string; rowKey: string }>).detail;
    });
    all(host, "editor.task-query.checkbox")[0]!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );

    expect(detail).not.toBeNull();
    expect(detail!.rowKey).toBe("n1:3");
    expect(detail!.queryKey).toBe("not done\nsort by due");
    teardown(view, host);
  });

  it("an oversized row is not activatable and says why", () => {
    const { view, host } = mount();
    push(view, "not done\nsort by due", {
      ...RENDER,
      rows: [{ key: "n3:1", text: "very long", completed: false, noteTitle: "N", oversized: true }],
    });
    const box = q(host, "editor.task-query.checkbox")!;
    expect(box.getAttribute("aria-disabled")).toBe("true");
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(box.getAttribute("title")).toBeTruthy();
    teardown(view, host);
  });

  it("the info string is the one the fenced-code card skips", async () => {
    // Two block-replaces over one range collide; the skip is what prevents it.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("editor/src/decorations/fenced-code.ts", "utf-8"),
    );
    expect(src).toContain("TASK_QUERY_INFO");
    expect(TASK_QUERY_INFO).toBe("tasks");
  });
});
