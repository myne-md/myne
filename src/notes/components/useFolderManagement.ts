// `useFolderManagement` — sidebar folder-tree interaction state + handlers
// (MYND-144 Task 10). Centralizes the deliberate_folders set, the transient UI
// state (context menu / new-folder input / inline rename / block notice /
// case-merge confirm / drag-drop target), and the handlers that wire the
// already-built logic: createNote(folder) (T5), moveNote (T5), deleteFolder
// (T8), renameFolder (T9), setDeliberateFolders (T4). After any mutation the
// affected notes are surgically refreshed (`ctx.refreshOne`) so the derived
// tree updates; the deliberate set is updated locally + persisted.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  foldSegment,
  isLegalPathLength,
  isLegalSegment,
  normalizeFolderPath,
  validateFolderNameInput,
  type FolderInputRejection,
} from "../../dialect/folderPath";
import { usePrefs } from "../../hooks/usePrefs";
import {
  setDeliberateFolders,
  setFolderOrder as persistFolderOrder,
  setNoteOrder as persistNoteOrder,
} from "../../lib/prefs";
import { deleteFolder, renameFolder } from "../folderActions";
import { moveNote } from "../moveNote";
import type { FolderNode, FolderTree } from "../folderTree";
import {
  buildRankMap,
  sortBatchIds,
  type NoteId,
  type UseSelectedNoteReturn,
} from "../sidebarState";

const DRAG_MIME = "application/x-myne-note";
const FOLDER_DRAG_MIME = "application/x-myne-folder";

/** Where a reorder drop lands relative to the hovered row. */
export type ReorderPlace = "above" | "below";

/** Folded sidebar-tree key for a note's folder value (`""` = vault root). */
function noteFolderKey(folder: string | null | undefined): string {
  const norm = normalizeFolderPath(folder ?? null);
  return norm === null ? "" : foldSegment(norm);
}

const EMPTY_TREE: FolderTree = { roots: [], unfiledNoteIds: [] };

export type FolderMenuState = { node: FolderNode; x: number; y: number } | null;
/** `parentPath === ""` = a new top-level folder. */
export type NewFolderState = { parentPath: string } | null;
export type CaseMergeState = { path: string; existingDisplay: string } | null;

function folderParent(path: string): string {
  const segs = path.split("/").filter((s) => s.length > 0);
  return segs.length <= 1 ? "" : segs.slice(0, -1).join("/") + "/";
}

/** User-facing copy for a rejected folder-name input (markdown-dialect §3.6.2
 *  grammar gate). `"empty"` is a cancel, not an error, so it has no message. */
function folderInputRejectionMessage(
  rejection: Exclude<FolderInputRejection, "empty">,
): string {
  return rejection === "too-long"
    ? "That folder path is too long."
    : "A folder name can't contain / \\ | # ^ [ ] or start/end with a space.";
}

function findByFoldedKey(
  nodes: readonly FolderNode[],
  key: string,
): FolderNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    const hit = findByFoldedKey(n.children, key);
    if (hit) return hit;
  }
  return null;
}

