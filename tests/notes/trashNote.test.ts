// Unit tests for `src/notes/trashNote.ts` (trashNote + restoreNote). Trash
// writes `trashed: <now>` via patchTrashedField + note_update; restore deletes
// it (state D). Neither bumps `updated:`. Mirrors `moveNote.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  trashNote,
  restoreNote,
  bulkTrashNotes,
} from "../../src/notes/trashNote";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function lastUpdateBody(): string {
  const call = invokeMock.mock.calls.find(
    ([cmd]) => cmd === "plugin:notes|note_update",
  );
  return (call?.[1] as { plaintext: string }).plaintext;
}

const RFC3339 = /trashed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;

describe("trashNote", () => {
  it("writes a valid RFC 3339 trashed: into a root note", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await trashNote("id-1");
    const body = lastUpdateBody();
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(RFC3339);
    expect(body).toContain("# Hello");
  });

  it("does NOT add or bump updated: (trashing is not a content edit)", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await trashNote("id-1");
    expect(lastUpdateBody()).not.toContain("updated:");
  });

  it("leaves an existing updated: untouched", async () => {
    routeReadThenUpdate(
      "---\nupdated: 2026-01-01T00:00:00Z\n---\n\nbody",
    );
    await trashNote("id-2");
    const body = lastUpdateBody();
    expect(body).toContain("updated: 2026-01-01T00:00:00Z");
    expect(body).toMatch(RFC3339);
  });

  it("preserves folder: while trashing", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\nbody");
    await trashNote("id-3");
    const body = lastUpdateBody();
    expect(body).toContain("folder: Projects/");
    expect(body).toMatch(RFC3339);
  });

  it("is idempotent on an already-trashed note (single trashed line, refreshed)", async () => {
    routeReadThenUpdate("---\ntrashed: 2020-01-01T00:00:00Z\n---\n\nbody");
    await trashNote("id-4");
    const body = lastUpdateBody();
    const occurrences = body.split("\n").filter((l) => /^trashed:/.test(l));
    expect(occurrences).toHaveLength(1);
    expect(body).not.toContain("2020-01-01T00:00:00Z");
  });

  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.reject({ kind: "NoteNotFound" });
      return Promise.resolve(undefined);
    });
    await expect(trashNote("id-x")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("restoreNote", () => {
  it("removes the trashed field, returning a single-field note to bare body", async () => {
    routeReadThenUpdate("---\ntrashed: 2026-06-03T11:00:00Z\n---\n\n# Body");
    await restoreNote("id-1");
    expect(lastUpdateBody()).toBe("# Body");
  });

  it("preserves folder: + updated: when restoring", async () => {
    routeReadThenUpdate(
      "---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\ntrashed: 2026-06-03T11:00:00Z\n---\n\n# Body",
    );
    await restoreNote("id-2");
    const body = lastUpdateBody();
    expect(body).toContain("folder: Projects/");
    expect(body).toContain("updated: 2026-01-01T00:00:00Z");
    expect(body).not.toContain("trashed:");
  });

  it("is a no-op write on a note that is not trashed", async () => {
    routeReadThenUpdate("---\ntitle: Foo\n---\n\nbody");
    await restoreNote("id-3");
    expect(lastUpdateBody()).toBe("---\ntitle: Foo\n---\n\nbody");
  });

  it("trash→restore round-trips to the original bytes", async () => {
    // First trash, capture the body; then feed it back through restore.
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\n# Note");
    await trashNote("id-4");
    const trashedBody = lastUpdateBody();

    invokeMock.mockReset();
    routeReadThenUpdate(trashedBody);
    await restoreNote("id-4");
    expect(lastUpdateBody()).toBe("---\nfolder: Projects/\n---\n\n# Note");
  });

  it("rejects when note_update rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.resolve("---\ntrashed: 2026-06-03T11:00:00Z\n---\n\nx");
      return Promise.reject({ kind: "Io" });
    });
    await expect(restoreNote("id-y")).rejects.toMatchObject({ kind: "Io" });
  });
});

describe("bulkTrashNotes — N independent best-effort trashes", () => {
  it("trashes all notes and reports them as trashed", async () => {
    routeReadThenUpdate("body\n");
    const result = await bulkTrashNotes(["a", "b", "c"]);
    expect(result.trashed.sort()).toEqual(["a", "b", "c"]);
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
    const result = await bulkTrashNotes(["ok1", "bad", "ok2"]);
    expect(result.trashed.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("returns an empty result for an empty input", async () => {
    const result = await bulkTrashNotes([]);
    expect(result).toEqual({ trashed: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
