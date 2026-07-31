// @vitest-environment jsdom
//
// `useFolderManagement` hook — sidebar folder-tree interaction state + handlers.
// The hook centralizes transient UI state (context menu / new-folder input /
// inline rename / block notice / case-merge confirm / folder-delete confirm /
// drag-drop target) and the create / rename / move / delete / reorder / favorite
// operations that wire the pure logic + the prefs-set IPC layer.
//
// We mock the IPC boundary only (`lib/prefs`, `folderActions`, `moveNote`,
// `usePrefs`); the pure helpers (`folderPath`, `decorationRewrite`,
// `folderTreeRows`, `itemOrderReorder`, `folderTree`, `tabDrag`, `workspaceState`)
// stay real so the handlers' wiring + the grammar/case-merge/prefix-rewrite
// branches are exercised end-to-end. The latest derived tree is injected via the
// exposed `treeRef`, exactly as the consumer (`NoteList`) does.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, renderHook } from "@testing-library/react";

// ---- IPC-boundary mocks ---------------------------------------------------

const prefs = {
  deliberate_folders: [] as string[],
  archived_folders: [] as string[],
  item_order: {} as Record<string, string[]>,
  favorites: [] as string[],
  item_colors: {} as Record<string, string>,
  folder_icons: {} as Record<string, string>,
};
vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs }),
}));

const setDeliberateFolders = vi.fn(() => Promise.resolve());
const setArchivedFolders = vi.fn(() => Promise.resolve());
const setFavorites = vi.fn(() => Promise.resolve());
const setFolderIcons = vi.fn(() => Promise.resolve());
const setItemColors = vi.fn(() => Promise.resolve());
const setItemOrder = vi.fn(() => Promise.resolve());
vi.mock("../../src/lib/prefs", () => ({
  setDeliberateFolders: (...a: unknown[]) => setDeliberateFolders(...a),
  setArchivedFolders: (...a: unknown[]) => setArchivedFolders(...a),
  setFavorites: (...a: unknown[]) => setFavorites(...a),
  setFolderIcons: (...a: unknown[]) => setFolderIcons(...a),
  setItemColors: (...a: unknown[]) => setItemColors(...a),
  setItemOrder: (...a: unknown[]) => setItemOrder(...a),
}));

const moveNote = vi.fn(() => Promise.resolve());
vi.mock("../../src/notes/moveNote", () => ({
  moveNote: (...a: unknown[]) => moveNote(...a),
}));

// folderActions is mocked so we observe how the hook calls it + control results;
// the pure-plan unit semantics are covered by folderActions.test.ts.
const planFolderDelete = vi.fn();
const persistFolderDelete = vi.fn(() => Promise.resolve());
const renameFolder = vi.fn();
// Folder-archive planners: default to no-op returns so the existing
// rename/delete tests are unaffected (their archived-set semantics are covered
// directly in folderActions.test.ts). `archived_folders` is `[]` in the prefs
// mock, so these no-ops never trigger a `setArchivedFolders` write.
const planFolderArchive = vi.fn(() => ({ nextArchived: [], noteIds: [] }));
const planFolderUnarchive = vi.fn(() => [] as string[]);
const rerootArchivedFolders = vi.fn(() => ({ next: [] as string[], rewritten: 0 }));
vi.mock("../../src/notes/folderActions", () => ({
  planFolderDelete: (...a: unknown[]) => planFolderDelete(...a),
  persistFolderDelete: (...a: unknown[]) => persistFolderDelete(...a),
  renameFolder: (...a: unknown[]) => renameFolder(...a),
  planFolderArchive: (...a: unknown[]) => planFolderArchive(...a),
  planFolderUnarchive: (...a: unknown[]) => planFolderUnarchive(...a),
  rerootArchivedFolders: (...a: unknown[]) => rerootArchivedFolders(...a),
}));

import { useFolderManagement } from "../../src/notes/components/useFolderManagement";
import { deriveFolderTree } from "../../src/notes/folderTree";
import type { TitleRecord } from "../../src/notes/loadNoteBatch";
import type { FolderNode } from "../../src/notes/folderTree";
import type { UseSelectedNoteReturn } from "../../src/notes/sidebarState";

// ---- fixtures -------------------------------------------------------------

function rec(id: string, folder: string | null): TitleRecord {
  return {
    noteUuid: id,
    title: id,
    folder,
    updatedAt: new Date(0),
    trashed: null,
    template: false,
  };
}

