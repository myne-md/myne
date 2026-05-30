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
import { setDeliberateFolders } from "../../lib/prefs";
import { deleteFolder, renameFolder } from "../folderActions";
import { moveNote } from "../moveNote";
import type { FolderNode, FolderTree } from "../folderTree";
import type { NoteId, UseSelectedNoteReturn } from "../sidebarState";

const DRAG_MIME = "application/x-myne-note";
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

  // The latest derived tree, kept in a ref so handlers stay referentially
  // stable while still reading current subtree state (delete-emptiness etc.).
  const treeRef = useRef<FolderTree>(EMPTY_TREE);
  const draggedRef = useRef<NoteId | null>(null);

  const [menu, setMenu] = useState<FolderMenuState>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState>(null);
  const [renamingFolderKey, setRenamingFolderKey] = useState<string | null>(null);
  const [blockNotice, setBlockNotice] = useState<string | null>(null);
  const [caseMerge, setCaseMerge] = useState<CaseMergeState>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);

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
  const onNoteDragStart = useCallback((e: DragEvent, id: NoteId) => {
    draggedRef.current = id;
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  }, []);
  const onFolderDropNote = useCallback(
    async (folderPath: string) => {
      const id = draggedRef.current;
      draggedRef.current = null;
      setDropTargetKey(null);
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
    if (id === null) return;
    await moveNote(id, null);
    await ctx.refreshOne(id);
  }, [ctx]);

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
  };
}

export type FolderManagement = ReturnType<typeof useFolderManagement>;
