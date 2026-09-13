// The mobile task data layer and the shared-module consumption (MYND-620 task 2).
//
// The point of these tests is not that mobile filters tasks correctly — the
// desktop already proves that, and mobile does not have its own copy to prove.
// The point is that **there is no second copy**: the write sequence, the filter
// predicates and the panel all come from the shared modules, and the things
// mobile does own (the fetch, the IO binding) behave.

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let hasTauri = true;
vi.mock("../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return hasTauri;
  },
}));

const noteRead = vi.fn(async (_id: string) => "");
const noteUpdate = vi.fn(async (_id: string, _body: string, _hash?: string) => {});
vi.mock("../src/lib/notes", () => ({
  noteRead: (id: string) => noteRead(id),
  noteUpdate: (id: string, body: string, hash?: string) => noteUpdate(id, body, hash),
  noteCreate: vi.fn(async () => "new-id"),
}));

const createConflictCopy = vi.fn(async (_body: string, _id: string) => "copy-id");
vi.mock("../src/lib/conflictCopy", () => ({
  createConflictCopy: (b: string, i: string) => createConflictCopy(b, i),
}));

import { setTaskCompleted, vaultTasks, TASK_WRITE_EVENT } from "../src/lib/tasks";
import type { VaultTask } from "@myne/task-write";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

function lineTask(over: Partial<VaultTask> = {}): VaultTask {
  return {
    noteId: "n1",
    noteTitle: "A note",
    noteFolder: null,
    lineIndex: 1,
    rawLine: "- [ ] water the plants",
    completed: false,
    oversized: false,
    ...over,
  };
}

beforeEach(() => {
  (globalThis as unknown as { window: EventTarget }).window = new EventTarget();
  invoke.mockClear();
  noteRead.mockClear();
  noteUpdate.mockClear();
  createConflictCopy.mockClear();
  hasTauri = true;
});