function makeCtx(records: TitleRecord[], over: Partial<UseSelectedNoteReturn> = {}) {
  const cache = new Map(records.map((r) => [r.noteUuid, r] as const));
  const ctx = {
    selectedId: null,
    selectedIds: new Set<string>(),
    anchorId: null,
    renamingId: null,
    cache,
    contentReloadNonce: 0,
    reloadOpenNote: vi.fn(),
    select: vi.fn(),
    toggleInSelection: vi.fn(),
    selectRange: vi.fn(),
    clearMultiSelection: vi.fn(),
    replaceSelection: vi.fn(),
    open: vi.fn(),
    startRename: vi.fn(),
    cancelRename: vi.fn(),
    commitRename: vi.fn(),
    createAndStartRename: vi.fn(() => Promise.resolve("new-id")),
    deleteWithRollback: vi.fn(),
    trashWithRollback: vi.fn(),
    restoreWithRollback: vi.fn(),
    emptyTrashWithSync: vi.fn(),
    bulkTrashWithSync: vi.fn(() => Promise.resolve()),
    bulkMoveWithSync: vi.fn(() => Promise.resolve({ moved: [], failed: [] })),
    refreshOne: vi.fn(() => Promise.resolve()),
    refreshAll: vi.fn(),
    ...over,
  } as unknown as UseSelectedNoteReturn;
  return { ctx, cache };
}

// Mount the hook + inject a derived tree into its exposed treeRef (the consumer
// does this on every render). Returns the renderHook result.
function mount(records: TitleRecord[], deliberate: string[] = [], ctxOver = {}) {
  const { ctx } = makeCtx(records, ctxOver);
  const r = renderHook(() => useFolderManagement(ctx));
  const tree = deriveFolderTree(
    records.map((n) => ({ noteUuid: n.noteUuid, folder: n.folder })),
    deliberate,
  );
  act(() => {
    r.result.current.treeRef.current = tree;
  });
  return { ...r, ctx };
}

// A minimal DataTransfer stub for drag-start handlers (they call setData +
// effectAllowed). jsdom has no DataTransfer in synthetic events.
function dtStub(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "",
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
  } as unknown as DataTransfer;
}
function dragStartEvent() {
  return { dataTransfer: dtStub() } as never;
}

function findNode(nodes: readonly FolderNode[], key: string): FolderNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = findNode(n.children, key);
    if (hit) return hit;
  }
  return null;
}

