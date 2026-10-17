// @vitest-environment jsdom
//
// Provider/hook tests for `src/notes/sidebarState.tsx` — the React Context layer
// that wraps the pure transitions (covered separately by sidebarState.test.ts)
// with IPC orchestration. These drive the memoized callbacks via renderHook and
// assert: optimistic insert/select on create, optimistic remove + rollback on a
// failed delete, optimistic trash/restore + refresh round-trip, the trash-flag
// rollback on IPC failure, bulk-trash partial rollback, empty-trash cache prune,
// the rename re-sync nonce bump for the open note, and reloadOpenNote. Every
// `./`-sibling IPC module is mocked at its boundary; the pure helpers
// (renameNote / resolverNotes) stay real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

// ── IPC-boundary module mocks ──────────────────────────────────────────────
const createNote = vi.fn();
const createDrawing = vi.fn();
const mutateDeliberateFolders = vi.fn();
const prefsRead = vi.fn();
const deleteNote = vi.fn();
const deleteNoteRouted = vi.fn();
const trashNote = vi.fn();
const restoreNote = vi.fn();
const bulkTrashNotes = vi.fn();
const emptyTrash = vi.fn();
const noteRead = vi.fn();
const loadNoteBatch = vi.fn();
const noteWriteBatchTransactional = vi.fn();
const planRenameBatch = vi.fn();
const reindexNote = vi.fn();
const vaultIndicesRemove = vi.fn();
const hydrateVaultIndicesOnUnlock = vi.fn();
// The live session's transport (`src/lib/live.ts`). `src/notes/liveNote.ts`
// itself stays REAL, because the routing decision under test IS its refcount.
const liveSessionOpen = vi.fn();
const liveSessionPatchFrontmatter = vi.fn();
const liveSessionClose = vi.fn();

vi.mock("../../src/notes/createNote", () => ({
  createNote: (...a: unknown[]) => createNote(...a),
}));
// myne#653 split the two create paths on whether they enter sidebar rename, so
// the drawing one has to be drivable here to assert that it still does.
vi.mock("../../src/notes/createDrawing", () => ({
  createDrawing: (...a: unknown[]) => createDrawing(...a),
}));
// myne-md/myne#613: the create path registers the folder it just filled, so the
// write has to be observable here. `prefsRead` and `normalizeNewNoteLocation`
// come along because the same module supplies the new-note-location fallback.
vi.mock("../../src/lib/prefs", () => ({
  mutateDeliberateFolders: (...a: unknown[]) => mutateDeliberateFolders(...a),
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  normalizeNewNoteLocation: (v: unknown) => v,
}));
vi.mock("../../src/notes/deleteNote", () => ({
  deleteNote: (...a: unknown[]) => deleteNote(...a),
  deleteNoteRouted: (...a: unknown[]) => deleteNoteRouted(...a),
}));
vi.mock("../../src/notes/trashNote", () => ({
  trashNote: (...a: unknown[]) => trashNote(...a),
  restoreNote: (...a: unknown[]) => restoreNote(...a),
  bulkTrashNotes: (...a: unknown[]) => bulkTrashNotes(...a),
}));
vi.mock("../../src/notes/emptyTrash", () => ({
  emptyTrash: (...a: unknown[]) => emptyTrash(...a),
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: (...a: unknown[]) => noteRead(...a),
}));
vi.mock("../../src/notes/loadNoteBatch", () => ({
  loadNoteBatch: (...a: unknown[]) => loadNoteBatch(...a),
}));
vi.mock("../../src/notes/noteWriteBatch", () => ({
  noteWriteBatchTransactional: (...a: unknown[]) =>
    noteWriteBatchTransactional(...a),
}));
vi.mock("../../src/notes/renameInbound", () => ({
  planRenameBatch: (...a: unknown[]) => planRenameBatch(...a),
  defaultRenameInboundDeps: (deps: unknown) => deps,
}));
vi.mock("../../src/notes/renameFlushHook", () => ({
  renameFlushHooks: () => ({ openNoteIds: () => [], flushOpenPanes: vi.fn() }),
}));
vi.mock("../../src/lib/live", () => ({
  liveSessionOpen: (...a: unknown[]) => liveSessionOpen(...a),
  liveSessionPatchFrontmatter: (...a: unknown[]) =>
    liveSessionPatchFrontmatter(...a),
  liveSessionClose: (...a: unknown[]) => liveSessionClose(...a),
  liveSessionSetPresence: vi.fn(),
  liveSessionTakeRemoteSplices: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNote: (...a: unknown[]) => reindexNote(...a),
  vaultIndicesRemove: (...a: unknown[]) => vaultIndicesRemove(...a),
  hydrateVaultIndicesOnUnlock: (...a: unknown[]) =>
    hydrateVaultIndicesOnUnlock(...a),
}));

