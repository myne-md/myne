// Unit tests for `src/notes/emptyTrash.ts`. Best-effort bulk hard-delete over
// note_delete, mirroring `bulkMoveNotes` — never rejects, reports purged +
// failed so the UI can show a remaining count.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { emptyTrash } from "../../src/notes/emptyTrash";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

describe("emptyTrash", () => {
  it("hard-deletes each id and reports them all purged", async () => {
    invokeMock.mockResolvedValue(undefined);
    const result = await emptyTrash(["a", "b", "c"]);
    expect(result.purged.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenCalledWith("plugin:notes|note_delete", {
      noteId: "a",
    });
  });

  it("reports per-note failures without aborting the rest", async () => {
    invokeMock.mockImplementation((_cmd: string, args: unknown) => {
      const id = (args as { noteId?: string }).noteId;
      if (id === "bad") return Promise.reject({ kind: "Io" });
      return Promise.resolve(undefined);
    });
    const result = await emptyTrash(["ok1", "bad", "ok2"]);
    expect(result.purged.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
    expect(result.failed[0]?.error).toMatchObject({ kind: "Io" });
  });

  it("returns empty result for empty input and issues no IPC", async () => {
    const result = await emptyTrash([]);
    expect(result).toEqual({ purged: [], failed: [] });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reports all-failed when every delete rejects", async () => {
    invokeMock.mockRejectedValue({ kind: "VaultNotUnlocked" });
    const result = await emptyTrash(["a", "b"]);
    expect(result.purged).toEqual([]);
    expect(result.failed.map((f) => f.noteId).sort()).toEqual(["a", "b"]);
  });
});