beforeEach(() => {
  prefs.deliberate_folders = [];
  prefs.item_order = {};
  prefs.favorites = [];
  prefs.item_colors = {};
  prefs.folder_icons = {};
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------

describe("prefs sync", () => {
  it("hydrates deliberate / itemOrder / favorites / decorations from mount-time prefs", () => {
    prefs.deliberate_folders = ["Drafts/"];
    prefs.item_order = { "": ["n1", "Drafts/"] };
    prefs.favorites = ["n1"];
    prefs.item_colors = { n1: "rose" };
    prefs.folder_icons = { "Drafts/": "star" };
    const { result } = mount([rec("n1", null)], ["Drafts/"]);
    expect(result.current.deliberate).toEqual(["Drafts/"]);
    expect(result.current.itemOrder).toEqual({ "": ["n1", "Drafts/"] });
    expect(result.current.favorites).toEqual(["n1"]);
    expect(result.current.itemColors).toEqual({ n1: "rose" });
    // Fold-on-load (MYND-562): the display-cased folder key migrates to its
    // folded identity; the note-UUID color key passes through unchanged.
    expect(result.current.folderIcons).toEqual({ "drafts/": "star" });
  });
});

describe("context menu", () => {
  it("openMenu sets the menu state; closeMenu clears it", () => {
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.openMenu(node, { x: 5, y: 7 }));
    expect(result.current.menu).toMatchObject({ node, x: 5, y: 7 });
    act(() => result.current.closeMenu());
    expect(result.current.menu).toBeNull();
  });
});

describe("create folder", () => {
  it("startNewFolder opens the input + closes any menu; cancel clears it", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    expect(result.current.newFolder).toEqual({ parentPath: "" });
    expect(result.current.menu).toBeNull();
    act(() => result.current.cancelNewFolder());
    expect(result.current.newFolder).toBeNull();
  });

  it("commit a legal new top-level folder → adds to deliberate + persists", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("Ideas"));
    expect(result.current.deliberate).toContain("Ideas/");
    expect(setDeliberateFolders).toHaveBeenCalledWith(["Ideas/"]);
    expect(result.current.newFolder).toBeNull();
  });

  it("empty input → cancel, no persist, no notice", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder(""));
    expect(result.current.newFolder).toBeNull();
    expect(result.current.blockNotice).toBeNull();
    expect(setDeliberateFolders).not.toHaveBeenCalled();
  });

  it("illegal segment → block notice raised, input kept open, no persist", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    // A segment containing a backslash is grammar-illegal (markdown-dialect §3.6.2).
    act(() => result.current.commitNewFolder("bad\\name"));
    expect(result.current.blockNotice).toMatch(/can't contain/);
    expect(result.current.newFolder).not.toBeNull(); // still editing
    expect(setDeliberateFolders).not.toHaveBeenCalled();
  });

  it("commit with no open input is a no-op", () => {
    const { result } = mount([]);
    act(() => result.current.commitNewFolder("X"));
    expect(setDeliberateFolders).not.toHaveBeenCalled();
  });

  it("case-only collision with an implicit folder → confirm a merge before adding", () => {
    // "Work/" exists only implicitly (a note lives there), NOT in the deliberate
    // set. Typing "work" collides on case-fold → confirm promotes it to deliberate.
    const { result } = mount([rec("n1", "Work/")], []);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("work"));
    expect(result.current.caseMerge).toMatchObject({
      path: "work/",
      existingDisplay: "Work/",
    });
    // Not yet added — awaiting confirmation.
    expect(setDeliberateFolders).not.toHaveBeenCalled();
    act(() => result.current.confirmCaseMerge());
    expect(result.current.caseMerge).toBeNull();
    expect(setDeliberateFolders).toHaveBeenCalledWith(["work/"]);
  });

  it("cancelCaseMerge drops the pending merge without adding", () => {
    const { result } = mount([rec("n1", "Work/")], []);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("work"));
    act(() => result.current.cancelCaseMerge());
    expect(result.current.caseMerge).toBeNull();
    expect(setDeliberateFolders).not.toHaveBeenCalled();
  });

  it("does not re-add a folder already present in the deliberate set", () => {
    prefs.deliberate_folders = ["Ideas/"];
    const { result } = mount([], ["Ideas/"]);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("Ideas"));
    // Same path → addDeliberate is a no-op (no persist), set unchanged.
    expect(setDeliberateFolders).not.toHaveBeenCalled();
    expect(result.current.deliberate).toEqual(["Ideas/"]);
  });
});

describe("new note in folder", () => {
  it("newNoteHere closes the menu and asks ctx to create+rename in the folder", () => {
    const { result, ctx } = mount([]);
    act(() => result.current.newNoteHere("Work/"));
    expect(ctx.createAndStartRename).toHaveBeenCalledWith("Work/");
    expect(result.current.menu).toBeNull();
  });
});