import {
  SidebarStateProvider,
  useSelectedNote,
} from "../../src/notes/sidebarState";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import { closeLiveNote, openLiveNote } from "../../src/notes/liveNote";

function rec(id: string, over: Partial<TitleRecord> = {}): TitleRecord {
  return {
    noteUuid: id,
    title: id,
    folder: null,
    updatedAt: null,
    trashed: null,
    deleted: null,
    archived: null,
    template: false,
    folderIndex: false,
    conflict: false,
    conflictOf: null,
    hasSource: false,
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return <SidebarStateProvider>{children}</SidebarStateProvider>;
}

beforeEach(() => {
  for (const m of [
    createNote,
    deleteNote,
    deleteNoteRouted,
    trashNote,
    restoreNote,
    bulkTrashNotes,
    emptyTrash,
    noteRead,
    loadNoteBatch,
    noteWriteBatchTransactional,
    planRenameBatch,
    reindexNote,
    vaultIndicesRemove,
    hydrateVaultIndicesOnUnlock,
    mutateDeliberateFolders,
    prefsRead,
    liveSessionOpen,
    liveSessionPatchFrontmatter,
    liveSessionClose,
  ]) {
    m.mockReset();
  }
  loadNoteBatch.mockResolvedValue([]);
  reindexNote.mockResolvedValue(undefined);
  // The create path registers the folder it filled (myne-md/myne#613). It is
  // fire-and-forget, so the spy must still return a promise or the .catch()
  // throws inside the caller.
  mutateDeliberateFolders.mockResolvedValue(0);
  prefsRead.mockResolvedValue({ new_note_location: null });
  vaultIndicesRemove.mockResolvedValue(undefined);
  hydrateVaultIndicesOnUnlock.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("useSelectedNote — guard", () => {
  it("throws when used outside the provider", () => {
    expect(() => renderHook(() => useSelectedNote())).toThrow(
      /must be used inside/i,
    );
  });
});

describe("useSelectedNote — select / open", () => {
  it("select updates selectedId without loading content", () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    act(() => result.current.select("note-1"));
    expect(result.current.selectedId).toBe("note-1");
    expect(noteRead).not.toHaveBeenCalled();
  });

  it("open selects the id AND reads its body", async () => {
    noteRead.mockResolvedValue("# Body");
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    let body = "";
    await act(async () => {
      body = await result.current.open("note-2");
    });
    expect(result.current.selectedId).toBe("note-2");
    expect(noteRead).toHaveBeenCalledWith("note-2");
    expect(body).toBe("# Body");
  });
});

describe("useSelectedNote — create", () => {
  it("createAndStartRename seeds an optimistic Untitled row and selects it", async () => {
    createNote.mockResolvedValue("new-id");
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    let id = "";
    await act(async () => {
      id = await result.current.createAndStartRename();
    });
    expect(id).toBe("new-id");
    expect(result.current.selectedId).toBe("new-id");
    // myne#653: creating a note must NOT enter sidebar rename. The note carries
    // its own `title:` field now, and seeding rename here pulled focus into an
    // input that vanishes on blur, leaving a fresh note untitleable from
    // either place. Asserted as `null` rather than omitted, because "we stopped
    // setting it" is the fix and an absent assertion would not notice it coming
    // back.
    expect(result.current.renamingId).toBeNull();
    // myne#654: it IS recorded as the session's newest create, which is what
    // pins it to the top of its container in the tree.
    expect(result.current.justCreatedId).toBe("new-id");
    const row = result.current.cache.get("new-id");
    expect(row?.title).toBeNull(); // Untitled placeholder
    expect(reindexNote).toHaveBeenCalledWith("new-id");
  });

  it("a drawing create DOES enter rename, it has no in-note title field", async () => {
    createDrawing.mockResolvedValue("draw-id");
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    await act(async () => {
      await result.current.createDrawingAndStartRename();
    });
    // The asymmetry with the note case above is deliberate, not leftover: a
    // drawing's body is a fenced Excalidraw scene, so the sidebar rename is the
    // only place its name can come from.
    expect(result.current.renamingId).toBe("draw-id");
    expect(result.current.justCreatedId).toBe("draw-id");
  });

  it("a foldered create refreshes the row to settle its folder", async () => {
    createNote.mockResolvedValue("f-id");
    loadNoteBatch.mockResolvedValue([rec("f-id", { folder: "Daily/" })]);
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    await act(async () => {
      await result.current.createAndStartRename("Daily/");
    });
    expect(createNote).toHaveBeenCalledWith("Daily/");
    expect(loadNoteBatch).toHaveBeenCalledWith(["f-id"]);
  });

  it("hands the resolved folder to the create, which is what registers it", async () => {
    // The registration itself moved to `noteCreate`, the chokepoint every create
    // path shares (myne-md/myne#613 pr-review), and it is asserted there, in
    // `tests/notes/createDeleteNote.test.ts`. `createNote` is mocked here, so
    // what this file can still prove is the half it owns: the sidebar resolves a
    // target and passes it down. Registering here TOO would be a second full
    // `vault.prefs` re-encrypt for one note.
    createNote.mockResolvedValue("f-id");
    loadNoteBatch.mockResolvedValue([rec("f-id", { folder: "Daily/" })]);
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    await act(async () => {
      await result.current.createAndStartRename("Daily/");
    });
    expect(createNote).toHaveBeenCalledWith("Daily/");
    expect(mutateDeliberateFolders).not.toHaveBeenCalled();
  });

  it("a root create passes null down and registers nothing", async () => {
    createNote.mockResolvedValue("r-id");
    loadNoteBatch.mockResolvedValue([rec("r-id")]);
    prefsRead.mockResolvedValue({ new_note_location: null });
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    await act(async () => {
      await result.current.createAndStartRename(null);
    });
    expect(createNote).toHaveBeenCalledWith(null);
    expect(mutateDeliberateFolders).not.toHaveBeenCalled();
  });
});

describe("useSelectedNote — delete with rollback", () => {
  it("optimistically removes then drops from the index on success", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    // Seed a row via refreshAll.
    loadNoteBatch.mockResolvedValueOnce([rec("d-1")]);
    await act(async () => {
      await result.current.refreshAll(["d-1"]);
    });
    expect(result.current.cache.has("d-1")).toBe(true);

    deleteNoteRouted.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.deleteWithRollback("d-1");
    });
    expect(result.current.cache.has("d-1")).toBe(false);
    expect(vaultIndicesRemove).toHaveBeenCalledWith("d-1");
    // Sync Bug 3 fix (single-purge half): a trash purge routes through the
    // sync-aware deleter so a `deleted:` tombstone propagates to peers — NOT a
    // bare local-only `note_delete` unlink that never reaches the other device.
    expect(deleteNoteRouted).toHaveBeenCalledWith("d-1");
  });

  it("rolls the row back and rethrows when the IPC rejects", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([rec("d-2", { title: "Keep" })]);
    await act(async () => {
      await result.current.refreshAll(["d-2"]);
    });
    deleteNoteRouted.mockRejectedValue(new Error("io"));
    await act(async () => {
      await expect(result.current.deleteWithRollback("d-2")).rejects.toThrow("io");
    });
    // Restored after rollback.
    expect(result.current.cache.get("d-2")?.title).toBe("Keep");
    expect(vaultIndicesRemove).not.toHaveBeenCalled();
  });
});