export function useFolderManagement(ctx: UseSelectedNoteReturn) {
  const { prefs } = usePrefs();
  const [deliberate, setDeliberate] = useState<string[]>([]);
  // Sync the local set from the mount-time prefs read; later mutated by ops.
  useEffect(() => {
    setDeliberate(prefs.deliberate_folders);
  }, [prefs.deliberate_folders]);

  // Manual sidebar sort order (note_order / folder_order prefs sequences),
  // synced from the mount-time prefs read and mutated optimistically by the
  // reorder drag handlers (best-effort persist, like `deliberate`).
  const [noteOrder, setNoteOrder] = useState<string[]>([]);
  const [folderOrder, setFolderOrder] = useState<string[]>([]);
  useEffect(() => {
    setNoteOrder(prefs.note_order);
  }, [prefs.note_order]);
  useEffect(() => {
    setFolderOrder(prefs.folder_order);
  }, [prefs.folder_order]);

  // The latest derived tree, kept in a ref so handlers stay referentially
  // stable while still reading current subtree state (delete-emptiness etc.).
  const treeRef = useRef<FolderTree>(EMPTY_TREE);
  const draggedRef = useRef<NoteId | null>(null);
  // Folded key of the folder being dragged (folder-reorder drags only).
  const draggedFolderRef = useRef<string | null>(null);

  const [menu, setMenu] = useState<FolderMenuState>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState>(null);
  const [renamingFolderKey, setRenamingFolderKey] = useState<string | null>(null);
  const [blockNotice, setBlockNotice] = useState<string | null>(null);
  const [caseMerge, setCaseMerge] = useState<CaseMergeState>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  // Drag-kind discriminator so rows can branch their drop affordance:
  // "note" → reorder-between-notes / move-into-folder; "folder" → reorder
  // sibling folders. Cleared on drag end. Set on the respective drag start.
  const [dragKind, setDragKind] = useState<"note" | "folder" | null>(null);
  // Active reorder insertion indicators (the hovered row + which edge).
  const [reorderTarget, setReorderTarget] = useState<{
    id: NoteId;
    place: ReorderPlace;
  } | null>(null);
  const [folderReorderTarget, setFolderReorderTarget] = useState<{
    key: string;
    place: ReorderPlace;
  } | null>(null);

  const notesForOps = useCallback(
    () =>
      Array.from(ctx.cache.values()).map((r) => ({
        noteUuid: r.noteUuid,
        folder: r.folder,
      })),
    [ctx.cache],
  );

  const addDeliberate = useCallback((path: string) => {
    setDeliberate((prev) => {
      const key = foldSegment(path);
      const already = prev.some(
        (p) => foldSegment(normalizeFolderPath(p) ?? "") === key,
      );
      if (already) return prev;
      const next = [...prev, path];
      void setDeliberateFolders(next).catch(() => {});
      return next;
    });
  }, []);

  // ---- context menu --------------------------------------------------------
  const openMenu = useCallback(
    (node: FolderNode, pos: { x: number; y: number }) =>
      setMenu({ node, x: pos.x, y: pos.y }),
    [],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // ---- create folder -------------------------------------------------------
  const startNewFolder = useCallback((parentPath: string) => {
    setMenu(null);
    setNewFolder({ parentPath });
  }, []);
  const cancelNewFolder = useCallback(() => setNewFolder(null), []);

  const commitNewFolder = useCallback(
    (name: string) => {
      const state = newFolder;
      if (state === null) return;
      const norm = normalizeFolderPath(state.parentPath + name);
      if (norm === null) {
        setNewFolder(null);
        return;
      }
      // Grammar gate (markdown-dialect §3.6.2): reject illegal Myne-authored
      // segments / over-long paths. Only the typed `name` is grammar-checked
      // (a legal child can sit under an imported-illegal parent); on rejection
      // keep the input open + surface the notice so the user can fix it.
      const rejection = validateFolderNameInput(name, norm);
      if (rejection !== null) {
        if (rejection === "empty") setNewFolder(null);
        else setBlockNotice(folderInputRejectionMessage(rejection));
        return;
      }
      setNewFolder(null);
      const existing = findByFoldedKey(treeRef.current.roots, foldSegment(norm));
      if (existing && existing.path !== norm) {
        // Case-only collision with an existing folder → confirm a merge.
        setCaseMerge({ path: norm, existingDisplay: existing.path });
        return;
      }
      addDeliberate(norm);
    },
    [newFolder, addDeliberate],
  );

  const confirmCaseMerge = useCallback(() => {
    const m = caseMerge;
    setCaseMerge(null);
    if (m) addDeliberate(m.path);
  }, [caseMerge, addDeliberate]);
  const cancelCaseMerge = useCallback(() => setCaseMerge(null), []);

  // ---- new note in folder --------------------------------------------------
  const newNoteHere = useCallback(
    (folderPath: string) => {
      setMenu(null);
      void ctx.createAndStartRename(folderPath).catch(() => {});
    },
    [ctx],
  );

  // ---- rename folder -------------------------------------------------------
  const startRenameFolder = useCallback((node: FolderNode) => {
    setMenu(null);
    setRenamingFolderKey(node.key);
  }, []);
  const cancelRenameFolder = useCallback(() => setRenamingFolderKey(null), []);
  const commitRenameFolder = useCallback(
    async (node: FolderNode, newName: string) => {
      const newPath = folderParent(node.path) + newName + "/";
      // Grammar gate (markdown-dialect §3.6.2): a rename edits a single
      // segment, so `newName` must itself be one legal segment (no `/`), and
      // the resulting path must fit PATH_MAX. On rejection keep the rename
      // input open (don't clear `renamingFolderKey`) + surface the notice.
      if (!isLegalSegment(newName)) {
        setBlockNotice(folderInputRejectionMessage("illegal-segment"));
        return;
      }
      if (!isLegalPathLength(newPath)) {
        setBlockNotice(folderInputRejectionMessage("too-long"));
        return;
      }
      setRenamingFolderKey(null);
      const result = await renameFolder(
        node.path,
        newPath,
        notesForOps(),
        deliberate,
      );
      setDeliberate(result.nextDeliberate);
      await Promise.all(result.moved.map((id) => ctx.refreshOne(id)));
    },
    [ctx, deliberate, notesForOps],
  );

  // ---- delete folder -------------------------------------------------------
  const deleteFolderAction = useCallback(
    async (node: FolderNode) => {
      setMenu(null);
      const plan = await deleteFolder(node.path, treeRef.current, deliberate);
      if (plan.blocked) {
        setBlockNotice("Folder isn't empty — move or delete its notes first.");
        return;
      }
      setDeliberate(plan.nextDeliberate);
    },
    [deliberate],
  );
  const dismissBlock = useCallback(() => setBlockNotice(null), []);
  // Auto-dismiss the block notice.
  useEffect(() => {
    if (blockNotice === null) return;
    const t = setTimeout(() => setBlockNotice(null), 4000);
    return () => clearTimeout(t);
  }, [blockNotice]);

  // ---- drag & drop ---------------------------------------------------------
  //
  // Three gestures share the HTML5 drag machinery, discriminated by `dragKind`:
  //   note  → drop ON a folder row = move into folder; drop BETWEEN note rows =
  //           reorder (and move into the target's folder when crossing folders).
  //   folder→ drop BETWEEN sibling folder rows = reorder (same-parent only).
  // Refs carry the dragged identity (note id / folded folder key); the dropped
  // payload is read from the ref, not from dataTransfer (single-app drag).

  const onNoteDragStart = useCallback((e: DragEvent, id: NoteId) => {
    draggedRef.current = id;
    draggedFolderRef.current = null;
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    setDragKind("note");
  }, []);

  const onFolderDragStart = useCallback((e: DragEvent, node: FolderNode) => {
    draggedFolderRef.current = node.key;
    draggedRef.current = null;
    e.dataTransfer.setData(FOLDER_DRAG_MIME, node.path);
    e.dataTransfer.effectAllowed = "move";
    setDragKind("folder");
  }, []);

  // Clears all transient drag UI — fired on dragend (covers drops that land
  // outside any target, and Esc-cancelled drags).
  const onDragEndCleanup = useCallback(() => {
    draggedRef.current = null;
    draggedFolderRef.current = null;
    setDragKind(null);
    setReorderTarget(null);
    setFolderReorderTarget(null);
    setDropTargetKey(null);
    setRootDropActive(false);
  }, []);

  // Move the insertion indicator to (id/key, place). `onDragOver` fires
  // continuously, so the functional update returns the SAME reference when the
  // target is unchanged — React bails out, no re-render per drag pixel.
  const updateReorderTarget = useCallback((id: NoteId, place: ReorderPlace) => {
    setReorderTarget((cur) =>
      cur?.id === id && cur.place === place ? cur : { id, place },
    );
  }, []);
  const updateFolderReorderTarget = useCallback(
    (key: string, place: ReorderPlace) => {
      setFolderReorderTarget((cur) =>
        cur?.key === key && cur.place === place ? cur : { key, place },
      );
    },
    [],
  );

  // Clear the insertion indicator only when it still points at `id`/`key`, so a
  // dragleave on the row we just left doesn't erase an indicator a sibling's
  // dragenter already moved.
  const clearReorderTarget = useCallback((id: NoteId) => {
    setReorderTarget((cur) => (cur?.id === id ? null : cur));
  }, []);
  const clearFolderReorderTarget = useCallback((key: string) => {
    setFolderReorderTarget((cur) => (cur?.key === key ? null : cur));
  }, []);

  const onFolderDropNote = useCallback(
    async (folderPath: string) => {
      const id = draggedRef.current;
      draggedRef.current = null;
      setDropTargetKey(null);
      setDragKind(null);
      if (id === null) return;
      await moveNote(id, folderPath);
      await ctx.refreshOne(id);
    },
    [ctx],
  );

  const onRootDrop = useCallback(async () => {
    const id = draggedRef.current;
    draggedRef.current = null;
    setRootDropActive(false);
    setDragKind(null);
    if (id === null) return;
    await moveNote(id, null);
    await ctx.refreshOne(id);
  }, [ctx]);

  // Reorder a note relative to `targetId`. When the dragged note lives in a
  // different folder, it is first moved into the target's folder, then placed.
  // Persists the target folder's full new sequence into the global note_order
  // (sibling-local comparison keeps other folders' order untouched).
  const onNoteReorder = useCallback(
    async (targetId: NoteId, place: ReorderPlace) => {
      const draggedId = draggedRef.current;
      draggedRef.current = null;
      setReorderTarget(null);
      setDragKind(null);
      if (draggedId === null || draggedId === targetId) return;

      const targetRec = ctx.cache.get(targetId);
      const draggedRec = ctx.cache.get(draggedId);
      if (targetRec === undefined || draggedRec === undefined) return;

      const targetFolderKey = noteFolderKey(targetRec.folder);
      // Cross-folder drop → move into the target's folder first.
      if (targetFolderKey !== noteFolderKey(draggedRec.folder)) {
        await moveNote(draggedId, normalizeFolderPath(targetRec.folder ?? null));
        await ctx.refreshOne(draggedId);
      }

      // The target folder's notes in current display order, minus the dragged
      // note (re-inserted at the chosen slot). Computed from the live cache so
      // the just-moved note's new siblings are included.
      const rank = buildRankMap(noteOrder);
      const siblings = sortBatchIds(
        Array.from(ctx.cache.values())
          .filter(
            (r) =>
              r.noteUuid !== draggedId &&
              noteFolderKey(r.folder) === targetFolderKey,
          )
          .map((r) => r.noteUuid),
        ctx.cache,
        rank,
      );
      const targetIdx = siblings.indexOf(targetId);
      const insertAt =
        targetIdx === -1
          ? siblings.length
          : place === "above"
            ? targetIdx
            : targetIdx + 1;
      const newSeq = [
        ...siblings.slice(0, insertAt),
        draggedId,
        ...siblings.slice(insertAt),
      ];

      const inFolder = new Set(newSeq);
      const nextOrder = [
        ...noteOrder.filter((id) => !inFolder.has(id)),
        ...newSeq,
      ];
      setNoteOrder(nextOrder);
      void persistNoteOrder(nextOrder).catch(() => {});
    },
    [ctx, noteOrder],
  );

  // Reorder a folder relative to a same-parent sibling `targetNode`.
  // Cross-parent drops are a reparent (folder MOVE) — out of scope, so no-op.
  const onFolderReorder = useCallback(
    async (targetNode: FolderNode, place: ReorderPlace) => {
      const draggedKey = draggedFolderRef.current;
      draggedFolderRef.current = null;
      setFolderReorderTarget(null);
      setDragKind(null);
      if (draggedKey === null || draggedKey === targetNode.key) return;

      const tree = treeRef.current;
      const draggedNode = findByFoldedKey(tree.roots, draggedKey);
      if (draggedNode === null) return;
      if (folderParent(draggedNode.path) !== folderParent(targetNode.path)) {
        return;
      }

      const parentPath = folderParent(targetNode.path);
      const siblingNodes =
        parentPath === ""
          ? tree.roots
          : (findByFoldedKey(tree.roots, foldSegment(parentPath))?.children ??
            []);
      const siblingPaths = siblingNodes
        .map((n) => n.path)
        .filter((p) => foldSegment(p) !== draggedKey);
      const targetIdx = siblingPaths.findIndex(
        (p) => foldSegment(p) === targetNode.key,
      );
      const insertAt =
        targetIdx === -1
          ? siblingPaths.length
          : place === "above"
            ? targetIdx
            : targetIdx + 1;
      const newSeq = [
        ...siblingPaths.slice(0, insertAt),
        draggedNode.path,
        ...siblingPaths.slice(insertAt),
      ];

      const inGroup = new Set(newSeq.map((p) => foldSegment(p)));
      const nextOrder = [
        ...folderOrder.filter((p) => !inGroup.has(foldSegment(p))),
        ...newSeq,
      ];
      setFolderOrder(nextOrder);
      void persistFolderOrder(nextOrder).catch(() => {});
    },
    [folderOrder],
  );

  return {
    deliberate,
    treeRef,
    menu,
    openMenu,
    closeMenu,
    newFolder,
    startNewFolder,
    commitNewFolder,
    cancelNewFolder,
    renamingFolderKey,
    startRenameFolder,
    commitRenameFolder,
    cancelRenameFolder,
    blockNotice,
    dismissBlock,
    caseMerge,
    confirmCaseMerge,
    cancelCaseMerge,
    newNoteHere,
    deleteFolderAction,
    dropTargetKey,
    setDropTargetKey,
    rootDropActive,
    setRootDropActive,
    onNoteDragStart,
    onFolderDropNote,
    onRootDrop,
    // reorder (notes + folders)
    noteOrder,
    folderOrder,
    dragKind,
    reorderTarget,
    updateReorderTarget,
    clearReorderTarget,
    onNoteReorder,
    folderReorderTarget,
    updateFolderReorderTarget,
    clearFolderReorderTarget,
    onFolderReorder,
    onFolderDragStart,
    onDragEndCleanup,
  };
}

export type FolderManagement = ReturnType<typeof useFolderManagement>;