describe("rename folder", () => {
  it("startRenameFolder marks the key; cancel clears it", () => {
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.startRenameFolder(node));
    expect(result.current.renamingFolderKey).toBe("work/");
    act(() => result.current.cancelRenameFolder());
    expect(result.current.renamingFolderKey).toBeNull();
  });

  it("commit rename with a legal name → calls renameFolder, refreshes moved, updates deliberate", async () => {
    renameFolder.mockResolvedValue({
      moved: ["n1"],
      failed: [],
      deliberateRewritten: 1,
      nextDeliberate: ["Workspace/"],
      invalid: false,
    });
    prefs.deliberate_folders = ["Work/"];
    const { result, ctx } = mount([rec("n1", "Work/")], ["Work/"]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.startRenameFolder(node));
    await act(async () => {
      await result.current.commitRenameFolder(node, "Workspace");
    });
    expect(renameFolder).toHaveBeenCalledWith(
      "Work/",
      "Workspace/",
      expect.any(Array),
      ["Work/"],
    );
    expect(result.current.deliberate).toEqual(["Workspace/"]);
    expect(ctx.refreshOne).toHaveBeenCalledWith("n1");
    expect(result.current.renamingFolderKey).toBeNull();
  });

  it("illegal new segment → block notice, renameFolder NOT called, input kept open", async () => {
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.startRenameFolder(node));
    await act(async () => {
      await result.current.commitRenameFolder(node, "a/b");
    });
    expect(renameFolder).not.toHaveBeenCalled();
    expect(result.current.blockNotice).toMatch(/can't contain/);
    expect(result.current.renamingFolderKey).toBe("work/"); // still editing
  });

  it("re-roots decorations on a valid rename (color + icon follow the new path)", async () => {
    renameFolder.mockResolvedValue({
      moved: [],
      failed: [],
      deliberateRewritten: 0,
      nextDeliberate: [],
      invalid: false,
    });
    // Already-folded inputs (MYND-562) so hydrate does not itself persist —
    // the only persist under test is the rename re-root.
    prefs.item_colors = { "work/": "rose" };
    prefs.folder_icons = { "work/": "star" };
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    await act(async () => {
      await result.current.commitRenameFolder(node, "Workspace");
    });
    // The folder's color + icon are re-keyed onto the folded workspace/ and
    // persisted (decorations key by folded identity, never the display path).
    expect(setItemColors).toHaveBeenCalledWith({ "workspace/": "rose" });
    expect(setFolderIcons).toHaveBeenCalledWith({ "workspace/": "star" });
  });

  it("does NOT re-root decorations when the rename was invalid", async () => {
    renameFolder.mockResolvedValue({
      moved: [],
      failed: [],
      deliberateRewritten: 0,
      nextDeliberate: [],
      invalid: true,
    });
    // Already-folded input so fold-on-load is a no-op — the assertion then
    // cleanly proves the INVALID rename path never persists.
    prefs.item_colors = { "work/": "rose" };
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    await act(async () => {
      await result.current.commitRenameFolder(node, "Workspace");
    });
    expect(setItemColors).not.toHaveBeenCalled();
  });
});

describe("delete folder", () => {
  it("note-empty folder → deletes immediately (no confirm dialog)", async () => {
    planFolderDelete.mockReturnValue({
      noteIds: [],
      nextDeliberate: [],
      removed: ["Drafts/"],
    });
    const { result, ctx } = mount([], ["Drafts/"]);
    const node = findNode(result.current.treeRef.current.roots, "drafts/")!;
    await act(async () => {
      result.current.deleteFolderAction(node);
      await Promise.resolve();
    });
    expect(result.current.confirmFolderDelete).toBeNull();
    expect(ctx.bulkTrashWithSync).not.toHaveBeenCalled();
    expect(persistFolderDelete).toHaveBeenCalled();
    expect(result.current.deliberate).toEqual([]);
  });

  it("non-empty folder → opens the confirm dialog instead of deleting", () => {
    planFolderDelete.mockReturnValue({
      noteIds: ["n1", "n2"],
      nextDeliberate: [],
      removed: ["Work/"],
    });
    const { result, ctx } = mount([rec("n1", "Work/"), rec("n2", "Work/")], ["Work/"]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.deleteFolderAction(node));
    expect(result.current.confirmFolderDelete).toMatchObject({ noteCount: 2 });
    // Nothing destroyed yet.
    expect(ctx.bulkTrashWithSync).not.toHaveBeenCalled();
    expect(persistFolderDelete).not.toHaveBeenCalled();
  });

  it("confirm → trashes the subtree notes, persists, prunes decorations", async () => {
    planFolderDelete.mockReturnValue({
      noteIds: ["n1"],
      nextDeliberate: [],
      removed: ["Work/"],
    });
    prefs.item_colors = { "Work/": "rose" };
    const { result, ctx } = mount([rec("n1", "Work/")], ["Work/"]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.deleteFolderAction(node));
    await act(async () => {
      result.current.confirmFolderDeleteAction();
      await Promise.resolve();
    });
    expect(ctx.bulkTrashWithSync).toHaveBeenCalledWith(["n1"]);
    expect(persistFolderDelete).toHaveBeenCalled();
    // The deleted folder's color is pruned.
    expect(setItemColors).toHaveBeenCalledWith({});
    expect(result.current.confirmFolderDelete).toBeNull();
  });

  it("confirm deselects the open note when it just went to Trash", async () => {
    planFolderDelete.mockReturnValue({
      noteIds: ["n1"],
      nextDeliberate: [],
      removed: ["Work/"],
    });
    const { result, ctx } = mount([rec("n1", "Work/")], ["Work/"], {
      selectedId: "n1",
    });
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.deleteFolderAction(node));
    await act(async () => {
      result.current.confirmFolderDeleteAction();
      await Promise.resolve();
    });
    expect(ctx.select).toHaveBeenCalledWith(null);
  });

  it("cancelFolderDelete drops the pending confirm without trashing", () => {
    planFolderDelete.mockReturnValue({
      noteIds: ["n1"],
      nextDeliberate: [],
      removed: ["Work/"],
    });
    const { result, ctx } = mount([rec("n1", "Work/")], ["Work/"]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() => result.current.deleteFolderAction(node));
    act(() => result.current.cancelFolderDelete());
    expect(result.current.confirmFolderDelete).toBeNull();
    expect(ctx.bulkTrashWithSync).not.toHaveBeenCalled();
  });

  it("confirm is a no-op when there is no pending delete", async () => {
    const { result, ctx } = mount([rec("n1", "Work/")]);
    await act(async () => {
      result.current.confirmFolderDeleteAction();
      await Promise.resolve();
    });
    expect(ctx.bulkTrashWithSync).not.toHaveBeenCalled();
    expect(planFolderDelete).not.toHaveBeenCalled();
  });
});

