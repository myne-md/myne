// Single shared fetch for the whole-vault task list (MYND-612, task 6).
//
// The acceptance criterion that matters here is the one that is easy to get wrong
// and invisible when you do: N mounted consumers must cause ONE fetch per index
// change, not N. The index nonce bumps on every autosave, so an unshared fetch
// means three query blocks in one note each hit IPC about once a second while the
// user types.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const {
  fetchVaultTasks,
  filterTasksToLiveSet,
  noteTasksFromCache,
  peekVaultTasks,
  resetTaskIndexCache,
} = await import("../../src/notes/taskIndex");
const { liveCache } = await import("../../src/notes/sidebarState");

const ROW = {
  noteId: "n1",
  noteTitle: "Alpha",
  noteFolder: null,
  lineIndex: 3,
  rawLine: "- [ ] pay the rent [due:: 2026-08-01]",
  completed: false,
  oversized: false,
  due: "2026-08-01",
};

beforeEach(() => {
  invoke.mockReset();
  resetTaskIndexCache();
});

describe("the shared fetch", () => {
  it("calls the command once and returns its rows", async () => {
    invoke.mockResolvedValue([ROW]);
    const tasks = await fetchVaultTasks(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("plugin:vault-indices|vault_indices_tasks");
    expect(tasks).toEqual([ROW]);
  });

  it("serves the same nonce from cache instead of re-fetching", async () => {
    invoke.mockResolvedValue([ROW]);
    await fetchVaultTasks(1);
    await fetchVaultTasks(1);
    await fetchVaultTasks(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the index nonce advances", async () => {
    invoke.mockResolvedValue([ROW]);
    await fetchVaultTasks(1);
    await fetchVaultTasks(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent callers into one in-flight fetch", async () => {
    // Three consumers mounting in the same tick is the real shape of this: a
    // note with three query blocks. They must produce one IPC call between them.
    let release!: (rows: unknown[]) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as (rows: unknown[]) => void;
      }),
    );

    const a = fetchVaultTasks(7);
    const b = fetchVaultTasks(7);
    const c = fetchVaultTasks(7);
    release([ROW]);
    await Promise.all([a, b, c]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(peekVaultTasks()).toEqual([ROW]);
  });
});

describe("failure behaviour", () => {
  it("keeps the previous list when a fetch fails rather than blanking every surface", async () => {
    invoke.mockResolvedValueOnce([ROW]);
    await fetchVaultTasks(1);
    expect(peekVaultTasks()).toEqual([ROW]);

    invoke.mockRejectedValueOnce(new Error("ipc down"));
    await fetchVaultTasks(2);
    expect(peekVaultTasks()).toEqual([ROW]);
  });

  it("retries on the next nonce after a failure", async () => {
    invoke.mockRejectedValueOnce(new Error("ipc down"));
    await fetchVaultTasks(1);
    expect(invoke).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValueOnce([ROW]);
    await fetchVaultTasks(2);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(peekVaultTasks()).toEqual([ROW]);
  });
});

describe("shape", () => {
  it("starts empty", () => {
    expect(peekVaultTasks()).toEqual([]);
  });

  it("carries the oversized flag through, so writers can refuse", async () => {
    invoke.mockResolvedValue([{ ...ROW, oversized: true }]);
    const [task] = await fetchVaultTasks(1);
    expect(task.oversized).toBe(true);
  });
});

describe("live-set gate (task 7)", () => {
  const note = (id: string, extra: Record<string, unknown> = {}) => [
    id,
    { noteUuid: id, title: id, folder: null, ...extra },
  ] as const;

  function cacheOf(...entries: readonly (readonly [string, unknown])[]) {
    return new Map(entries as never) as never;
  }

  const taskIn = (noteId: string) => ({ ...ROW, noteId });

  it("keeps tasks from ordinary notes", () => {
    const cache = cacheOf(note("n1"));
    expect(filterTasksToLiveSet([taskIn("n1")], cache, [])).toHaveLength(1);
  });

  it("excludes tasks from trashed, template, archived and conflict notes", () => {
    const cache = cacheOf(
      note("live"),
      note("trashed", { trashed: "2026-07-01" }),
      note("template", { template: true }),
      note("archived", { archived: "2026-07-01" }),
      note("conflict", { conflict: true }),
      note("deleted", { deleted: "2026-07-01" }),
    );
    const tasks = ["live", "trashed", "template", "archived", "conflict", "deleted"].map(taskIn);

    const kept = filterTasksToLiveSet(tasks, cache, []);
    expect(kept.map((t) => t.noteId)).toEqual(["live"]);
  });

  it("excludes tasks from folder-archived notes", () => {
    const cache = cacheOf(note("n1", { folder: "Old/" }));
    expect(filterTasksToLiveSet([taskIn("n1")], cache, ["old/"])).toEqual([]);
  });

  it("drops a task whose note is absent from the cache entirely", () => {
    expect(filterTasksToLiveSet([taskIn("ghost")], cacheOf(), [])).toEqual([]);
  });

  it("reuses the existing gate rather than re-listing predicates", () => {
    // If a fifth exclusion is ever added to `liveCache`, it must apply here with
    // no second edit. Asserting via behaviour: the gate's own output decides.
    const cache = cacheOf(note("a"), note("b", { trashed: "x" }));
    const gate = liveCache(cache, []);
    const kept = filterTasksToLiveSet([taskIn("a"), taskIn("b")], cache, []);
    expect(kept.map((t) => t.noteId)).toEqual([...gate.keys()]);
  });
});

describe("note-tasks in the same vector (task 4)", () => {
  const noteRec = (id: string, extra: Record<string, unknown> = {}) => [
    id,
    { noteUuid: id, title: id, folder: null, kind: null, done: null, ...extra },
  ] as const;

  function cache2(...entries: readonly (readonly [string, unknown])[]) {
    return new Map(entries as never) as never;
  }

  it("a class-marked note yields a record with an EMPTY locator", () => {
    const rows = noteTasksFromCache(cache2(noteRec("n1", { kind: "task" })), []);
    expect(rows).toHaveLength(1);
    expect(rows[0].lineIndex).toBeNull();
    expect(rows[0].rawLine).toBe("");
    expect(rows[0].noteId).toBe("n1");
  });

  it("a note with a due date but no marker yields NO record", () => {
    // The predicate is the marker alone — otherwise every meeting note with a
    // date silently becomes a task.
    const rows = noteTasksFromCache(cache2(noteRec("n1", { done: "2026-07-27T00:00:00Z" })), []);
    expect(rows).toEqual([]);
  });

  it("a non-canonical marker value does not activate the predicate", () => {
    const rows = noteTasksFromCache(
      cache2(noteRec("a", { kind: "drawing" }), noteRec("b", { kind: null })),
      [],
    );
    expect(rows).toEqual([]);
  });

  it("reads completion from the note's done field", () => {
    const [open] = noteTasksFromCache(cache2(noteRec("n1", { kind: "task" })), []);
    expect(open.completed).toBe(false);
    expect(open.done).toBeUndefined();

    const [closed] = noteTasksFromCache(
      cache2(noteRec("n2", { kind: "task", done: "2026-07-27T09:00:00Z" })),
      [],
    );
    expect(closed.completed).toBe(true);
    expect(closed.done).toBe("2026-07-27T09:00:00Z");
  });

  it("passes note-tasks through the same live-set gate", () => {
    const rows = noteTasksFromCache(
      cache2(
        noteRec("live", { kind: "task" }),
        noteRec("trashed", { kind: "task", trashed: "2026-07-01" }),
        noteRec("archived", { kind: "task", archived: "2026-07-01" }),
      ),
      [],
    );
    expect(rows.map((r) => r.noteId)).toEqual(["live"]);
  });

  it("the locator is what distinguishes the two kinds in one vector", () => {
    // Locator present → a write is line surgery; absent → a frontmatter patch.
    // That branch belongs to the single writer, not to every reader surface.
    const lineTask = { ...ROW, lineIndex: 3 };
    const [noteTask] = noteTasksFromCache(cache2(noteRec("n1", { kind: "task" })), []);
    expect(lineTask.lineIndex).not.toBeNull();
    expect(noteTask.lineIndex).toBeNull();
  });
});