describe("useSelectedNote — trash / restore", () => {
  it("trashWithRollback sets the trashed marker then refreshes", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([rec("t-1")]);
    await act(async () => {
      await result.current.refreshAll(["t-1"]);
    });
    trashNote.mockResolvedValue(undefined);
    loadNoteBatch.mockResolvedValueOnce([
      rec("t-1", { trashed: "2026-06-16T00:00:00Z" }),
    ]);
    await act(async () => {
      await result.current.trashWithRollback("t-1");
    });
    expect(trashNote).toHaveBeenCalledWith("t-1");
    expect(result.current.cache.get("t-1")?.trashed).toBe(
      "2026-06-16T00:00:00Z",
    );
  });

  it("trashWithRollback restores the prior marker on IPC failure", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([rec("t-2")]);
    await act(async () => {
      await result.current.refreshAll(["t-2"]);
    });
    trashNote.mockRejectedValue(new Error("nope"));
    await act(async () => {
      await expect(result.current.trashWithRollback("t-2")).rejects.toThrow(
        "nope",
      );
    });
    // Back to live (trashed cleared).
    expect(result.current.cache.get("t-2")?.trashed).toBeNull();
  });

  it("restoreWithRollback clears the trashed marker then refreshes", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([rec("r-1", { trashed: "2026-06-01T00:00:00Z" })]);
    await act(async () => {
      await result.current.refreshAll(["r-1"]);
    });
    restoreNote.mockResolvedValue(undefined);
    loadNoteBatch.mockResolvedValueOnce([rec("r-1", { trashed: null })]);
    await act(async () => {
      await result.current.restoreWithRollback("r-1");
    });
    expect(restoreNote).toHaveBeenCalledWith("r-1");
    expect(result.current.cache.get("r-1")?.trashed).toBeNull();
  });
});