describe("block notice auto-dismiss", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears itself after the 4s timeout", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("bad\\name"));
    expect(result.current.blockNotice).not.toBeNull();
    act(() => vi.advanceTimersByTime(4000));
    expect(result.current.blockNotice).toBeNull();
  });

  it("dismissBlock clears it immediately", () => {
    const { result } = mount([]);
    act(() => result.current.startNewFolder(""));
    act(() => result.current.commitNewFolder("bad\\name"));
    act(() => result.current.dismissBlock());
    expect(result.current.blockNotice).toBeNull();
  });
});

describe("decoration setters", () => {
  it("setItemColor assigns a slot and persists the whole pruned map", async () => {
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      result.current.setItemColor("n1", "rose");
      await Promise.resolve();
    });
    expect(setItemColors).toHaveBeenCalledWith({ n1: "rose" });
    expect(result.current.itemColors).toEqual({ n1: "rose" });
  });

  it("setItemColor(null) clears the key (omit-when-empty)", async () => {
    prefs.item_colors = { n1: "rose" };
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      result.current.setItemColor("n1", null);
      await Promise.resolve();
    });
    expect(setItemColors).toHaveBeenCalledWith({});
  });

  it("setItemColor prunes a stale note-keyed entry on write (lazy GC)", async () => {
    prefs.item_colors = { ghost: "amber" }; // no live note
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      result.current.setItemColor("n1", "rose");
      await Promise.resolve();
    });
    // The stale "ghost" key is dropped; only the live note's color persists.
    expect(setItemColors).toHaveBeenCalledWith({ n1: "rose" });
  });

  it("setItemColor reverts the optimistic map when persist rejects", async () => {
    setItemColors.mockRejectedValueOnce(new Error("over cap"));
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      result.current.setItemColor("n1", "rose");
      await Promise.resolve();
    });
    // Optimistic flip rolled back to the empty pre-write map.
    expect(result.current.itemColors).toEqual({});
  });

  it("setFolderIcon assigns + clears an icon by path", async () => {
    const { result } = mount([rec("n1", "Work/")]);
    await act(async () => {
      result.current.setFolderIcon("Work/", "star");
      await Promise.resolve();
    });
    expect(setFolderIcons).toHaveBeenCalledWith({ "Work/": "star" });
    await act(async () => {
      result.current.setFolderIcon("Work/", null);
      await Promise.resolve();
    });
    expect(setFolderIcons).toHaveBeenLastCalledWith({});
  });
});

