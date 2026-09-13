// Task nesting for the panel (myne-md/myne#656 item 7).
//
// The two design answers are the point of this suite: an indented task renders
// one level under a visible parent, and a task whose authored parent is NOT
// visible is promoted to the top rather than dropped or left floating.

import { describe, expect, it } from "vitest";
import { taskIndentWidth, visibleDepths } from "../../src/notes/taskTree";
import type { VaultTask } from "../../src/notes/taskIndex";
import { taskRowKey } from "../../src/notes/taskWriteCore";

function task(over: Partial<VaultTask> & { noteId: string; lineIndex: number | null }): VaultTask {
  return {
    noteTitle: "Note",
    noteFolder: null,
    rawLine: "- [ ] task",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

const key = (t: VaultTask): string => taskRowKey(t);

describe("taskIndentWidth", () => {
  it("counts spaces one column each", () => {
    expect(taskIndentWidth("- [ ] x")).toBe(0);
    expect(taskIndentWidth("  - [ ] x")).toBe(2);
  });

  it("advances a tab to the next tab stop, not one column", () => {
    expect(taskIndentWidth("\t- [ ] x")).toBe(4);
    expect(taskIndentWidth(" \t- [ ] x")).toBe(4);
    expect(taskIndentWidth("\t - [ ] x")).toBe(5);
  });
});

describe("visibleDepths", () => {
  it("a flat list is all roots", () => {
    const tasks = [
      task({ noteId: "n", lineIndex: 0 }),
      task({ noteId: "n", lineIndex: 1 }),
    ];
    const depths = visibleDepths(tasks, new Set(tasks.map(key)));
    expect([...depths.values()]).toEqual([0, 0]);
  });

  it("a child under a visible parent is one level down", () => {
    const parent = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] parent" });
    const child = task({ noteId: "n", lineIndex: 1, rawLine: "  - [ ] child" });
    const depths = visibleDepths([parent, child], new Set([key(parent), key(child)]));
    expect(depths.get(key(parent))).toBe(0);
    expect(depths.get(key(child))).toBe(1);
  });

  it("treats a tab-indented child the same as spaces", () => {
    const parent = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] parent" });
    const child = task({ noteId: "n", lineIndex: 1, rawLine: "\t- [ ] child" });
    const depths = visibleDepths([parent, child], new Set([key(parent), key(child)]));
    expect(depths.get(key(child))).toBe(1);
  });

  it("promotes a child whose parent is not visible", () => {
    // The parent is dated far out and filtered away; the child must still
    // appear, and without a step floating under nothing.
    const parent = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] parent" });
    const child = task({ noteId: "n", lineIndex: 1, rawLine: "  - [ ] child" });
    const depths = visibleDepths([parent, child], new Set([key(child)]));
    expect(depths.get(key(child))).toBe(0);
  });

  it("promotes past a hidden middle, rather than following the visible grandparent", () => {
    const root = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] root" });
    const mid = task({ noteId: "n", lineIndex: 1, rawLine: "  - [ ] mid" });
    const leaf = task({ noteId: "n", lineIndex: 2, rawLine: "    - [ ] leaf" });
    const depths = visibleDepths([root, mid, leaf], new Set([key(root), key(leaf)]));
    expect(depths.get(key(root))).toBe(0);
    // The authored parent (`mid`) is hidden, so `leaf` is a root - not depth 1.
    expect(depths.get(key(leaf))).toBe(0);
  });

  it("nests two visible levels", () => {
    const root = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] root" });
    const mid = task({ noteId: "n", lineIndex: 1, rawLine: "  - [ ] mid" });
    const leaf = task({ noteId: "n", lineIndex: 2, rawLine: "    - [ ] leaf" });
    const depths = visibleDepths(
      [root, mid, leaf],
      new Set([key(root), key(mid), key(leaf)]),
    );
    expect(depths.get(key(mid))).toBe(1);
    expect(depths.get(key(leaf))).toBe(2);
  });

  it("never parents across notes", () => {
    const a = task({ noteId: "a", lineIndex: 0, rawLine: "- [ ] a" });
    const b = task({ noteId: "b", lineIndex: 0, rawLine: "    - [ ] b" });
    const depths = visibleDepths([a, b], new Set([key(a), key(b)]));
    expect(depths.get(key(b))).toBe(0);
  });

  it("a note-task is a root and never a parent", () => {
    const noteTask = task({ noteId: "n", lineIndex: null, rawLine: "" });
    const indented = task({ noteId: "n", lineIndex: 0, rawLine: "    - [ ] x" });
    const depths = visibleDepths(
      [noteTask, indented],
      new Set([key(noteTask), key(indented)]),
    );
    expect(depths.get(key(noteTask))).toBe(0);
    expect(depths.get(key(indented))).toBe(0);
  });

  it("treats an indent shallower than the previous line as a new root", () => {
    const a = task({ noteId: "n", lineIndex: 0, rawLine: "- [ ] a" });
    const b = task({ noteId: "n", lineIndex: 1, rawLine: "    - [ ] b" });
    const c = task({ noteId: "n", lineIndex: 2, rawLine: "  - [ ] c" });
    const depths = visibleDepths([a, b, c], new Set([key(a), key(b), key(c)]));
    // `c` is indented 2, less than `b` at 4, so the stack pops back past `b` to
    // `a` - it is a child of `a`, not of `b`.
    expect(depths.get(key(c))).toBe(1);
  });
});
