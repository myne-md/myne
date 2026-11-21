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
  folderKey,
  isLegalPathLength,
  isLegalSegment,
  normalizeFolderPath,
  validateFolderNameInput,
  type FolderInputRejection,
} from "../../dialect/folderPath";
import { collectSubtreeNoteIdsFromCache } from "../archivedFolders";
import i18n from "../../i18n";
import { usePrefs } from "../../hooks/usePrefs";
import {
  mutateArchivedFolders,
  mutateDeliberateFolders,
  registerDeliberateFolders,
  mutationFrom,
  setFavorites as persistFavorites,
  setFolderIcons as persistFolderIcons,
  setItemColors as persistItemColors,
  setItemOrder as persistItemOrder,
} from "../../lib/prefs";
import {
  persistFolderDelete,
  planFolderArchive,
  planFolderDelete,
  planFolderUnarchive,
  renameFolder,
  rerootArchivedFolders,
  type FolderArchivePlan,
  type FolderDeletePlan,
} from "../folderActions";
import { rewriteItemOrderPrefix } from "@myne/editor/host/notes/itemOrder";
import { FOLDER_DRAG_MIME } from "./reorderDnd";
import { toast } from "../../components/toast/toastStore";
import { moveNote } from "../moveNote";
import { writeTabDrag } from "../tabDrag";
import { itemKey, noteItem } from "../workspaceState";
import { panesNotSettledMessage, useWorkspaceOptional } from "../workspaceContext";
import type { FolderNode, FolderTree } from "../folderTree";
import { type NoteId, type UseSelectedNoteReturn } from "../sidebarState";
import {
  foldDecorationKeys,
  pruneFolderPrefix,
  pruneStaleNoteColors,
  rewriteFolderPrefix,
} from "../decorationRewrite";
import {
  orderContainerChildren,
  pruneFavorites,
  toggleFavoriteList,
} from "./folderTreeRows";
import {
  applyReorderWrite,
  computeItemOrderAfterReorder,
  reorderSequence,
  itemOrderKey,
} from "./itemOrderReorder";
import {
  buildContainerRank,
  containerKeyOf,
} from "@myne/editor/host/notes/itemOrder";

const DRAG_MIME = "application/x-myne-note";
/** Carries the full id array when a MULTI-selection is dragged (MYND-367). The
 *  single-id `DRAG_MIME` is still written for backward compat (favorites / pane
 *  drop paths read the grabbed id); folder-drop fans out over this when set. */