describe("drag start / end + drop-into-folder", () => {
  function dt() {
    const store: Record<string, string> = {};
    return {
      effectAllowed: "",
      setData: (k: string, v: string) => {
        store[k] = v;
      },
      getData: (k: string) => store[k] ?? "",
    } as unknown as DataTransfer;
  }

  it("onNoteDragStart sets dragKind=note and stashes the dragged id (drop moves it)", async () => {
    const { result, ctx } = mount([rec("n1", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    expect(result.current.dragKind).toBe("note");
    await act(async () => {
      await result.current.onFolderDropNote("Work/");
    });
    expect(moveNote).toHaveBeenCalledWith("n1", "Work/");
    expect(ctx.refreshOne).toHaveBeenCalledWith("n1");
    expect(result.current.dragKind).toBeNull();
  });

  it("onFolderDropNote is a no-op when no note is being dragged", async () => {
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      await result.current.onFolderDropNote("Work/");
    });
    expect(moveNote).not.toHaveBeenCalled();
  });

  it("onFolderDragStart sets dragKind=folder", () => {
    const { result } = mount([rec("n1", "Work/")]);
    const node = findNode(result.current.treeRef.current.roots, "work/")!;
    act(() =>
      result.current.onFolderDragStart(dragStartEvent(), node),
    );
    expect(result.current.dragKind).toBe("folder");
  });

  it("onDragEndCleanup resets all transient drag UI", () => {
    const { result } = mount([rec("n1", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    act(() => {
      result.current.setDropTargetKey("work/");
      result.current.setRootDropActive(true);
      result.current.updateReorderTarget("n1", "above");
    });
    act(() => result.current.onDragEndCleanup());
    expect(result.current.dragKind).toBeNull();
    expect(result.current.dropTargetKey).toBeNull();
    expect(result.current.rootDropActive).toBe(false);
    expect(result.current.reorderTarget).toBeNull();
  });
});

describe("reorder indicators (bail-out identity)", () => {
  it("updateReorderTarget keeps the SAME object when target unchanged", () => {
    const { result } = mount([rec("n1", null)]);
    act(() => result.current.updateReorderTarget("n1", "above"));
    const first = result.current.reorderTarget;
    act(() => result.current.updateReorderTarget("n1", "above"));
    expect(result.current.reorderTarget).toBe(first); // referential bail-out
    act(() => result.current.updateReorderTarget("n1", "below"));
    expect(result.current.reorderTarget).not.toBe(first);
  });

  it("clearReorderTarget only clears when it still points at the id", () => {
    const { result } = mount([rec("n1", null), rec("n2", null)]);
    act(() => result.current.updateReorderTarget("n1", "above"));
    // A dragleave on a sibling row must not erase n1's indicator.
    act(() => result.current.clearReorderTarget("n2"));
    expect(result.current.reorderTarget).toMatchObject({ id: "n1" });
    act(() => result.current.clearReorderTarget("n1"));
    expect(result.current.reorderTarget).toBeNull();
  });

  it("updateFolderReorderTarget + clear mirror the note bail-out semantics", () => {
    const { result } = mount([rec("n1", "Work/")]);
    act(() => result.current.updateFolderReorderTarget("work/", "below"));
    const first = result.current.folderReorderTarget;
    act(() => result.current.updateFolderReorderTarget("work/", "below"));
    expect(result.current.folderReorderTarget).toBe(first);
    act(() => result.current.clearFolderReorderTarget("other/"));
    expect(result.current.folderReorderTarget).toBe(first); // unchanged
    act(() => result.current.clearFolderReorderTarget("work/"));
    expect(result.current.folderReorderTarget).toBeNull();
  });
});

describe("reorder write (note → item_order)", () => {
  it("same-container note reorder persists a new item_order without moving the note", async () => {
    prefs.item_order = { "": ["n1", "n2"] };
    const { result, ctx } = mount([rec("n1", null), rec("n2", null)], []);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      await result.current.onNoteReorder("n2", "below");
    });
    // Same container → no moveNote; only the root container's sequence is
    // rewritten (n1 after n2), the rest of the map untouched (MYND-596).
    expect(moveNote).not.toHaveBeenCalled();
    expect(setItemOrder).toHaveBeenCalled();
    const persisted = setItemOrder.mock.calls.at(-1)![0] as Record<
      string,
      string[]
    >;
    expect(persisted).toEqual({ "": ["n2", "n1"] });
    expect(ctx.refreshOne).not.toHaveBeenCalled();
  });

  it("cross-container note reorder moves the note first, then persists order", async () => {
    prefs.item_order = { "": ["n1", "Work/"] };
    const { result, ctx } = mount([rec("n1", null), rec("n2", "Work/")], ["Work/"]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      // Drop n1 next to n2, which lives in Work/ → n1 must move into Work/.
      await result.current.onNoteReorder("n2", "above");
    });
    expect(moveNote).toHaveBeenCalledWith("n1", "Work/");
    expect(ctx.refreshOne).toHaveBeenCalledWith("n1");
    expect(setItemOrder).toHaveBeenCalled();
  });

  it("a note dropped onto itself is a no-op", async () => {
    const { result } = mount([rec("n1", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      await result.current.onNoteReorder("n1", "below");
    });
    expect(setItemOrder).not.toHaveBeenCalled();
  });

  it("reverts item_order to recency when the persist rejects (position is soft)", async () => {
    prefs.item_order = { "": ["n1", "n2"] };
    setItemOrder.mockRejectedValueOnce(new Error("over cap"));
    const { result } = mount([rec("n1", null), rec("n2", null)], []);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      await result.current.onNoteReorder("n2", "below");
    });
    // The optimistic order reverts to the pre-write map.
    expect(result.current.itemOrder).toEqual({ "": ["n1", "n2"] });
  });
});