describe("useSelectedNote — bulk trash + empty trash", () => {
  it("bulkTrashWithSync rolls back only the failed ids", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([rec("b-1"), rec("b-2")]);
    await act(async () => {
      await result.current.refreshAll(["b-1", "b-2"]);
    });
    // b-1 succeeds, b-2 fails.
    bulkTrashNotes.mockResolvedValue({
      trashed: ["b-1"],
      failed: [{ noteId: "b-2", error: "lock" }],
    });
    loadNoteBatch.mockResolvedValue([rec("b-1", { trashed: "2026-06-16T00:00:00Z" })]);
    await act(async () => {
      await result.current.bulkTrashWithSync(["b-1", "b-2"]);
    });
    // b-2 rolled back to live; b-1 stays trashed.
    expect(result.current.cache.get("b-2")?.trashed).toBeNull();
    expect(result.current.cache.get("b-1")?.trashed).not.toBeNull();
  });

  it("bulkTrashWithSync short-circuits on an empty id list (no IPC)", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    let out;
    await act(async () => {
      out = await result.current.bulkTrashWithSync([]);
    });
    expect(out).toEqual({ trashed: [], failed: [] });
    expect(bulkTrashNotes).not.toHaveBeenCalled();
  });

  it("emptyTrashWithSync drops purged ids from the cache + index", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValueOnce([
      rec("e-1", { trashed: "x" }),
      rec("e-2", { trashed: "y" }),
    ]);
    await act(async () => {
      await result.current.refreshAll(["e-1", "e-2"]);
    });
    emptyTrash.mockResolvedValue({ purged: ["e-1"], failed: [] });
    await act(async () => {
      await result.current.emptyTrashWithSync(["e-1"]);
    });
    expect(result.current.cache.has("e-1")).toBe(false);
    expect(result.current.cache.has("e-2")).toBe(true);
    expect(vaultIndicesRemove).toHaveBeenCalledWith("e-1");
  });
});

