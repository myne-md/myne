// Unit tests for `src/notes/emptyTrash.ts`. Best-effort bulk delete over
// `deleteNoteRouted` (sync-aware: tombstone under sync, hard unlink local-only),
// mirroring `bulkMoveNotes` — never rejects, reports purged + failed so the UI
// can show a remaining count. The route-to-tombstone-vs-unlink decision itself
// is covered by `deleteNoteRouted.test.ts`; here we only assert orchestration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteNoteRoutedMock = vi.fn();

vi.mock("../../src/notes/deleteNote", () => ({
  deleteNoteRouted: (...args: unknown[]) => deleteNoteRoutedMock(...args),
}));

import { emptyTrash } from "../../src/notes/emptyTrash";

beforeEach(() => deleteNoteRoutedMock.mockReset());
afterEach(() => deleteNoteRoutedMock.mockReset());

describe("emptyTrash", () => {
  it("routes each id through deleteNoteRouted and reports them all purged", async () => {
    deleteNoteRoutedMock.mockResolvedValue(undefined);
    const result = await emptyTrash(["a", "b", "c"]);
    expect(result.purged.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
    expect(deleteNoteRoutedMock).toHaveBeenCalledTimes(3);
    // Sync Bug 3 fix: the bare `note_delete` unlink is gone — deletion goes
    // through the sync-aware router so an emptied trash propagates to peers.
    expect(deleteNoteRoutedMock).toHaveBeenCalledWith("a");
    expect(deleteNoteRoutedMock).toHaveBeenCalledWith("b");
    expect(deleteNoteRoutedMock).toHaveBeenCalledWith("c");
  });

  it("reports per-note failures without aborting the rest", async () => {
    deleteNoteRoutedMock.mockImplementation((id: string) =>
      id === "bad" ? Promise.reject({ kind: "Io" }) : Promise.resolve(undefined),
    );
    const result = await emptyTrash(["ok1", "bad", "ok2"]);
    expect(result.purged.sort()).toEqual(["ok1", "ok2"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.noteId).toBe("bad");
    expect(result.failed[0]?.error).toMatchObject({ kind: "Io" });
  });

  it("returns empty result for empty input and issues no delete", async () => {
    const result = await emptyTrash([]);
    expect(result).toEqual({ purged: [], failed: [] });
    expect(deleteNoteRoutedMock).not.toHaveBeenCalled();
  });

  it("reports all-failed when every delete rejects", async () => {
    deleteNoteRoutedMock.mockRejectedValue({ kind: "VaultNotUnlocked" });
    const result = await emptyTrash(["a", "b"]);
    expect(result.purged).toEqual([]);
    expect(result.failed.map((f) => f.noteId).sort()).toEqual(["a", "b"]);
  });
});