describe("favorites", () => {
  it("toggleFavorite adds an absent note and persists", async () => {
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      result.current.toggleFavorite("n1");
      await Promise.resolve();
    });
    expect(setFavorites).toHaveBeenCalledWith(["n1"]);
  });

  it("toggleFavorite removes a present note", async () => {
    prefs.favorites = ["n1", "n2"];
    const { result } = mount([rec("n1", null), rec("n2", null)]);
    await act(async () => {
      result.current.toggleFavorite("n1");
      await Promise.resolve();
    });
    expect(setFavorites).toHaveBeenLastCalledWith(["n2"]);
  });

  it("onFavoritesDropNote adds the dragged note at the end (no-op if already favorited)", async () => {
    prefs.favorites = ["n2"];
    const { result } = mount([rec("n1", null), rec("n2", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      result.current.onFavoritesDropNote();
      await Promise.resolve();
    });
    expect(setFavorites).toHaveBeenCalledWith(["n2", "n1"]);
  });

  it("onFavoritesDropNote is a no-op for an already-favorited note", async () => {
    prefs.favorites = ["n1"];
    const { result } = mount([rec("n1", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      result.current.onFavoritesDropNote();
      await Promise.resolve();
    });
    expect(setFavorites).not.toHaveBeenCalled();
  });

  it("reorderFavorite moves an existing favorite to the target slot", async () => {
    prefs.favorites = ["a", "b", "c"];
    const { result } = mount([rec("a", null), rec("b", null), rec("c", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "c"));
    await act(async () => {
      result.current.reorderFavorite("a", "above");
      await Promise.resolve();
    });
    // c re-inserted above a.
    expect(setFavorites).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("reorderFavorite onto itself is a no-op", async () => {
    prefs.favorites = ["a"];
    const { result } = mount([rec("a", null)]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "a"));
    await act(async () => {
      result.current.reorderFavorite("a", "below");
      await Promise.resolve();
    });
    expect(setFavorites).not.toHaveBeenCalled();
  });

  it("favReorderTarget update/clear honor referential bail-out", () => {
    const { result } = mount([rec("n1", null)]);
    act(() => result.current.updateFavReorderTarget("n1", "above"));
    const first = result.current.favReorderTarget;
    act(() => result.current.updateFavReorderTarget("n1", "above"));
    expect(result.current.favReorderTarget).toBe(first);
    act(() => result.current.clearFavReorderTarget("n1"));
    expect(result.current.favReorderTarget).toBeNull();
  });
});

describe("root drop (unfile)", () => {
  it("dropping a filed note on the root unfiles it (moveNote → null) + persists order", async () => {
    prefs.item_order = { "": ["Work/"] };
    const { result, ctx } = mount([rec("n1", "Work/")], ["Work/"]);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      await result.current.onRootDrop();
    });
    expect(moveNote).toHaveBeenCalledWith("n1", null);
    expect(ctx.refreshOne).toHaveBeenCalledWith("n1");
    expect(setItemOrder).toHaveBeenCalled();
  });

  it("dropping an already-root note on the root reorders only (no moveNote)", async () => {
    prefs.item_order = { "": ["n1"] };
    const { result } = mount([rec("n1", null)], []);
    act(() => result.current.onNoteDragStart(dragStartEvent(), "n1"));
    await act(async () => {
      await result.current.onRootDrop();
    });
    expect(moveNote).not.toHaveBeenCalled();
    expect(setItemOrder).toHaveBeenCalled();
  });

  it("onRootDrop is a no-op when nothing is being dragged", async () => {
    const { result } = mount([rec("n1", null)]);
    await act(async () => {
      await result.current.onRootDrop();
    });
    expect(moveNote).not.toHaveBeenCalled();
    expect(setItemOrder).not.toHaveBeenCalled();
  });
});