describe("the vault-wide fetch", () => {
  it("asks for the whole list, unparameterized", async () => {
    invoke.mockResolvedValueOnce([lineTask()]);
    expect(await vaultTasks()).toHaveLength(1);
    // No arguments: Rust does no filtering, sorting or date comparison, because
    // a parameterized accessor would move the §3.6.4 type authority out of the
    // dialect layer.
    expect(invoke).toHaveBeenCalledWith("plugin:vault-indices|vault_indices_tasks");
  });

  // A task surface that throws when the backend is absent would make every
  // unrelated flow spec depend on this one.
  it("is inert without a host", async () => {
    hasTauri = false;
    expect(await vaultTasks()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports an empty list rather than throwing when the index is not ready", async () => {
    invoke.mockRejectedValueOnce(new Error("locked"));
    expect(await vaultTasks()).toEqual([]);
  });

  it("decodes the wire's nulls away, so no surface ever sees one", async () => {
    // The command answers with the WIRE shape: Rust's `Option<String>` fields
    // arrive as `null`, not as absent keys, and cannot stop doing so (the same
    // struct is the on-disk `MYI1` payload). `VaultTask` promises
    // optional-or-absent, every shared consumer writes the check that promise
    // invites, and casting the rows here instead of decoding them is what made
    // that promise false on this client — the Tasks tab crashed on `.slice` of a
    // null under the All filter (myne-md/myne-mobile#36).
    invoke.mockResolvedValueOnce([
      { ...lineTask(), due: null, remind: null, repeat: null, priority: null, done: null },
    ]);
    const [row] = await vaultTasks();
    for (const key of ["due", "remind", "repeat", "priority", "done"] as const) {
      expect(row?.[key], `${key} must not be null`).toBeUndefined();
      expect(Object.hasOwn(row!, key), `${key} must be absent, not present-undefined`).toBe(false);
    }
    // The nulls the decoder must NOT touch: the locator is the note-task
    // discriminator, and an untitled note legitimately has no title.
    expect(row?.lineIndex).toBe(1);
    expect(row?.noteFolder).toBeNull();
  });
});

describe("the write goes through the shared sequence, with mobile IO", () => {
  it("verifies the stored raw line against disk before flipping it", async () => {
    noteRead.mockResolvedValueOnce("intro\n- [ ] water the plants\noutro");
    await setTaskCompleted(lineTask(), true);

    expect(noteUpdate).toHaveBeenCalledTimes(1);
    const [noteId, body, hash] = noteUpdate.mock.calls[0]!;
    expect(noteId).toBe("n1");
    expect(body).toBe("intro\n- [x] water the plants\noutro");
    // The content-hash guard is what stops a sync pull-apply being clobbered.
    // It is passed ALWAYS, not optionally — a checkbox flip is not
    // idempotent-safe applied to a body the user has since edited.
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // The index is a cache and may be an autosave behind. A mismatch means the
  // note moved and this write would land on the wrong text.
  it("refuses when the note no longer matches the indexed line", async () => {
    noteRead.mockResolvedValueOnce("intro\n- [ ] something else\noutro");
    await expect(setTaskCompleted(lineTask(), true)).rejects.toThrow();
    expect(noteUpdate).not.toHaveBeenCalled();
  });

  it("refuses an oversized record rather than writing something unverifiable", async () => {
    await expect(setTaskCompleted(lineTask({ oversized: true }), true)).rejects.toThrow();
    expect(noteRead).not.toHaveBeenCalled();
    expect(noteUpdate).not.toHaveBeenCalled();
  });

  it("announces the write so a surface showing that note re-reads it", async () => {
    noteRead.mockResolvedValueOnce("intro\n- [ ] water the plants\noutro");
    const seen: string[] = [];
    const target = (globalThis as unknown as { window: EventTarget }).window;
    target.addEventListener(TASK_WRITE_EVENT, (e) =>
      seen.push((e as CustomEvent<{ noteId: string }>).detail.noteId),
    );
    await setTaskCompleted(lineTask(), true);
    expect(seen).toEqual(["n1"]);
  });

  // Keep-both, not overwrite: the body this tick WOULD have written is
  // preserved, and what sync delivered stays on disk untouched.
  it("preserves the tick as a conflict copy when sync raced the write", async () => {
    noteRead.mockResolvedValueOnce("intro\n- [ ] water the plants\noutro");
    noteUpdate.mockRejectedValueOnce({ kind: "BaseMismatch" });
    await expect(setTaskCompleted(lineTask(), true)).rejects.toThrow();
    expect(createConflictCopy).toHaveBeenCalledTimes(1);
    expect(createConflictCopy.mock.calls[0]![0]).toContain("- [x] water the plants");
  });

  // A note-task has no line — the whole note is the task — so it goes through
  // the frontmatter patcher instead.
  it("routes a note-task through the done: field, not line surgery", async () => {
    noteRead.mockResolvedValueOnce("---\nkind: task\ntitle: Ship it\n---\nbody");
    await setTaskCompleted(lineTask({ lineIndex: null }), true);
    expect(noteUpdate).toHaveBeenCalledTimes(1);
    expect(noteUpdate.mock.calls[0]![1]).toContain("done:");
  });

  it("refuses a note-task that does not carry the class marker", async () => {
    noteRead.mockResolvedValueOnce("---\ntitle: Not a task\n---\nbody");
    await expect(setTaskCompleted(lineTask({ lineIndex: null }), true)).rejects.toThrow();
    expect(noteUpdate).not.toHaveBeenCalled();
  });
});

describe("nothing about tasks is implemented twice", () => {
  const surface = () => read("../src/components/TaskSurface.tsx");
  const data = () => read("../src/lib/tasks.ts");

  it("consumes the shared panel and the shared filters, and defines neither", () => {
    const source = surface();
    expect(source).toContain('from "@myne/task-panel"');
    expect(source).toContain('from "@myne/task-filters"');
    // The view model (filters + sort) is shared too; the mobile-only
    // `TaskScopeStrip` was retired when folder/tag narrowing became one of the
    // shared filter row's axes (myne-md/myne#656).
    expect(source).toContain('from "@myne/task-view"');
    // No local predicate, comparator or date axis anywhere in the mobile tree.
    for (const forbidden of ["matchesFilter", "sortTasks", "overdueCount", "?? task.remind"]) {
      expect(source, `mobile must not restate ${forbidden}`).not.toContain(forbidden);
      expect(data(), `mobile must not restate ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("consumes the shared write sequence and only names its IO", () => {
    const source = data();
    expect(source).toContain('from "@myne/task-write"');
    expect(source).toContain('from "@myne/note-completion"');
    // The sequence itself — the raw-line verification, the marker flip — must
    // not appear here. A second copy would drift on whichever step a reader
    // thought was incidental.
    for (const forbidden of ["flipMarker", "rawLine", "TaskWriteRefused"]) {
      expect(source, `mobile must not restate ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("decodes the wire shape through the shared decoder, and does not cast it away", () => {
    const source = data();
    expect(source).toContain('from "@myne/task-wire"');
    // A local copy of the conversion would drift the day `TaskRecord` gains a
    // sixth `Option<String>` field, and the failure is a null reaching `.slice`
    // on a surface, not a type error anyone would see first.
    expect(source, "mobile must not restate the decoder").not.toContain("function fromWire");
    // The regression itself, pinned as a string: `invoke<VaultTask[]>` is not a
    // shortcut, it is an assertion about the rows that is false.
    expect(source, "the fetch must not cast the wire shape away").not.toContain(
      "invoke<VaultTask[]>",
    );
  });

  it("wires both scopes through one component", () => {
    const source = surface();
    expect(source).toContain('{ kind: "vault" }');
    expect(source).toContain('{ kind: "note"; noteId: string }');
    // The row is told which surface it is in; it is not two components.
    expect(source).toContain('rowScope={scope.kind === "note" ? "note" : "vault"}');
    expect([...source.matchAll(/<TaskListPanel/g)].length).toBe(1);
  });

  // The alias has to be mirrored in three resolvers or the build breaks in a
  // different place from the typecheck.
  it("declares every shared alias in all three resolvers", () => {
    const specifiers = [
      "@myne/task-panel",
      "@myne/task-filters",
      "@myne/task-scope",
      "@myne/task-write",
      "@myne/task-wire",
      "@myne/note-completion",
    ];
    for (const file of ["../tsconfig.json", "../vite.config.ts", "../vitest.config.ts"]) {
      // Backslashes stripped: tsconfig spells the specifier plainly, while the
      // two Vite configs spell it inside a regex literal (`/^@myne\/task-panel$/`),
      // so a literal substring check passes on one and fails on the others for a
      // reason that has nothing to do with the alias being present.
      const source = read(file).replace(/\\/g, "");
      for (const specifier of specifiers) {
        expect(source, `${file} must alias ${specifier}`).toContain(specifier);
      }
    }
  });

  // The gotcha this repo already has a name for: a command needs the build.rs
  // list, the permission file and the invoke_handler. Missing one fails CLOSED
  // at runtime with nothing at build time saying so.
  it("registers the task-index command at all three backend sites", () => {
    for (const site of [
      "../src-tauri/build.rs",
      "../src-tauri/permissions/vault-indices/default.toml",
      "../src-tauri/src/plugins/vault_indices/mod.rs",
    ]) {
      expect(read(site), `${site} must register vault_indices_tasks`).toContain(
        "vault_indices_tasks",
      );
    }
    expect(read("../src-tauri/permissions/vault-indices/default.toml")).toContain(
      '"allow-vault-indices-tasks"',
    );
  });
});