const DRAG_MIME_MULTI = "application/x-myne-note-multi";

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
    ? i18n.t("notes.folderManagement.tooLong")
    : i18n.t("notes.folderManagement.illegalSegment");
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
  // Pane/tab close on a subtree trash or archive (myne-md/myne#819) — the same
  // `closeNoteEverywhere` the single-note paths in NoteList call. OPTIONAL: a
  // unit test injects only `ctx` and mounts no workspace, and its handlers own
  // no panes, so `?.` is the honest read (the app's callers are always inside
  // the provider).
  const ws = useWorkspaceOptional();
  const closeTabs = useCallback(
    (ids: readonly string[]) => {
      if (ws === null) return;
      for (const id of ids) ws.closeNoteEverywhere(id);
    },
    [ws],
  );
  const [deliberate, setDeliberate] = useState<string[]>([]);
  // A ref alongside the state, read by `addDeliberate` (myne-md/myne#613
  // pr-review). That path used to compute its `next` inside a `setDeliberate`
  // updater and fire the IPC, the rollback and a user-visible notice from there;
  // updater functions are double-invoked in React 19 dev StrictMode, so the
  // notice could appear twice. Reading the ref keeps the updater pure.
  const deliberateRef = useRef<string[]>(deliberate);
  deliberateRef.current = deliberate;
  // Sync the local set from the mount-time prefs read; later mutated by ops.
  useEffect(() => {
    setDeliberate(prefs.deliberate_folders);
  }, [prefs.deliberate_folders]);

  // Folder-archive set (`archived_folders`) — the folder-level twin of the
  // per-note `archived:` marker; synced from prefs, mutated optimistically by
  // the archive / restore / delete / rename handlers, persisted best-effort.
  const [archivedFolders, setArchivedFoldersState] = useState<string[]>([]);
  useEffect(() => {
    setArchivedFoldersState(prefs.archived_folders);
  }, [prefs.archived_folders]);

  // Unified manual sidebar order (`item_order` prefs sequence) + favorites
  // (`favorites` prefs sequence, MYND-183), synced from the mount-time prefs
  // read and mutated optimistically by the reorder drag handlers (best-effort
  // persist, like `deliberate`). Favorites membership/reorder wiring lands in a
  // later task; here we expose the read so the tree + Favorites section consume
  // a single source.
  const [itemOrder, setItemOrder] = useState<Record<string, string[]>>({});
  const [favorites, setFavorites] = useState<string[]>([]);
  useEffect(() => {
    setItemOrder(prefs.item_order);
  }, [prefs.item_order]);
  useEffect(() => {
    setFavorites(prefs.favorites);
  }, [prefs.favorites]);

  // Decoration maps (MYND-184 color labels / MYND-185 folder icons), synced
  // from the mount-time prefs read and mutated optimistically by the picker
  // setters below. `itemColors` is keyed by note UUID OR the FOLDED folder
  // identity (`/`-discriminated like `item_order`; folder entries fold per
  // MYND-562); `folderIcons` by the folded folder identity.
  const [itemColors, setItemColorsState] = useState<Record<string, string>>({});
  const [folderIcons, setFolderIconsState] = useState<Record<string, string>>(
    {},
  );
  // Fold-on-load migration (MYND-562): re-key any legacy display-cased folder
  // entries to the folded identity so decorations follow the folder across
  // clients. Idempotent + self-healing; persists once when it actually changed.
  useEffect(() => {
    const { next, changed } = foldDecorationKeys(prefs.item_colors);
    setItemColorsState(next);
    if (changed) void persistItemColors(next);
  }, [prefs.item_colors]);
  useEffect(() => {
    const { next, changed } = foldDecorationKeys(prefs.folder_icons);
    setFolderIconsState(next);
    if (changed) void persistFolderIcons(next);
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

  /** Rewrite `item_order` through a folder-prefix transform, and persist when it
   *  moved. */
  const reorderRemap = useCallback(
    (remap: (order: Record<string, string[]>) => {
      next: Record<string, readonly string[]>;
      changed: boolean;
    }) => {
      const { next, changed } = remap(itemOrder as Record<string, string[]>);
      if (!changed) return;
      const asMutable = next as Record<string, string[]>;
      setItemOrder(asMutable);
      void persistItemOrder(asMutable);
    },
    [itemOrder],
  );

  // The latest derived tree, kept in a ref so handlers stay referentially
  // stable while still reading current subtree state (delete-emptiness etc.).
  const treeRef = useRef<FolderTree>(EMPTY_TREE);
  const draggedRef = useRef<NoteId | null>(null);
  // The full id payload when a multi-selection is being dragged (MYND-367);
  // empty for a single-note drag. Folder-drop fans out over this.
  const draggedIdsRef = useRef<NoteId[]>([]);
  // Folded key of the folder being dragged (folder-reorder drags only).
  const draggedFolderRef = useRef<string | null>(null);
  // The node a folder drag started from (myne#281). The folded key above is
  // enough to reorder among siblings; a re-nest re-roots the whole subtree and
  // needs the source PATH.
  const draggedFolderNodeRef = useRef<FolderNode | null>(null);

  const [menu, setMenu] = useState<FolderMenuState>(null);
  const [newFolder, setNewFolder] = useState<NewFolderState>(null);
  const [renamingFolderKey, setRenamingFolderKey] = useState<string | null>(null);
  /** A refused folder action reports through the ONE toast stack (#238). */
  const reportBlocked = useCallback((message: string) => {
    toast({ message, variant: "error", testId: "notes.folder-notice" });
  }, []);
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
  // `containerKey` is the folded folder key, or `""` for the root container —
  // exactly this container's key into the per-container `item_order` map
  // (MYND-596), so only its own sequence ranks it.
  const containerChildKeys = useCallback(
    (containerKey: string): string[] => {
      const tree = treeRef.current;
      const node =
        containerKey === "" ? null : findByFoldedKey(tree.roots, containerKey);
      const folders = containerKey === "" ? tree.roots : (node?.children ?? []);
      const noteIds =
        containerKey === "" ? tree.unfiledNoteIds : (node?.noteIds ?? []);
      const rank = buildContainerRank(itemOrder[containerKey] ?? []);
      // The pin rides along (myne#654). The comment above promises the reorder
      // baseline IS the render order, and a just-created note sorts above
      // everything while its pin is live, so omitting it here would make a drag
      // compute its indices against a list the user was not looking at. The
      // required parameter is what surfaced this call site.
      return orderContainerChildren(
        folders,
        noteIds,
        ctx.cache,
        rank,
        ctx.justCreatedId,
      ).map((c) => (c.kind === "folder" ? c.node.path : c.id));
    },
    [ctx.cache, itemOrder, ctx.justCreatedId],
  );

  /**
   * Drop the transient pin out of a sequence about to be PERSISTED.
   *
   * The baseline above must contain the pin, so the drag's indices match what
   * the user sees. The persisted `item_order` must not, and both headers this
   * feature added say so: `SidebarState.justCreatedId` is "transient and never
   * persisted … it must not reach `item_order` in `vault.prefs`", and
   * `orderContainerChildren` names writing the new note into `item_order` at
   * index 0 as the rejected alternative. Without this the first drag anywhere
   * in that container writes the pin in permanently, and to every device, which
   * is that rejected alternative arriving through the back door.
   *
   * The pinned note stays out unless the user dragged it themselves, in which
   * case it is no longer a pin, it is a choice.
   */
  const withoutPin = useCallback(
    (next: Record<string, string[]>, draggedKey: string): Record<string, string[]> => {
      const pin = ctx.justCreatedId;
      if (pin === null || pin === draggedKey) return next;
      const out: Record<string, string[]> = {};
      for (const [container, seq] of Object.entries(next)) {
        out[container] = seq.filter((k) => k !== pin);
      }
      return out;
    },
    [ctx.justCreatedId],
  );

  const addDeliberate = useCallback(
    (path: string) => {
      // Computed from the ref rather than inside a `setDeliberate` updater.
      // Updater functions are double-invoked in React 19 dev StrictMode, and
      // this one issues an IPC and, since myne-md/myne#613, a user-VISIBLE
      // notice: the shape was survivable while the effect was invisible and is
      // not once a toast can appear twice.
      const prev = deliberateRef.current;
      const key = foldSegment(path);
      const already = prev.some(
        (held: string) => foldSegment(normalizeFolderPath(held) ?? "") === key,
      );
      if (already) return;
      const next = [...prev, path];
      setDeliberate(next);
      // #259 audit: revert on a failed write like every sibling. An empty
      // folder that exists only in this set silently disappears at the next
      // unlock if the write never landed, and the user was shown it as made.
      //
      // myne-md/myne#613 split that one failure into two, because they need
      // opposite treatment. A thrown write is retried once inside
      // `registerDeliberateFolders` and only reported if it fails again: there
      // is nothing the user can do about a disk hiccup, and a notice they
      // cannot act on teaches them to dismiss notices. A budget refusal is
      // reported at once and NOT retried, because the reserve is full, the next
      // attempt refuses identically, and the remedy is theirs.
      //
      // The budget case does NOT revert: the folder was created, it works
      // exactly as folders did before this feature, and what it loses is only
      // the promise to outlive being emptied, which is what the notice says.
      void registerDeliberateFolders(mutationFrom(prev, next)).then((outcome) => {
        if (outcome === "budget-full") {
          reportBlocked(i18n.t("notes.folderManagement.folderListFull"));
        } else if (outcome === "failed") {
          setDeliberate(prev);
          reportBlocked(i18n.t("notes.folderManagement.folderNotRemembered"));
        }
      });
    },
    [],
  );

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
        else reportBlocked(folderInputRejectionMessage(rejection));
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
  const newDrawingHere = useCallback(
    (folderPath: string) => {
      setMenu(null);
      void ctx.createDrawingAndStartRename(folderPath).catch(() => {});
    },
    [ctx],
  );

  // ---- rename folder -------------------------------------------------------
  const startRenameFolder = useCallback((node: FolderNode) => {
    setMenu(null);
    setRenamingFolderKey(node.key);
  }, []);
  const cancelRenameFolder = useCallback(() => setRenamingFolderKey(null), []);
  /**
   * Move a folder's whole subtree from `node.path` to `newPath`.
   *
   * The engine underneath is `renameFolder`, which already re-roots the
   * `folder:` frontmatter of every note beneath the folder transactionally and
   * rewrites inbound `[[Old/]]` links. A rename and a re-nest are the same
   * operation over that engine — only the new path differs — so both go through
   * here rather than either growing a second copy of the decoration, deliberate
   * and archived re-rooting that has to follow it (myne#281).
   */
  const applyFolderPathChange = useCallback(
    async (node: FolderNode, newPath: string) => {
      // `renameFolder` opens with `flushOpenPanes()`, which REJECTS when a pane
      // did not settle (myne-md/myne#520). Declining the rename is the right
      // answer, since the batch reads every note from disk and would write over
      // whatever that pane still holds, but a silent decline is
      // indistinguishable from a rename that did nothing. Say so.
      //
      // Two different sentences rather than one, and neither rethrows. A bare
      // `catch` attributed every rejection to an unsettled pane; a rethrow
      // reported nothing at all, because every route in is a `void fm.…` with no
      // `.catch`. The third failure mode, a rejection with the rename already
      // committed, is not here any more: `renameFolder` reports that one as
      // `deliberateWriteFailed` precisely so this catch cannot swallow the
      // re-rooting the landed rename still owes. See the tail of this callback.
      let result;
      try {
        result = await renameFolder(node.path, newPath, notesForOps(), deliberate);
      } catch (err) {
        // Both arms REPORT, and neither rethrows. Every caller of this reaches it
        // through a `void fm.moveFolderTo(...)` or `void fm.commitRenameFolder(...)`
        // with no `.catch`, so a rethrow is an unhandled rejection and nothing on
        // screen, which is worse than the wrong notice it replaced. The folder
        // sentence is the folder-specific one rather than the neutral shared
        // string, which is what `panesNotSettledMessage` taking resolved
        // sentences is for.
        reportBlocked(
          panesNotSettledMessage(err, {
            unsettled: i18n.t("notes.folderManagement.unsettledSave"),
            failed: i18n.t("notes.folderManagement.renameFailed"),
          }),
        );
        return;
      }
      setDeliberate(result.nextDeliberate);
      // A rename that did not land must not fall through as a success. Two arms
      // report it as a VALUE rather than throwing (`invalid` before any work,
      // `failed` after a refused batch), and neither was read here, so the input
      // closed on the old name with nothing said: the "I typed a name, pressed
      // Enter, and nothing saved" report. The note-title twin reports every arm;
      // this path reported only the thrown one.
      //
      // Bailing HERE, before the re-rooting below, is the other half: that block
      // is the post-commit work of a rename that happened. Running it on a
      // refused rename re-pointed the folder's colour, its icon and its
      // `archived_folders` entry at a path no note carries, so a rename that
      // failed also silently stripped the folder's colour and un-archived its
      // subtree. Gated on the rename having LANDED rather than on `!invalid`,
      // which is true for the refused arm too.
      if (result.invalid === true || result.failed.length > 0) {
        reportBlocked(i18n.t("notes.folderManagement.renameFailed"));
        return;
      }
      // Re-root the folder's color + icon onto the new path (and any descendant
      // folder's, since the rename re-roots the whole subtree) so a rename
      // never silently strips a decoration (MYND-184/185 durability).
      applyDecorationRemap((m) => rewriteFolderPrefix(m, node.path, newPath));
      // The manual ORDER is path-keyed too: skip this and the folder's position
      // and every child entry naming it are dropped (owner, 2026-11-08).
      reorderRemap((order) => rewriteItemOrderPrefix(order, node.path, newPath));
      // Re-root the archived_folders set too (folder-archive) — else renaming
      // an ancestor of an archived folder would leave a stale entry and the
      // subtree would silently un-archive. Folded-prefix, same subtree as the
      // deliberate re-root inside `renameFolder`.
      const reroot = rerootArchivedFolders(node.path, newPath, archivedFolders);
      const oldKey = foldSegment(normalizeFolderPath(node.path) ?? "");
      if (oldKey !== "") {
        // #259: revert the optimistic state when the disk write fails —
        // otherwise the UI shows the re-rooted set for the rest of the
        // session while `vault.prefs` still holds paths under the OLD name,
        // and at the next unlock the whole subtree silently un-archives.
        // Same shape as `performFolderArchive` below, which had it already.
        //
        // The WRITE states the subtree as one prefix verb and lets the core
        // resolve it against the stored set (myne#613 review round 2); only
        // the optimistic state uses `reroot.next`. The `rewritten > 0` guard
        // is gone with it, because it read the same local set: it can only
        // under-report, and under-reporting here skips a re-root that was
        // needed. `reroot` is still what the UI renders, which is the half a
        // local set is allowed to decide.
        const prevArchived = archivedFolders;
        setArchivedFoldersState(reroot.next);
        void mutateArchivedFolders({
          renamePrefix: [{ from: oldKey, to: newPath }],
        }).catch(() => {
          setArchivedFoldersState(prevArchived);
        });
      }
      await Promise.all(result.moved.map((id) => ctx.refreshOne(id)));
      // Last, and deliberately AFTER the re-rooting above. The rename committed
      // and only the `deliberate_folders` write failed, so the notes are right
      // and one setting is not; running the re-rooting first is what keeps the
      // decoration map and `archived_folders` from ALSO drifting off a rename
      // that landed. Nothing reconciles `vault.prefs` against note frontmatter
      // later, so the user is the reconciliation.
      if (result.deliberateWriteFailed === true) {
        // The in-memory set KEEPS the new path, deliberately, and this is the one
        // place in this file that does not revert an optimistic prefs write. The
        // #259 shape reverts because there the write was the whole action; here
        // the rename landed on disk, so the old path is the value that disagrees
        // with the notes. Neither choice is right, and the message is what makes
        // the surviving disagreement legible instead of silent: it names the
        // residue (an empty folder back under the old name at the next unlock)
        // and says removing it is safe, rather than promising a retry that a
        // second rename cannot perform.
        reportBlocked(i18n.t("notes.folderManagement.deliberateWriteFailed"));
      } else if (result.mcpScopeRewriteFailed === true) {
        // A different failure with a different consequence, so it gets its own
        // sentence rather than sharing the one above: the notes are right and the
        // deliberate set is right, but an external connection's exclusions still
        // name the OLD path, which for a deny list means the folder it was kept
        // out of is now readable. Nothing reconciles it later, so the user is told
        // where to look instead of being told the rename is done.
        reportBlocked(i18n.t("notes.folderManagement.mcpScopeRewriteFailed"));
      } else if (result.attachmentFolderRewriteFailed === true) {
        // Third failure, third consequence: the notes moved and the exclusions
        // moved, but an attachment still names the folder's OLD path, so it has
        // left the library's tree and any agent scoped to that folder. Nothing
        // reconciles it later, because a second rename keys off the current path.
        reportBlocked(i18n.t("notes.folderManagement.attachmentFolderRewriteFailed"));
      }
    },
    [ctx, deliberate, archivedFolders, notesForOps, applyDecorationRemap, reorderRemap],
  );

  const commitRenameFolder = useCallback(
    async (node: FolderNode, newName: string) => {
      const newPath = folderParent(node.path) + newName + "/";
      // Grammar gate (markdown-dialect §3.6.2): a rename edits a single
      // segment, so `newName` must itself be one legal segment (no `/`), and
      // the resulting path must fit PATH_MAX. On rejection keep the rename
      // input open (don't clear `renamingFolderKey`) + surface the notice.
      if (!isLegalSegment(newName)) {
        reportBlocked(folderInputRejectionMessage("illegal-segment"));
        return;
      }
      if (!isLegalPathLength(newPath)) {
        reportBlocked(folderInputRejectionMessage("too-long"));
        return;
      }
      setRenamingFolderKey(null);
      await applyFolderPathChange(node, newPath);
    },
    [applyFolderPathChange],
  );

  // ---- move folder (re-nest) ----------------------------------------------
  /**
   * Re-nest `node` under `targetParent` (`null` ≡ vault root) — myne#281.
   *
   * Before this the folder tree could only be re-nested by deleting and
   * recreating, by moving every note out one at a time, or by the undocumented
   * side effect of typing a slash into the rename field. A folder drag had two
   * edge zones and no middle, and the folder context menu had no "Move to…"
   * even though the note menu did.
   *
   * Three guards a note move does not need, all of which fail LOUDLY rather
   * than silently doing nothing:
   *
   *   - **into itself or its own descendant** would orphan the subtree, and is
   *     the one drop a tree makes easy to attempt by accident;
   *   - **a name collision** in the target would merge two folders' contents
   *     with no way back;
   *   - **PATH_MAX**, since nesting only ever makes the path longer.
   *
   * A move to where the folder already is is a no-op, not an error.
   */
  const moveFolderTo = useCallback(
    async (node: FolderNode, targetParent: string | null) => {
      setMenu(null);
      const parent = targetParent === null ? "" : normalizeFolderPath(targetParent);
      if (parent === null) return;
      const name = node.path.slice(folderParent(node.path).length);
      const newPath = parent + name;
      const norm = normalizeFolderPath(newPath);
      if (norm === null) {
        reportBlocked(folderInputRejectionMessage("illegal-segment"));
        return;
      }
      // Already there — nothing to do, and reporting it as an error would be
      // wrong.
      if (foldSegment(norm) === foldSegment(node.path)) return;
      // Into itself or its own descendant: `Projects/` cannot live inside
      // `Projects/Myne/`. Folded so a case-only spelling cannot slip past.
      if (foldSegment(parent).startsWith(foldSegment(node.path))) {
        reportBlocked(i18n.t("notes.folderManagement.moveIntoSelf"));
        return;
      }
      if (!isLegalPathLength(norm)) {
        reportBlocked(folderInputRejectionMessage("too-long"));
        return;
      }
      // A folder of the same folded name already in the target would merge two
      // subtrees irreversibly.
      const existing = findByFoldedKey(treeRef.current.roots, foldSegment(norm));
      if (existing !== null) {
        reportBlocked(i18n.t("notes.folderManagement.moveCollision"));
        return;
      }
      await applyFolderPathChange(node, norm);
    },
    [applyFolderPathChange],
  );

  // ---- delete folder -------------------------------------------------------
  // Execute a planned delete: soft-trash the subtree notes (recoverable from
  // Trash, MYND-133), then trim the deliberate set + prune decorations. Shared
  // by the empty-folder fast path (no notes, no confirm) and the confirmed
  // non-empty path. Replaces the pre-2026-06-09 "block when non-empty" gate.
  const performFolderDelete = useCallback(
    async (node: FolderNode, plan: FolderDeletePlan) => {
      if (plan.noteIds.length > 0) {
        const result = await ctx.bulkTrashWithSync(plan.noteIds);
        // Close the trashed subtree's tabs (myne-md/myne#819): a stale
        // still-editable buffer autosaved back would resurrect the note, and a
        // hard-delete route would re-create an erased file. Only the successes.
        closeTabs(result.trashed);
        // If the open/selected note just went to Trash, don't dwell on it.
        if (ctx.selectedId !== null && plan.noteIds.includes(ctx.selectedId)) {
          ctx.select(null);
        }
      }
      await persistFolderDelete(plan);
      setDeliberate(plan.nextDeliberate);
      // A deleted folder's archived_folders entries go with it (the folder no
      // longer exists) — cascade-remove them so no stale entry lingers
      // (folder-archive). Folded-prefix, mirrors the deliberate trim.
      const nextArchived = planFolderUnarchive(node.path, archivedFolders);
      if (nextArchived.length !== archivedFolders.length) {
        // Same revert as the rename path (#259): a fire-and-forget write leaves
        // the UI and disk disagreeing until the next unlock resolves it in
        // disk's favour.
        const prevArchived = archivedFolders;
        setArchivedFoldersState(nextArchived);
        void mutateArchivedFolders(mutationFrom(prevArchived, nextArchived)).catch(() => {
          setArchivedFoldersState(prevArchived);
        });
      }
      // Prune the deleted folder's (and its deliberate descendants') color +
      // icon (MYND-184/185 durability).
      applyDecorationRemap((m) => pruneFolderPrefix(m, node.path));
    },
    [ctx, closeTabs, archivedFolders, applyDecorationRemap],
  );

  // ---- archive / restore folder (folder-archive) ---------------------------
  // Archive a folder as a UNIT: a pure `archived_folders` prefs-set mutation
  // (no note frontmatter written). The subtree drops out of the working-set
  // tree via `liveCache` while the notes stay resolvable. Restore removes the
  // folded-prefix subtree from the set (Archive panel).
  const performFolderArchive = useCallback(
    (plan: FolderArchivePlan) => {
      const prev = archivedFolders;
      setArchivedFoldersState(plan.nextArchived);
      void mutateArchivedFolders(mutationFrom(archivedFolders, plan.nextArchived)).catch(() => {
        setArchivedFoldersState(prev); // disk write failed → revert optimistic UI
      });
      // The folder leaves the live tree; close its notes' tabs so no hidden note
      // stays open in a pane (myne-md/myne#819). Unlike subtree trash this writes
      // no note frontmatter, so the hazard is a lingering hidden tab, not
      // resurrection — hence close regardless of the optimistic prefs write.
      closeTabs(plan.noteIds);
      // If the open/selected note just left the working set, don't dwell on it.
      if (ctx.selectedId !== null && plan.noteIds.includes(ctx.selectedId)) {
        ctx.select(null);
      }
    },
    [ctx, closeTabs, archivedFolders],
  );

  const archiveFolderAction = useCallback(
    (node: FolderNode) => {
      setMenu(null);
      // No confirmation — reversible (parity with note-archive).
      const plan = planFolderArchive(node.path, treeRef.current, archivedFolders);
      performFolderArchive(plan);
    },
    [archivedFolders, performFolderArchive],
  );

  const restoreFolder = useCallback(
    (path: string) => {
      const prev = archivedFolders;
      const next = planFolderUnarchive(path, archivedFolders);
      if (next.length === prev.length) return; // nothing archived under `path`
      setArchivedFoldersState(next);
      void mutateArchivedFolders(mutationFrom(prev, next)).catch(() => {
        setArchivedFoldersState(prev);
      });
    },
    [archivedFolders],
  );

  // Archive-panel folder-row "Delete → Trash": the archived folder is absent
  // from the live tree, so its subtree note ids come from the FULL cache by
  // prefix (not `planFolderDelete`, which reads the tree). Soft-trashes them,
  // then removes the folder from archived_folders + trims the deliberate set +
  // prunes decorations — the same cleanup `performFolderDelete` does. The
  // caller confirms first (subtree move-to-Trash).
  const deleteArchivedFolderToTrash = useCallback(
    async (path: string) => {
      const key = folderKey(path);
      if (key.length === 0) return;
      const ids = collectSubtreeNoteIdsFromCache(ctx.cache, key);
      if (ids.length > 0) {
        const result = await ctx.bulkTrashWithSync(ids);
        // Close the subtree's trashed tabs (myne-md/myne#819). Only the successes.
        closeTabs(result.trashed);
        if (ctx.selectedId !== null && ids.includes(ctx.selectedId)) {
          ctx.select(null);
        }
      }
      const nextArchived = planFolderUnarchive(path, archivedFolders);
      if (nextArchived.length !== archivedFolders.length) {
        const prevArchived = archivedFolders;
        setArchivedFoldersState(nextArchived);
        void mutateArchivedFolders(mutationFrom(prevArchived, nextArchived)).catch(() => {
          setArchivedFoldersState(prevArchived);
        });
      }
      const nextDeliberate = deliberate.filter((f) => !folderKey(f).startsWith(key));
      if (nextDeliberate.length !== deliberate.length) {
        // The deliberate set is the same class of optimistic write (#259 audit
        // of the sibling call sites): shown as applied, persisted or not.
        const prevDeliberate = deliberate;
        setDeliberate(nextDeliberate);
        void mutateDeliberateFolders(mutationFrom(prevDeliberate, nextDeliberate)).catch(() => {
          setDeliberate(prevDeliberate);
        });
      }
      applyDecorationRemap((m) => pruneFolderPrefix(m, path));
    },
    [ctx, closeTabs, archivedFolders, deliberate, applyDecorationRemap],
  );

  // The tree is the LIVE set, so a subtree the live tree cannot see (an event,
  // an archived folder's notes) reads as empty here and would skip both the
  // confirmation and the trash. Widen the plan with the full-cache ids so the
  // count the dialog shows is the set the delete touches.
  const planFullFolderDelete = useCallback(
    (path: string): FolderDeletePlan => {
      const plan = planFolderDelete(path, treeRef.current, deliberate);
      const norm = normalizeFolderPath(path);
      const fromCache =
        norm === null ? [] : collectSubtreeNoteIdsFromCache(ctx.cache, foldSegment(norm));
      if (fromCache.length === 0) return plan;
      return { ...plan, noteIds: [...new Set([...plan.noteIds, ...fromCache])] };
    },
    [ctx.cache, deliberate],
  );

  const deleteFolderAction = useCallback(
    (node: FolderNode) => {
      setMenu(null);
      const plan = planFullFolderDelete(node.path);
      if (plan.noteIds.length === 0) {
        // Note-empty folder → delete immediately (no confirmation, unchanged).
        void performFolderDelete(node, plan).catch(() => {});
        return;
      }
      // Non-empty → confirm first; the subtree notes move to Trash on confirm.
      setConfirmFolderDelete({ node, noteCount: plan.noteIds.length });
    },
    [planFullFolderDelete, performFolderDelete],
  );

  const confirmFolderDeleteAction = useCallback(() => {
    const pending = confirmFolderDelete;
    if (pending === null) return;
    setConfirmFolderDelete(null);
    // Recompute against the live tree at confirm time (notes may have moved
    // while the dialog was open) — pure, cheap.
    const plan = planFullFolderDelete(pending.node.path);
    void performFolderDelete(pending.node, plan).catch(() => {});
  }, [confirmFolderDelete, planFullFolderDelete, performFolderDelete]);

  const cancelFolderDelete = useCallback(
    () => setConfirmFolderDelete(null),
    [],
  );

  // ---- drag & drop ---------------------------------------------------------
  //
  // Three gestures share the HTML5 drag machinery, discriminated by `dragKind`:
  //   note  → drop ON a folder row = move into folder; drop BETWEEN note rows =
  //           reorder (and move into the target's folder when crossing folders).
  //   folder→ drop BETWEEN sibling folder rows = reorder (same-parent only).
  // Refs carry the dragged identity (note id / folded folder key); the dropped
  // payload is read from the ref, not from dataTransfer (single-app drag).

  const onNoteDragStart = useCallback(
    (e: DragEvent, id: NoteId) => {
      draggedRef.current = id;
      draggedFolderRef.current = null;
      // Multi-drag (MYND-367): when the grabbed row is part of a >1 selection,
      // the drag carries the WHOLE set so a folder drop moves all of them. A
      // drag started on a row OUTSIDE the selection is a plain single-note drag
      // (and does not disturb the selection).
      const set = ctx.selectedIds;
      const ids = set.size > 1 && set.has(id) ? [...set] : [id];
      draggedIdsRef.current = ids;
      e.dataTransfer.setData(DRAG_MIME, id);
      if (ids.length > 1) {
        e.dataTransfer.setData(DRAG_MIME_MULTI, JSON.stringify(ids));
      }
      // Also carry the workspace tab-open payload (MYND-166) so the SAME drag
      // can drop on a folder row (folder-move, reads DRAG_MIME) OR on a pane /
      // tab strip (open as tab / split, reads TAB_DRAG_MIME). `fromPaneId: null`
      // marks the sidebar origin — the note may not be open in any pane yet.
      writeTabDrag(e.dataTransfer, {
        tabId: itemKey(noteItem(id)),
        fromPaneId: null,
      });
      e.dataTransfer.effectAllowed = "move";
      setDragKind("note");
    },
    [ctx.selectedIds],
  );

  const onFolderDragStart = useCallback((e: DragEvent, node: FolderNode) => {
    draggedFolderRef.current = node.key;
    // myne#281 — the drop target needs the NODE, not just its folded key: a
    // re-nest re-roots the whole subtree and has to name the source path.
    draggedFolderNodeRef.current = node;
    draggedRef.current = null;
    e.dataTransfer.setData(FOLDER_DRAG_MIME, node.path);
    e.dataTransfer.effectAllowed = "move";
    setDragKind("folder");
  }, []);

  // Clears all transient drag UI — fired on dragend (covers drops that land
  // outside any target, and Esc-cancelled drags).
  const onDragEndCleanup = useCallback(() => {
    draggedRef.current = null;
    draggedIdsRef.current = [];
    draggedFolderRef.current = null;
    draggedFolderNodeRef.current = null;
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
      // Fan out over the multi-drag payload when present (MYND-367); otherwise
      // the single grabbed note. Reading the ref (not dataTransfer) keeps this
      // a single-app drag, consistent with the reorder paths.
      const ids =
        draggedIdsRef.current.length > 0
          ? draggedIdsRef.current
          : draggedRef.current !== null
            ? [draggedRef.current]
            : [];
      draggedRef.current = null;
      draggedIdsRef.current = [];
      setDropTargetKey(null);
      setDragKind(null);
      if (ids.length === 0) return;
      if (ids.length === 1) {
        await moveNote(ids[0]!, folderPath);
        await ctx.refreshOne(ids[0]!);
        return;
      }
      await ctx.bulkMoveWithSync(ids, folderPath);
      ctx.clearMultiSelection();
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
    await applyReorderWrite<Record<string, string[]>>({
      moveFirst: crossContainer
        ? async () => {
            await moveNote(id, null);
            await ctx.refreshOne(id);
          }
        : null,
      computeNext: () =>
        withoutPin(
          computeItemOrderAfterReorder({
            itemOrder: prevOrder,
            container: containerKeyOf(null), // root container = ""
            containerChildKeys: containerChildKeys("").filter((k) => k !== id),
            draggedKey: id,
            targetKey: "", // no row target → appends at the root end
            place: "below",
          }),
          id,
        ),
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
        await applyReorderWrite<Record<string, string[]>>({
          moveFirst: crossContainer
            ? async () => {
                await moveNote(noteDrag, containerPath);
                await ctx.refreshOne(noteDrag);
              }
            : null,
          computeNext: () =>
            withoutPin(
              computeItemOrderAfterReorder({
                itemOrder: prevOrder,
                container: containerKey,
                containerChildKeys: containerChildKeys(containerKey).filter(
                  (k) => k !== noteDrag,
                ),
                draggedKey: noteDrag,
                targetKey,
                place,
              }),
              noteDrag,
            ),
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
        await applyReorderWrite<Record<string, string[]>>({
          moveFirst: null,
          computeNext: () =>
            computeItemOrderAfterReorder({
              itemOrder: prevOrder,
              container: containerKey,
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
      // Favorites stay a FLAT `string[]` (MYND-596 mapifies only `item_order`),
      // so the generic dual-write helper is instantiated over `string[]` here.
      await applyReorderWrite<string[]>({
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
      // Favorites is a single flat sequence, so it uses the pure single-sequence
      // reorder directly (MYND-596) rather than the container-keyed map compute.
      const next = reorderSequence({
        containerChildKeys: favorites.filter((f) => f !== draggedId),
        draggedKey: draggedId,
        targetKey: targetId,
        place,
      });
      void writeFavorites(next);
    },
    [favorites, writeFavorites],
  );

  /**
   * The non-drag path for the favourites reorder (myne-md/myne#728, WCAG
   * 2.5.7, found in review). Favourites are a user-ordered sequence and drag
   * was the only way to change that order.
   *
   * A sibling of `reorderFavorite` rather than a caller of it: that one reads
   * `draggedRef.current` and clears four pieces of drag state, so driving it
   * from a key press would mean faking a drag that never happened. This moves
   * by one slot against the CURRENT list, which is what Alt+Arrow means, and
   * clamps at the ends rather than wrapping.
   */
  const moveFavorite = useCallback(
    (id: NoteId, delta: -1 | 1) => {
      const from = favorites.indexOf(id);
      if (from === -1) return;
      const to = from + delta;
      if (to < 0 || to >= favorites.length) return;
      const next = [...favorites];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) return;
      next.splice(to, 0, moved);
      void writeFavorites(next);
    },
    [favorites, writeFavorites],
  );

  return {
    deliberate,
    archivedFolders,
    archiveFolderAction,
    restoreFolder,
    deleteArchivedFolderToTrash,
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
    moveFolderTo,
    caseMerge,
    confirmCaseMerge,
    cancelCaseMerge,
    newNoteHere,
    newDrawingHere,
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
    moveFavorite,
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
    /** The folder node a drag started from, or `null` (myne#281). */
    get dragFolderNode() {
      return draggedFolderNodeRef.current;
    },
    /** Resolve the folder a drop names in its payload, for a drag whose ref the
     *  browser already cleared. */
    folderNodeAt: (path: string | null): FolderNode | null => {
      if (path === null) return null;
      const norm = normalizeFolderPath(path);
      return norm === null ? null : findByFoldedKey(treeRef.current.roots, foldSegment(norm));
    },
    onDragEndCleanup,
    // decorations (MYND-184 color labels / MYND-185 folder icons)
    itemColors,
    setItemColor,
    folderIcons,
    setFolderIcon,
  };
}

export type FolderManagement = ReturnType<typeof useFolderManagement>;