describe("useSelectedNote — rename re-sync", () => {
  it("commitRename bumps contentReloadNonce when the renamed note is open", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValue([rec("rn-1", { title: "Old" })]);
    await act(async () => {
      await result.current.refreshAll(["rn-1"]);
    });
    act(() => result.current.select("rn-1")); // it's the open note
    const before = result.current.contentReloadNonce;

    // A ONE-ENTRY batch, not an empty one: `commitRename` routes live-owned
    // entries through the session and sends the REST to the batch, so an empty
    // batch now means "nothing to write" and the mock under test is never
    // called. The fixture has to hold the state the assertion is about.
    planRenameBatch.mockResolvedValue({
      batch: [{ noteId: "rn-1", plaintext: "# New\n" }],
      inboundIds: [],
    });
    noteWriteBatchTransactional.mockResolvedValue(undefined);
    // The post-write refreshOne() round-trip returns the canonical new title.
    loadNoteBatch.mockResolvedValue([rec("rn-1", { title: "New" })]);
    await act(async () => {
      await result.current.commitRename("rn-1", "# Old\n", "New");
    });
    expect(noteWriteBatchTransactional).toHaveBeenCalled();
    // Open note's body must be re-read → nonce bumped.
    expect(result.current.contentReloadNonce).toBe(before + 1);
    // The renamed title settles to the canonical refresh value.
    expect(result.current.cache.get("rn-1")?.title).toBe("New");
  });

  it("routes a live-owned note through its session, not the refused batch (SYNC-33)", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValue([rec("rn-live", { title: "Old" })]);
    await act(async () => {
      await result.current.refreshAll(["rn-live"]);
    });
    act(() => result.current.select("rn-live"));

    // The renamed note is OPEN in a pane, so a live session owns it. `SYNC-33`
    // makes that session the single durable writer, and the batch command
    // refuses the WHOLE set over such a note (`NoteBatchError::LiveSessionOpen`),
    // checked before any filesystem touch. Renaming an open note therefore
    // failed outright with nothing written: `rename-inbound-links` ril1 renamed
    // its target in exactly this state and the app's own toast said so.
    liveSessionOpen.mockResolvedValue(undefined);
    await act(async () => {
      await openLiveNote("rn-live");
    });

    planRenameBatch.mockResolvedValue({
      batch: [{ noteId: "rn-live", plaintext: "# New\n" }],
      inboundIds: [],
    });
    liveSessionPatchFrontmatter.mockResolvedValue(undefined);
    noteWriteBatchTransactional.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.commitRename("rn-live", "# Old\n", "New");
    });

    expect(
      liveSessionPatchFrontmatter,
      "a live-owned note must be written THROUGH its session",
    ).toHaveBeenCalledWith("rn-live", "# New\n");
    expect(
      noteWriteBatchTransactional,
      "and must not be handed to the batch that refuses it",
    ).not.toHaveBeenCalled();

    // The refcount is module scope: leave it as this test found it.
    await act(async () => {
      await closeLiveNote("rn-live");
    });
  });

  it("commitRename rolls the title back when the batch write rejects", async () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    loadNoteBatch.mockResolvedValue([rec("rn-2", { title: "Original" })]);
    await act(async () => {
      await result.current.refreshAll(["rn-2"]);
    });
    planRenameBatch.mockResolvedValue({
      batch: [{ noteId: "rn-2", plaintext: "# Renamed\n" }],
      inboundIds: [],
    });
    noteWriteBatchTransactional.mockRejectedValue(new Error("disk full"));
    await act(async () => {
      await expect(
        result.current.commitRename("rn-2", "# Original\n", "Renamed"),
      ).rejects.toThrow("disk full");
    });
    expect(result.current.cache.get("rn-2")?.title).toBe("Original");
  });
});

describe("useSelectedNote — reloadOpenNote", () => {
  it("bumps the nonce unconditionally — even with nothing selected", () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    // No selection still bumps: a sync pull can rewrite notes parked in
    // unfocused panes (or behind a focused view/graph tab) while nothing is
    // selected; panes apply their own dirty guards (stale-pane overwrite fix).
    act(() => result.current.reloadOpenNote());
    expect(result.current.contentReloadNonce).toBe(1);

    act(() => result.current.select("open-note"));
    act(() => result.current.reloadOpenNote());
    expect(result.current.contentReloadNonce).toBe(2);
  });
});

describe("useSelectedNote — rename mode", () => {
  it("startRename / cancelRename toggle renamingId", () => {
    const { result } = renderHook(() => useSelectedNote(), { wrapper });
    act(() => result.current.startRename("x"));
    expect(result.current.renamingId).toBe("x");
    act(() => result.current.cancelRename());
    expect(result.current.renamingId).toBeNull();
  });
});
