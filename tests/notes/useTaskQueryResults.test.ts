// @vitest-environment jsdom
//
// `useTaskQueryResults` (MYND-617) — the host glue that makes a task-query block
// show something.
//
// This is the seam the epic shipped without: the editor package finds the blocks
// and renders rows, but nothing computed the rows. So what these tests pin is
// the wiring contract rather than the query semantics (`taskQueryRun.test.ts`
// owns those):
//
//   - a block gets an entry keyed by its OWN query text, so two blocks in one
//     note cannot show each other's answer;
//   - a refused query stays refused through the mapping — the widget must not
//     receive an empty list where a refusal was meant;
//   - dropped clauses survive into the render so the widget can name them;
//   - a row key round-trips back to its record, because a toggle carries nothing
//     else and an unresolvable key means no write happens at all;
//   - a `tag includes` clause reaches the canonical `byTag` accessor instead of
//     silently matching nothing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { VaultTask } from "../../src/notes/taskIndex";

const tasksMock = vi.fn<() => readonly VaultTask[]>();
const byTagMock = vi.fn<(tag: string) => Promise<string[]>>();
const blocksMock = vi.fn<(state: unknown) => { from: number; to: number; query: string }[]>();

vi.mock("../../src/notes/taskIndex", () => ({
  useLiveVaultTasks: () => tasksMock(),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  byTag: (tag: string) => byTagMock(tag),
}));
vi.mock("@myne/editor/decorations/task-query-block", () => ({
  taskQueryBlocks: (state: unknown) => blocksMock(state),
}));

const { useTaskQueryResults } = await import("../../src/notes/useTaskQueryResults");

/** A stand-in for the live view: the hook only ever reads `.state`. */
const VIEW = { state: {} } as never;

function task(over: Partial<VaultTask> & { noteId: string }): VaultTask {
  return {
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 3,
    rawLine: "- [ ] pay the rent",
    completed: false,
    oversized: false,
    ...over,
  };
}

function blocks(...queries: string[]): void {
  blocksMock.mockReturnValue(queries.map((query, i) => ({ from: i, to: i + 1, query })));
}

beforeEach(() => {
  vi.clearAllMocks();
  byTagMock.mockResolvedValue([]);
  blocksMock.mockReturnValue([]);
  tasksMock.mockReturnValue([]);
});

describe("useTaskQueryResults", () => {
  it("keys each block's answer by its own query text", () => {
    tasksMock.mockReturnValue([
      task({ noteId: "n1", rawLine: "- [ ] open one", completed: false }),
      task({ noteId: "n2", rawLine: "- [x] closed one", completed: true }),
    ]);
    blocks("not done", "done");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    expect([...result.current.results.keys()]).toEqual(["not done", "done"]);
    expect(result.current.results.get("not done")!.rows.map((r) => r.text)).toEqual(["open one"]);
    expect(result.current.results.get("done")!.rows.map((r) => r.text)).toEqual(["closed one"]);
  });

  it("carries a refusal through rather than flattening it to an empty list", () => {
    // The distinction the whole guard exists for: a refused query and a query
    // that matched nothing look identical in `rows` and must not in `refused`.
    tasksMock.mockReturnValue([task({ noteId: "n1" })]);
    blocks("sort by function");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    const render = result.current.results.get("sort by function")!;
    expect(render.refused).toBe(true);
    expect(render.rows).toHaveLength(0);
    expect(render.dropped).toContain("sort by function");
  });

  it("reports a dropped clause while keeping what it understood", () => {
    tasksMock.mockReturnValue([
      task({ noteId: "n1", rawLine: "- [ ] open one", completed: false }),
      task({ noteId: "n2", rawLine: "- [x] closed one", completed: true }),
    ]);
    blocks("not done\ndue + 3d");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    const render = result.current.results.get("not done\ndue + 3d")!;
    expect(render.refused).toBe(false);
    expect(render.rows.map((r) => r.text)).toEqual(["open one"]);
    expect(render.dropped).toEqual(["due + 3d"]);
  });

  it("round-trips a row key back to its record", () => {
    const rent = task({ noteId: "n1", lineIndex: 7, rawLine: "- [ ] pay the rent" });
    tasksMock.mockReturnValue([rent]);
    blocks("not done");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    const row = result.current.results.get("not done")!.rows[0]!;
    expect(result.current.resolveRow(row.key)).toBe(rent);
    expect(result.current.resolveRow("n1:999")).toBeUndefined();
  });

  it("resolves a note-task, whose locator is absent rather than a line", () => {
    const whole = task({ noteId: "n9", lineIndex: null, noteTitle: "Ship the thing" });
    tasksMock.mockReturnValue([whole]);
    blocks("not done");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    const row = result.current.results.get("not done")!.rows[0]!;
    // A note-task has no line, so its title IS the task text.
    expect(row.text).toBe("Ship the thing");
    expect(result.current.resolveRow(row.key)).toBe(whole);
  });

  it("asks the canonical tag accessor instead of matching nothing", async () => {
    tasksMock.mockReturnValue([
      task({ noteId: "tagged", rawLine: "- [ ] tagged one" }),
      task({ noteId: "untagged", rawLine: "- [ ] untagged one" }),
    ]);
    byTagMock.mockResolvedValue(["tagged"]);
    blocks("tag includes work");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    await waitFor(() => {
      expect(result.current.results.get("tag includes work")!.rows).toHaveLength(1);
    });
    expect(byTagMock).toHaveBeenCalledWith("work");
    expect(result.current.results.get("tag includes work")!.rows[0]!.text).toBe("tagged one");
  });

  it("excludes rather than widens when the tag lookup fails", async () => {
    // A failed lookup must never turn `tag includes work` into "every task".
    tasksMock.mockReturnValue([task({ noteId: "n1", rawLine: "- [ ] one" })]);
    byTagMock.mockRejectedValue(new Error("index unavailable"));
    blocks("tag includes work");

    const { result } = renderHook(() => useTaskQueryResults(VIEW, "body", 1));

    await waitFor(() => expect(byTagMock).toHaveBeenCalled());
    expect(result.current.results.get("tag includes work")!.rows).toHaveLength(0);
  });

  it("computes nothing when there is no view or no block", () => {
    tasksMock.mockReturnValue([task({ noteId: "n1" })]);

    const withoutBlocks = renderHook(() => useTaskQueryResults(VIEW, "body", 1));
    expect(withoutBlocks.result.current.results.size).toBe(0);

    blocks("not done");
    const withoutView = renderHook(() => useTaskQueryResults(null, "body", 1));
    // No view means no tree to walk — and an absent entry renders as loading,
    // which is the honest state while the view is still mounting.
    expect(withoutView.result.current.results.size).toBe(0);
  });
});
