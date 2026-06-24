// Unit tests for `src/notes/archiveNote.ts` (archiveNote + unarchiveNote +
// bulkArchiveNotes) and the mutual-exclusion contract with `src/notes/trashNote.ts`.
//
// Archive writes `archived: <now>` via patchArchivedField + note_update and clears
// any `trashed:` (archive ⊥ trash). Unarchive deletes `archived:` (state D).
// Deleting an archived note (trashNote) clears `archived:` and writes `trashed:`.
// No transition bumps `updated:`. Mirrors `trashNote.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  archiveNote,
  unarchiveNote,
  bulkArchiveNotes,
  bulkUnarchiveNotes,
} from "../../src/notes/archiveNote";
import { trashNote } from "../../src/notes/trashNote";

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

const ARCHIVED_RFC3339 =
  /archived: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;
const TRASHED_RFC3339 = /trashed: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/;

describe("archiveNote", () => {
  it("writes a valid RFC 3339 archived: into a root note", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await archiveNote("id-1");
    const body = lastUpdateBody();
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toMatch(ARCHIVED_RFC3339);
    expect(body).toContain("# Hello");
  });

  it("does NOT add or bump updated: (archiving is not a content edit)", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await archiveNote("id-1");
    expect(lastUpdateBody()).not.toContain("updated:");
  });

  it("leaves folder: and an existing updated: untouched", async () => {
    routeReadThenUpdate(
      "---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\n---\n\nbody",
    );
    await archiveNote("id-2");
    const body = lastUpdateBody();
    expect(body).toContain("folder: Projects/");
    expect(body).toContain("updated: 2026-01-01T00:00:00Z");
    expect(body).toMatch(ARCHIVED_RFC3339);
  });

  it("archiving a trashed note clears trashed: and sets archived: (mutual exclusion)", async () => {
    routeReadThenUpdate(
      "---\ntrashed: 2026-06-03T11:00:00Z\n---\n\n# Body",
    );
    await archiveNote("id-3");
    const body = lastUpdateBody();
    expect(body).not.toContain("trashed:");
    expect(body).toMatch(ARCHIVED_RFC3339);
  });

  it("is idempotent on an already-archived note (single archived line, refreshed)", async () => {
    routeReadThenUpdate("---\narchived: 2020-01-01T00:00:00Z\n---\n\nbody");
    await archiveNote("id-4");
    const body = lastUpdateBody();
    const occurrences = body.split("\n").filter((l) => /^archived:/.test(l));
    expect(occurrences).toHaveLength(1);
    expect(body).not.toContain("2020-01-01T00:00:00Z");
  });

  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:notes|note_read")
        return Promise.reject({ kind: "NoteNotFound" });
      return Promise.resolve(undefined);
    });
    await expect(archiveNote("id-x")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("unarchiveNote", () => {
  it("removes the archived field, returning a single-field note to bare body", async () => {
    routeReadThenUpdate("---\narchived: 2026-06-17T09:30:00Z\n---\n\n# Body");
    await unarchiveNote("id-1");
    expect(lastUpdateBody()).toBe("# Body");
  });

  it("preserves folder: + updated: when unarchiving (returns to its folder, live)", async () => {
    routeReadThenUpdate(
      "---\nfolder: Projects/\nupdated: 2026-01-01T00:00:00Z\narchived: 2026-06-17T09:30:00Z\n---\n\n# Body",
    );
    await unarchiveNote("id-2");
    const body = lastUpdateBody();
    expect(body).toContain("folder: Projects/");
    expect(body).toContain("updated: 2026-01-01T00:00:00Z");
    expect(body).not.toContain("archived:");
  });

  it("archive→unarchive round-trips to the original bytes", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\n# Note");
    await archiveNote("id-4");
    const archivedBody = lastUpdateBody();

    invokeMock.mockReset();
    routeReadThenUpdate(archivedBody);
    await unarchiveNote("id-4");
    expect(lastUpdateBody()).toBe("---\nfolder: Projects/\n---\n\n# Note");
  });
});

describe("trashNote ⊥ archive — deleting an archived note clears archived:", () => {
  it("trashing an archived note clears archived: and writes trashed:", async () => {
    routeReadThenUpdate(
      "---\narchived: 2026-06-17T09:30:00Z\n---\n\n# Body",
    );
    await trashNote("id-5");
    const body = lastUpdateBody();
    expect(body).not.toContain("archived:");
    expect(body).toMatch(TRASHED_RFC3339);
  });

  it("trashing a plain live note is unaffected (no archived to clear)", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await trashNote("id-6");
    const body = lastUpdateBody();
    expect(body).toMatch(TRASHED_RFC3339);
    expect(body).not.toContain("archived:");
  });
});

describe("bulkArchiveNotes — N independent best-effort archives", () => {
  it("archives all notes and reports them as archived", async () => {
    routeReadThenUpdate("body\n");
    const result = await bulkArchiveNotes(["a", "b", "c"]);
    expect(result.archived.sort()).toEqual(["a", "b", "c"]);
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
    const result = await bulkArchiveNotes(["ok1", "bad", "ok2"]);
    expect(result.archived.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("returns an empty result for an empty input", async () => {
    const result = await bulkArchiveNotes([]);
    expect(result).toEqual({ archived: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("bulkUnarchiveNotes — N independent best-effort restores", () => {
  it("unarchives all notes and reports them as unarchived", async () => {
    routeReadThenUpdate("---\narchived: 2026-06-17T09:30:00Z\n---\n\nbody");
    const result = await bulkUnarchiveNotes(["a", "b", "c"]);
    expect(result.unarchived.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
  });

  it("clears the archived: field on each restored note", async () => {
    routeReadThenUpdate("---\narchived: 2026-06-17T09:30:00Z\n---\n\n# Body");
    await bulkUnarchiveNotes(["only"]);
    expect(lastUpdateBody()).not.toContain("archived:");
  });

  it("reports per-note failures without aborting the rest", async () => {
    invokeMock.mockImplementation((cmd: string, args: unknown) => {
      const id = (args as { noteId?: string }).noteId;
      if (cmd === "plugin:notes|note_read") {
        if (id === "bad") return Promise.reject({ kind: "CannotDecrypt" });
        return Promise.resolve("---\narchived: 2026-06-17T09:30:00Z\n---\n\nbody");
      }
      return Promise.resolve(undefined);
    });
    const result = await bulkUnarchiveNotes(["ok1", "bad", "ok2"]);
    expect(result.unarchived.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
  });

  it("returns an empty result for an empty input", async () => {
    const result = await bulkUnarchiveNotes([]);
    expect(result).toEqual({ unarchived: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
