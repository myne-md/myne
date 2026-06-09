// `useFolderManagement` — sidebar folder-tree interaction state + handlers
// (MYND-144 Task 10). Centralizes the deliberate_folders set, the transient UI
// state (context menu / new-folder input / inline rename / block notice /
// case-merge confirm / folder-delete confirm / drag-drop target), and the
// handlers that wire the already-built logic: createNote(folder) (T5), moveNote
// (T5), planFolderDelete + persistFolderDelete (T8; non-empty delete soft-
// trashes the subtree via ctx.bulkTrashWithSync, 2026-06-09), renameFolder (T9),
// setDeliberateFolders (T4). After any mutation the affected notes are
// surgically refreshed (`ctx.refreshOne`) so the derived tree updates; the
// deliberate set is updated locally + persisted.

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
  setFavorites as persistFavorites,
  setFolderIcons as persistFolderIcons,
  setItemColors as persistItemColors,
  setItemOrder as persistItemOrder,
} from "../../lib/prefs";
import {
  persistFolderDelete,
  planFolderDelete,
  renameFolder,
  type FolderDeletePlan,
} from "../folderActions";
import { moveNote } from "../moveNote";
import type { FolderNode, FolderTree } from "../folderTree";
import { type NoteId, type UseSelectedNoteReturn } from "../sidebarState";
import {
  pruneFolderPrefix,
  pruneStaleNoteColors,
  rewriteFolderPrefix,
} from "../decorationRewrite";
import {
  buildItemRankMap,
  orderContainerChildren,
  pruneFavorites,
  toggleFavoriteList,
} from "./folderTreeRows";
import {
  applyReorderWrite,
  computeItemOrderAfterReorder,
  itemOrderKey,
} from "./itemOrderReorder";

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
/** Pending non-empty-folder delete awaiting confirmation (notes → Trash). */
export type ConfirmFolderDeleteState = {
  node: FolderNode;
  noteCount: number;
} | null;

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

  // Unified manual sidebar order (`item_order` prefs sequence) + favorites
  // (`favorites` prefs sequence, MYND-183), synced from the mount-time prefs
  // read and mutated optimistically by the reorder drag handlers (best-effort
  // persist, like `deliberate`). Favorites membership/reorder wiring lands in a
  // later task; here we expose the read so the tree + Favorites section consume
  // a single source.
  const [itemOrder, setItemOrder] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    setItemOrder(prefs.item_order);
  }, [prefs.item_order]);
  useEffect(() => {
    setFavorites(prefs.favorites);
  }, [prefs.favorites]);

  // Decoration maps (MYND-184 color labels / MYND-185 folder icons), synced
  // from the mount-time prefs read and mutated optimistically by the picker
  // setters below. `itemColors` is keyed by note UUID OR canonical folder path
  // (`/`-discriminated, like `item_order`); `folderIcons` by folder path.
  const [itemColors, setItemColorsState] = useState<Record<string, string>>({});
  const [folderIcons, setFolderIconsState] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    setItemColorsState(prefs.item_colors);
  }, [prefs.item_colors]);
  useEffect(() => {
    setFolderIconsState(prefs.folder_icons);
  }, [prefs.folder_icons]);

  // ---- decorations: color labels + folder icons (MYND-184 / 185) ----------
  // Optimistic whole-map prefs write with revert-on-reject, mirroring the
  // favorites/reorder discipline. The picker mutates one entry; we persist the
  // full map (the established prefs-setter shape — set_item_colors /
  // set_folder_icons take the whole desired map). Defined early so the folder
  // rename/delete handlers below can re-root / prune the maps through it.
  const writeItemColors = useCallback(
    async (next: Record<string, string>) => {
      // Lazy GC: drop note-keyed entries whose note no longer lives (the
      // favorites pattern); folder keys are kept (rename/delete handle those).
      const pruned = pruneStaleNoteColors(next, ctx.cache);
      const prev = itemColors;
      setItemColorsState(pruned);
      try {
        await persistItemColors(pruned);
      } catch {
        setItemColorsState(prev);
      }
    },
    [ctx.cache, itemColors],
  );
  // Assign (`slot`) or clear (`null`) the color of one item — a note UUID or a
  // canonical folder path. Clearing removes the key so the map omits-when-empty.
  const setItemColor = useCallback(
    (key: string, slot: string | null) => {
      const next = { ...itemColors };
      if (slot === null) delete next[key];
      else next[key] = slot;
      void writeItemColors(next);
    },
    [itemColors, writeItemColors],
  );

  const writeFolderIcons = useCallback(
    async (next: Record<string, string>) => {
      const prev = folderIcons;
      setFolderIconsState(next);
      try {
        await persistFolderIcons(next);
      } catch {
        setFolderIconsState(prev);
      }
    },
    [folderIcons],
  );
  // Assign (`icon`) or reset (`null`) a folder's custom icon, keyed by path.
  const setFolderIcon = useCallback(
    (path: string, icon: string | null) => {
      const next = { ...folderIcons };
      if (icon === null) delete next[path];
      else next[path] = icon;
      void writeFolderIcons(next);
    },
    [folderIcons, writeFolderIcons],
  );

  // Apply a folder-prefix transform (rewrite on rename / prune on delete) to
  // BOTH decoration maps, persisting each only when it changed — the open-risk
  // the durability task closes (MYND-184/185). A rename re-roots a whole
  // subtree, so the folded-prefix walk catches descendants too.
  const applyDecorationRemap = useCallback(
    (
      remap: (
        map: Record<string, string>,
      ) => { next: Record<string, string>; changed: boolean },
    ) => {
      const ic = remap(itemColors);
      if (ic.changed) void writeItemColors(ic.next);
      const fi = remap(folderIcons);
      if (fi.changed) void writeFolderIcons(fi.next);
    },
    [itemColors, folderIcons, writeItemColors, writeFolderIcons],
  );

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
  const [confirmFolderDelete, setConfirmFolderDelete] =
    useState<ConfirmFolderDeleteState>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  // Drop-target highlight when a note is dragged over the Favorites section
  // (drag-into-add). MYND-183 Task 9.
  const [favoritesDropActive, setFavoritesDropActive] = useState(false);
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
  // Reorder insertion indicator WITHIN the Favorites section (kept separate from
  // `reorderTarget` so a note shown in both Favorites + tree doesn't cross-light).
  const [favReorderTarget, setFavReorderTarget] = useState<{
    id: NoteId;
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

  // The target container's children (sub-folders + notes) in current display
  // order, as `item_order` keys (folder display path / note UUID). Reuses the
  // flatten comparator so the sidebar's render order IS the reorder baseline.
  // `containerKey` is the folded folder key, or `""` for the root container.
  const containerChildKeys = useCallback(
    (containerKey: string): string[] => {
      const tree = treeRef.current;
      const node =
        containerKey === "" ? null : findByFoldedKey(tree.roots, containerKey);
      const folders = containerKey === "" ? tree.roots : (node?.children ?? []);
      const noteIds =
        containerKey === "" ? tree.unfiledNoteIds : (node?.noteIds ?? []);
      const rank = buildItemRankMap(itemOrder);
      return orderContainerChildren(folders, noteIds, ctx.cache, rank).map((c) =>
        c.kind === "folder" ? c.node.path : c.id,
      );
    },
    [ctx.cache, itemOrder],
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
      // Re-root the folder's color + icon onto the new path (and any descendant
      // folder's, since the rename re-roots the whole subtree) so a rename
      // never silently strips a decoration (MYND-184/185 durability).
      if (!result.invalid) {
        applyDecorationRemap((m) => rewriteFolderPrefix(m, node.path, newPath));
      }
      await Promise.all(result.moved.map((id) => ctx.refreshOne(id)));
    },
    [ctx, deliberate, notesForOps, applyDecorationRemap],
  );

  // ---- delete folder -------------------------------------------------------
  // Execute a planned delete: soft-trash the subtree notes (recoverable from
  // Trash, MYND-133), then trim the deliberate set + prune decorations. Shared
  // by the empty-folder fast path (no notes, no confirm) and the confirmed
  // non-empty path. Replaces the pre-2026-06-09 "block when non-empty" gate.
  const performFolderDelete = useCallback(
    async (node: FolderNode, plan: FolderDeletePlan) => {
      if (plan.noteIds.length > 0) {
        await ctx.bulkTrashWithSync(plan.noteIds);
        // If the open/selected note just went to Trash, don't dwell on it.
        if (ctx.selectedId !== null && plan.noteIds.includes(ctx.selectedId)) {
          ctx.select(null);
        }
      }
      await persistFolderDelete(plan);
      setDeliberate(plan.nextDeliberate);
      // Prune the deleted folder's (and its deliberate descendants') color +
      // icon (MYND-184/185 durability).
      applyDecorationRemap((m) => pruneFolderPrefix(m, node.path));
    },
    [ctx, applyDecorationRemap],
  );

  const deleteFolderAction = useCallback(
    (node: FolderNode) => {
      setMenu(null);
      const plan = planFolderDelete(node.path, treeRef.current, deliberate);
      if (plan.noteIds.length === 0) {
        // Note-empty folder → delete immediately (no confirmation, unchanged).
        void performFolderDelete(node, plan).catch(() => {});
        return;
      }
      // Non-empty → confirm first; the subtree notes move to Trash on confirm.
      setConfirmFolderDelete({ node, noteCount: plan.noteIds.length });
    },
    [deliberate, performFolderDelete],
  );

  const confirmFolderDeleteAction = useCallback(() => {
    const pending = confirmFolderDelete;
    if (pending === null) return;
    setConfirmFolderDelete(null);
    // Recompute against the live tree at confirm time (notes may have moved
    // while the dialog was open) — pure, cheap.
    const plan = planFolderDelete(pending.node.path, treeRef.current, deliberate);
    void performFolderDelete(pending.node, plan).catch(() => {});
  }, [confirmFolderDelete, deliberate, performFolderDelete]);

  const cancelFolderDelete = useCallback(
    () => setConfirmFolderDelete(null),
    [],
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
    setFavReorderTarget(null);
    setDropTargetKey(null);
    setRootDropActive(false);
    setFavoritesDropActive(false);
  }, []);

  const updateFavReorderTarget = useCallback(
    (id: NoteId, place: ReorderPlace) => {
      setFavReorderTarget((cur) =>
        cur?.id === id && cur.place === place ? cur : { id, place },
      );
    },
    [],
  );
  const clearFavReorderTarget = useCallback((id: NoteId) => {
    setFavReorderTarget((cur) => (cur?.id === id ? null : cur));
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

  // Drop into the empty root AREA → unfile (`folder: null`) + place at the end
  // of the root container. The replacement for the removed "Vault root" section
  // drop-zone (MYND-183 Task 6b). Note drags only.
  const onRootDrop = useCallback(async () => {
    const id = draggedRef.current;
    draggedRef.current = null;
    setRootDropActive(false);
    setDragKind(null);
    if (id === null) return;
    const draggedRec = ctx.cache.get(id);
    const crossContainer =
      draggedRec === undefined || noteFolderKey(draggedRec.folder) !== "";
    const prevOrder = itemOrder;
    await applyReorderWrite({
      moveFirst: crossContainer
        ? async () => {
            await moveNote(id, null);
            await ctx.refreshOne(id);
          }
        : null,
      computeNext: () =>
        computeItemOrderAfterReorder({
          itemOrder: prevOrder,
          containerChildKeys: containerChildKeys("").filter((k) => k !== id),
          draggedKey: id,
          targetKey: "", // no row target → appends at the root end
          place: "below",
        }),
      prevOrder,
      setOrder: setItemOrder,
      persist: persistItemOrder,
    });
  }, [ctx, itemOrder, containerChildKeys]);

  // Unified reorder: place the dragged item (note OR folder — derived from which
  // drag ref is set) adjacent to `target` (a note OR a folder row) in the
  // unified `item_order`. The four drag/target kind combinations all route here,
  // so a note can land in a folder-folder gap and a folder can reorder past a
  // loose note (MYND-183 Task 6b). A note crossing containers moves first
  // (`folder:` is the atomic source of truth); a folder reorders within its own
  // parent only (cross-parent reparent is out of scope — no-op). Dual-write +
  // failure semantics live in `applyReorderWrite`.
  const reorderRelativeTo = useCallback(
    async (
      target:
        | { kind: "note"; id: NoteId }
        | { kind: "folder"; node: FolderNode },
      place: ReorderPlace,
    ) => {
      const noteDrag = draggedRef.current;
      const folderDrag = draggedFolderRef.current;
      draggedRef.current = null;
      draggedFolderRef.current = null;
      setReorderTarget(null);
      setFolderReorderTarget(null);
      setDropTargetKey(null);
      setDragKind(null);

      // Resolve the target's container (folded key + path) + its order-key.
      let containerKey: string;
      let containerPath: string | null;
      let targetKey: string;
      if (target.kind === "note") {
        const rec = ctx.cache.get(target.id);
        if (rec === undefined) return;
        containerKey = noteFolderKey(rec.folder);
        containerPath = normalizeFolderPath(rec.folder ?? null);
        targetKey = target.id;
      } else {
        const parent = folderParent(target.node.path);
        containerKey = noteFolderKey(parent);
        containerPath = parent === "" ? null : normalizeFolderPath(parent);
        targetKey = target.node.path;
      }

      const prevOrder = itemOrder;

      if (noteDrag !== null) {
        if (target.kind === "note" && noteDrag === target.id) return;
        const draggedRec = ctx.cache.get(noteDrag);
        if (draggedRec === undefined) return;
        const crossContainer = noteFolderKey(draggedRec.folder) !== containerKey;
        await applyReorderWrite({
          moveFirst: crossContainer
            ? async () => {
                await moveNote(noteDrag, containerPath);
                await ctx.refreshOne(noteDrag);
              }
            : null,
          computeNext: () =>
            computeItemOrderAfterReorder({
              itemOrder: prevOrder,
              containerChildKeys: containerChildKeys(containerKey).filter(
                (k) => k !== noteDrag,
              ),
              draggedKey: noteDrag,
              targetKey,
              place,
            }),
          prevOrder,
          setOrder: setItemOrder,
          persist: persistItemOrder,
        });
        return;
      }

      if (folderDrag !== null) {
        if (target.kind === "folder" && folderDrag === target.node.key) return;
        const draggedNode = findByFoldedKey(treeRef.current.roots, folderDrag);
        if (draggedNode === null) return;
        // Same-parent only — cross-parent reparent is out of scope (no-op).
        if (noteFolderKey(folderParent(draggedNode.path)) !== containerKey) {
          return;
        }
        await applyReorderWrite({
          moveFirst: null,
          computeNext: () =>
            computeItemOrderAfterReorder({
              itemOrder: prevOrder,
              containerChildKeys: containerChildKeys(containerKey).filter(
                (k) => itemOrderKey(k) !== folderDrag,
              ),
              draggedKey: draggedNode.path,
              targetKey,
              place,
            }),
          prevOrder,
          setOrder: setItemOrder,
          persist: persistItemOrder,
        });
      }
    },
    [ctx, itemOrder, containerChildKeys],
  );

  // Row-facing wrappers keyed by TARGET kind (the dragged kind is derived inside
  // `reorderRelativeTo`), so a note row accepts a folder drag and vice-versa.
  const onNoteReorder = useCallback(
    (targetId: NoteId, place: ReorderPlace) =>
      reorderRelativeTo({ kind: "note", id: targetId }, place),
    [reorderRelativeTo],
  );
  const onFolderReorder = useCallback(
    (targetNode: FolderNode, place: ReorderPlace) =>
      reorderRelativeTo({ kind: "folder", node: targetNode }, place),
    [reorderRelativeTo],
  );

  // ---- favorites (MYND-183 Task 9) ----------------------------------------
  // Optimistic prefs write with revert + stale-UUID GC on write. Reuses the
  // move-less dual-write helper, so the persist-reject → revert contract is
  // identical to the reorder path (and covered by the same unit test).
  const writeFavorites = useCallback(
    async (next: string[]) => {
      const pruned = pruneFavorites(next, ctx.cache);
      await applyReorderWrite({
        moveFirst: null,
        computeNext: () => pruned,
        prevOrder: favorites,
        setOrder: setFavorites,
        persist: persistFavorites,
      });
    },
    [ctx.cache, favorites],
  );

  // Star / context-menu toggle — the ONLY remove path. Add when absent, remove
  // when present (`folder:` untouched — favoriting is pure view-state).
  const toggleFavorite = useCallback(
    (id: NoteId) => void writeFavorites(toggleFavoriteList(favorites, id)),
    [favorites, writeFavorites],
  );

  // Drop a note onto the Favorites section's non-row area → add at the end
  // (never removes; no-op if already favorited). `folder:` untouched.
  const onFavoritesDropNote = useCallback(() => {
    const id = draggedRef.current;
    draggedRef.current = null;
    setFavoritesDropActive(false);
    setDragKind(null);
    if (id === null || favorites.includes(id)) return;
    void writeFavorites([...favorites, id]);
  }, [favorites, writeFavorites]);

  // Drop a note onto a favorite ROW edge → place it at that slot. Uniform
  // add-or-reorder: a non-favorite is ADDED at the slot; an existing favorite
  // is moved (filtered out then re-inserted). Never removes — drag-out-to-remove
  // does not exist (removal is star/menu only).
  const reorderFavorite = useCallback(
    (targetId: NoteId, place: ReorderPlace) => {
      const draggedId = draggedRef.current;
      draggedRef.current = null;
      setFavReorderTarget(null);
      setReorderTarget(null);
      setDragKind(null);
      if (draggedId === null || draggedId === targetId) return;
      const next = computeItemOrderAfterReorder({
        itemOrder: favorites,
        containerChildKeys: favorites.filter((f) => f !== draggedId),
        draggedKey: draggedId,
        targetKey: targetId,
        place,
      });
      void writeFavorites(next);
    },
    [favorites, writeFavorites],
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
    confirmFolderDelete,
    confirmFolderDeleteAction,
    cancelFolderDelete,
    dropTargetKey,
    setDropTargetKey,
    rootDropActive,
    setRootDropActive,
    onNoteDragStart,
    onFolderDropNote,
    onRootDrop,
    // reorder (unified item_order) + favorites
    itemOrder,
    favorites,
    // favorites membership (Task 9)
    toggleFavorite,
    onFavoritesDropNote,
    reorderFavorite,
    favoritesDropActive,
    setFavoritesDropActive,
    favReorderTarget,
    updateFavReorderTarget,
    clearFavReorderTarget,
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
    // decorations (MYND-184 color labels / MYND-185 folder icons)
    itemColors,
    setItemColor,
    folderIcons,
    setFolderIcon,
  };
}

export type FolderManagement = ReturnType<typeof useFolderManagement>;
