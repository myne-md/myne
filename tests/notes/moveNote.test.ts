// Unit tests for `src/notes/moveNote.ts` (move + bulk move) and the
// `createNote(folder)` a2 create-timing path. Move reads the note, rewrites
// the `folder:` frontmatter (set / delete via patchFolderField), bumps
// `updated:`, and re-encrypts. Grill 2026-05-29 Q7 (a2 create + move-only
// folder writes) + Q8 (bulk = N independent best-effort moves).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { moveNote, bulkMoveNotes } from "../../src/notes/moveNote";
import { createNote } from "../../src/notes/createNote";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

/** Route invoke by command: note_read → `read`, note_update → undefined. */
function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

/** Extract the plaintext arg of the (single) note_update call. */
function lastUpdateBody(): string {
  const call = invokeMock.mock.calls.find(
    ([cmd]) => cmd === "plugin:notes|note_update",
  );
  return (call?.[1] as { plaintext: string }).plaintext;
}

describe("moveNote — to a folder", () => {
  it("writes folder: into a root note and bumps updated:", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await moveNote("id-1", "Projects/");
    const body = lastUpdateBody();
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("folder: Projects/");
    expect(body).toContain("# Hello");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("replaces an existing folder: value (state C)", async () => {
    routeReadThenUpdate("---\nfolder: Old/\n---\n\nbody");
    await moveNote("id-2", "New/Sub/");
    const body = lastUpdateBody();
    expect(body).toContain("folder: New/Sub/");
    expect(body).not.toContain("folder: Old/");
  });

  it("normalizes a non-canonical folder value to trailing-slash", async () => {
    routeReadThenUpdate("body\n");
    await moveNote("id-3", "Projects/Myne"); // no trailing slash
    expect(lastUpdateBody()).toContain("folder: Projects/Myne/");
  });
});

describe("moveNote — to root (null = state-D delete)", () => {
  it("removes a single-field FM block byte-identical to a root note", async () => {
    // Foldered note with body → move-to-root strips the whole FM block.
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\n# Body");
    await moveNote("id-4", null);
    const body = lastUpdateBody();
    // The folder field is gone; updated: stamping re-adds an FM block
    // (move is a modification → updated: must advance), but folder: is absent.
    expect(body).not.toContain("folder:");
    expect(body).toContain("# Body");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("keeps other FM keys when deleting folder: (state-D partial)", async () => {
    routeReadThenUpdate("---\ntitle: Foo\nfolder: Projects/\n---\n\nbody");
    await moveNote("id-5", null);
    const body = lastUpdateBody();
    expect(body).toContain("title: Foo");
    expect(body).not.toContain("folder:");
  });
});

describe("moveNote — error propagation", () => {
  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.reject({ kind: "NoteNotFound" });
      return Promise.resolve(undefined);
    });
    await expect(moveNote("id-x", "Projects/")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("bulkMoveNotes — N independent best-effort moves", () => {
  it("moves all notes and reports them as moved", async () => {
    routeReadThenUpdate("body\n");
    const result = await bulkMoveNotes(["a", "b", "c"], "Archive/");
    expect(result.moved.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
  });

  it("reports per-note failures without aborting the rest", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      const id = (args as { noteId?: string }).noteId;
      if (cmd === "plugin:notes|note_read") {
        if (id === "bad") return Promise.reject({ kind: "CannotDecrypt" });
        return Promise.resolve("body\n");
      }
      return Promise.resolve(undefined);
    });
    const result = await bulkMoveNotes(["ok1", "bad", "ok2"], "Archive/");
    expect(result.moved.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("returns empty result for an empty input", async () => {
    const result = await bulkMoveNotes([], "Archive/");
    expect(result).toEqual({ moved: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("createNote(folder) — a2 create-timing", () => {
  it("sends a foldered FM block at create for a folder", async () => {
    invokeMock.mockResolvedValueOnce("new-id");
    await createNote("Projects/");
    const [, args] = invokeMock.mock.calls[0] ?? [];
    expect((args as { plaintext: string }).plaintext).toBe(
      "---\nfolder: Projects/\n---\n\n",
    );
  });

  it("sends empty plaintext for a root note (no arg / null)", async () => {
    invokeMock.mockResolvedValue("new-id");
    await createNote();
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe("");
    invokeMock.mockClear();
    await createNote(null);
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe("");
  });

  it("normalizes the folder before writing", async () => {
    invokeMock.mockResolvedValueOnce("new-id");
    await createNote("Projects/Myne"); // no trailing slash
    expect((invokeMock.mock.calls[0]?.[1] as { plaintext: string }).plaintext).toBe(
      "---\nfolder: Projects/Myne/\n---\n\n",
    );
  });
});
