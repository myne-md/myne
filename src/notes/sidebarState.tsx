// `sidebarState` — Editor-screen-scoped React Context that holds the
// sidebar's selected ID, in-flight rename state, and the
// `Map<NoteId, TitleRecord>` cache that backs the rendered list.
//
// Per the 2026-05-15 MYND-82 grill Q15 (state location: `src/notes/`
// React Context, not the app-state-machine) + Q13 (hybrid initial-boot
// + action-driven surgical refresh + optimistic UI for create / delete /
// rename, no-optimistic for saveNote).
//
// Pure helpers (`applyCacheUpdate`, `applyOptimistic*`, `rollback*`,
// `sortBatchIds`) are exported alongside the React API so tests can
// exercise the state-transition logic without rendering a tree. The
// Context layer is a thin wrapper that owns the `useState` slot + the
// IPC orchestration (calls into `createNote` / `renameNote` /
// `deleteNote` / `loadNoteBatch` from the same module).

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createNote } from "./createNote";
import { deleteNote } from "./deleteNote";
import { duplicateNote } from "./duplicateNote";
import { emptyTrash, type EmptyTrashResult } from "./emptyTrash";
import { bulkMoveNotes, type BulkMoveResult } from "./moveNote";
import {
  bulkTrashNotes,
  restoreNote,
  trashNote,
  type BulkTrashResult,
} from "./trashNote";
import {
  loadNoteBatch,
  type TitleRecord,
} from "./loadNoteBatch";
import { noteRead } from "./readNote";
import { renamedTitleBody } from "./renameNote";
import { resolverNotesFromCache } from "./resolverNotes";
import {
  defaultRenameInboundDeps,
  planRenameBatch,
} from "./renameInbound";
import { renameFlushHooks } from "./renameFlushHook";
import { noteWriteBatchTransactional } from "./noteWriteBatch";
import {
  hydrateVaultIndicesOnUnlock,
  reindexNote,
  vaultIndicesRemove,
} from "./vaultIndices";

export type NoteId = string;

export type SidebarState = {
  selectedId: NoteId | null;
  /**
   * Multi-selection set (MYND-367) — the ids cmd/ctrl-click and shift-click
   * have gathered for a bulk operation. STRICTLY independent of `selectedId`:
   * a selection-set change must never flow through `selectedId` because that
   * drives Editor.tsx's open-bridge (a `selectedId` write opens the note in the
   * focused pane). Toggle / range gestures leave `selectedId` untouched so the
   * editor keeps showing the open note; a plain click collapses the set and
   * single-selects. Empty in the common single-selection case.
   */
  selectedIds: ReadonlySet<NoteId>;
  /** Range-selection pivot for shift-click (MYND-367) — the last toggled row,
   *  so successive shift-clicks extend from a stable origin. */
  anchorId: NoteId | null;
  renamingId: NoteId | null;
  cache: Map<NoteId, TitleRecord>;
  /**
   * Bumped whenever the currently-open note is mutated on disk by a
   * sidebar action (today: rename). The Editor watches this to silently
   * re-read the open note's body so the editor's local content — and
   * therefore the autosave writer — picks up the change instead of
   * clobbering it on the next save (MYND-140). Selection-driven loads
   * use `selectedId`; this is strictly for "the open note changed under
   * us" re-syncs.
   */
  contentReloadNonce: number;
};

export const EMPTY_SIDEBAR_STATE: SidebarState = {
  selectedId: null,
  selectedIds: new Set(),
  anchorId: null,
  renamingId: null,
  cache: new Map(),
  contentReloadNonce: 0,
};

// ============================================================
// Pure state transitions — testable without a React renderer.
// ============================================================

/**
 * Replace (or insert) the cache entry for `id`. Returns a fresh
 * `SidebarState` with a new `Map` instance so React's `useState` shallow
 * equality picks up the change.
 */
export function applyCacheUpdate(
  state: SidebarState,
  id: NoteId,
  record: TitleRecord,
): SidebarState {
  const cache = new Map(state.cache);
  cache.set(id, record);
  return { ...state, cache };
}

/**
 * Optimistic insert: the user just clicked "+ New Note"; the IPC is
 * in flight but the row appears immediately. The placeholder record
 * has `title: null` (rendered as "Untitled" italic placeholder per Q2)
 * and `updatedAt: null` (sort fallback to UUIDv7-derived created_at
 * per Q1; the new note's UUIDv7 timestamp is the latest, so it lands
 * at the top of the list).
 */
export function applyOptimisticCreate(
  state: SidebarState,
  id: NoteId,
): SidebarState {
  return applyCacheUpdate(state, id, {
    noteUuid: id,
    title: null,
    folder: null,
    updatedAt: null,
    trashed: null,
    template: false,
    folderIndex: false,
  });
}

/**
 * Live (working-set) entries of the cache as a fresh `Map`, for the sidebar
 * tree / folder derivation / favorites. A record is excluded when it is in the
 * trash (value-strict `trashed:` marker non-null, MYND-133) OR is a template
 * (value-strict `template:` flag, MYND-186) — templates are the inverse-
 * visibility twin of trash: hidden from every working view, surfaced only by the
 * template picker + management UI ({@link templateRecords}). The trash complement
 * ({@link trashedRecords} / {@link trashedCount}) backs the Trash panel + count.
 */
export function liveCache(
  cache: ReadonlyMap<NoteId, TitleRecord>,
): Map<NoteId, TitleRecord> {
  const live = new Map<NoteId, TitleRecord>();
  for (const [id, record] of cache) {
    // `== null` (loose) treats a missing marker as live — defensive against a
    // record constructed without the field. Templates are excluded regardless of
    // trash state (a template is never part of the working set).
    if (record.trashed == null && record.template !== true) live.set(id, record);
  }
  return live;
}

/** Trashed entries of the cache (the Trash panel view), newest-trashed first.
 * Includes trashed templates — a deleted template is restorable from Trash and
 * re-enters the template set on restore (MYND-186). */
export function trashedRecords(
  cache: ReadonlyMap<NoteId, TitleRecord>,
): TitleRecord[] {
  const out: TitleRecord[] = [];
  for (const record of cache.values()) {
    if (record.trashed != null) out.push(record);
  }
  out.sort((a, b) => (b.trashed ?? "").localeCompare(a.trashed ?? ""));
  return out;
}

/** Count of trashed entries — the Trash footer count. Independent of the
 * template flag (a trashed template still occupies the Trash), so this is the
 * correct count now that {@link liveCache} also excludes templates and the old
 * `cache.size - live.size` delta would over-count by the template population. */
export function trashedCount(cache: ReadonlyMap<NoteId, TitleRecord>): number {
  let n = 0;
  for (const record of cache.values()) {
    if (record.trashed != null) n += 1;
  }
  return n;
}

/**
 * Template entries of the cache — the canonical enumeration the template picker
 * (#5) and management UI (#4) read (MYND-186; SYNC-9 `listTemplates`). A record
 * is a template iff its value-strict `template:` flag is set; trashed templates
 * are **excluded** (a deleted template leaves the picker but stays restorable in
 * Trash). Ordered newest-updated first, falling back to title for records
 * without an `updated:` timestamp.
 */
export function templateRecords(
  cache: ReadonlyMap<NoteId, TitleRecord>,
): TitleRecord[] {
  const out: TitleRecord[] = [];
  for (const record of cache.values()) {
    if (record.template === true && record.trashed == null) out.push(record);
  }
  out.sort((a, b) => {
    const at = a.updatedAt?.getTime() ?? 0;
    const bt = b.updatedAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  return out;
}

/**
 * Rollback for [`applyOptimisticCreate`] — drops the row on IPC
 * failure. No-op if the entry is no longer in the cache (a refresh
 * may have settled the state in between).
 */
export function rollbackOptimisticCreate(
  state: SidebarState,
  id: NoteId,
): SidebarState {
  if (!state.cache.has(id)) return state;
  const cache = new Map(state.cache);
  cache.delete(id);
  return { ...state, cache };
}

export type DeleteSnapshot = {
  record: TitleRecord | null;
  wasSelected: boolean;
};

/**
 * Optimistic delete: removes the row from the cache immediately.
 * Returns the removed record + selection flag so [`rollbackOptimisticDelete`]
 * can restore both.
 */
export function applyOptimisticDelete(
  state: SidebarState,
  id: NoteId,
): { next: SidebarState; snapshot: DeleteSnapshot } {
  const record = state.cache.get(id) ?? null;
  const wasSelected = state.selectedId === id;
  const cache = new Map(state.cache);
  cache.delete(id);
  const next: SidebarState = {
    ...state,
    cache,
    selectedId: wasSelected ? null : state.selectedId,
    renamingId: state.renamingId === id ? null : state.renamingId,
  };
  return { next, snapshot: { record, wasSelected } };
}

/**
 * Rollback for [`applyOptimisticDelete`] — restores the row and (if
 * it was selected at the time of deletion) the selection state.
 */
export function rollbackOptimisticDelete(
  state: SidebarState,
  id: NoteId,
  snapshot: DeleteSnapshot,
): SidebarState {
  const cache = new Map(state.cache);
  if (snapshot.record !== null) {
    cache.set(id, snapshot.record);
  }
  return {
    ...state,
    cache,
    selectedId: snapshot.wasSelected ? id : state.selectedId,
  };
}

export type RenameSnapshot = {
  prevTitle: string | null;
};

/**
 * Optimistic rename: updates the cache entry's title field
 * immediately. Returns the previous title so [`rollbackOptimisticRename`]
 * can restore it on IPC failure.
 */
export function applyOptimisticRename(
  state: SidebarState,
  id: NoteId,
  newTitle: string,
): { next: SidebarState; snapshot: RenameSnapshot } {
  const existing = state.cache.get(id);
  if (existing === undefined) {
    return { next: state, snapshot: { prevTitle: null } };
  }
  const cache = new Map(state.cache);
  cache.set(id, { ...existing, title: newTitle });
  return {
    next: { ...state, cache },
    snapshot: { prevTitle: existing.title },
  };
}

/**
 * Rollback for [`applyOptimisticRename`] — restores the previous title
 * value. No-op if the cache entry vanished in the meantime (e.g., the
 * row was deleted by a concurrent action).
 */
export function rollbackOptimisticRename(
  state: SidebarState,
  id: NoteId,
  snapshot: RenameSnapshot,
): SidebarState {
  const existing = state.cache.get(id);
  if (existing === undefined) return state;
  const cache = new Map(state.cache);
  cache.set(id, { ...existing, title: snapshot.prevTitle });
  return { ...state, cache };
}

export type TrashedFlagSnapshot = { prev: string | null };

/**
 * Optimistic trash/restore: set (`value` = RFC 3339 string) or clear
 * (`value` = null) the cache record's `trashed:` marker immediately, so the
 * row leaves the live tree (trash) or re-enters it (restore) before the IPC
 * resolves (MYND-133). No-op if the entry is not cached. Paired with
 * [`rollbackOptimisticTrashedFlag`] for IPC-failure recovery. Mirrors the
 * `applyOptimisticRename` snapshot idiom (prev-value capture, cache-lookup
 * rollback).
 */
export function applyOptimisticTrashedFlag(
  state: SidebarState,
  id: NoteId,
  value: string | null,
): { next: SidebarState; snapshot: TrashedFlagSnapshot } {
  const existing = state.cache.get(id);
  if (existing === undefined) {
    return { next: state, snapshot: { prev: null } };
  }
  const cache = new Map(state.cache);
  cache.set(id, { ...existing, trashed: value });
  return { next: { ...state, cache }, snapshot: { prev: existing.trashed } };
}

/**
 * Rollback for [`applyOptimisticTrashedFlag`] — restores the prior marker.
 * No-op if the cache entry vanished in the meantime (mirrors
 * `rollbackOptimisticRename`).
 */
export function rollbackOptimisticTrashedFlag(
  state: SidebarState,
  id: NoteId,
  snapshot: TrashedFlagSnapshot,
): SidebarState {
  const existing = state.cache.get(id);
  if (existing === undefined) return state;
  const cache = new Map(state.cache);
  cache.set(id, { ...existing, trashed: snapshot.prev });
  return { ...state, cache };
}

// ============================================================
// Multi-selection set transitions (MYND-367) — pure, testable without a
// renderer. None of these touch `selectedId`: the set is the bulk-operation
// surface, `selectedId` is the open-bridge surface, and they are deliberately
// orthogonal (see `SidebarState.selectedIds`).
// ============================================================

/**
 * Toggle `id`'s membership in the multi-selection set and make it the range
 * anchor. Returns a fresh `Set` (React shallow-equality) and leaves
 * `selectedId` untouched — cmd/ctrl-click adds/removes without opening.
 */
export function toggleInSelection(
  state: SidebarState,
  id: NoteId,
): SidebarState {
  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  return { ...state, selectedIds, anchorId: id };
}

/**
 * Replace the selection set with the contiguous range over `orderedIds` from
 * the current anchor (`anchorId ?? selectedId ?? targetId`) to `targetId`,
 * inclusive and direction-agnostic. The anchor is left untouched so successive
 * shift-clicks pivot on the same origin. If `targetId` isn't in `orderedIds`
 * the state is returned unchanged; if the anchor isn't found the result
 * degrades to a single-`targetId` selection. `selectedId` untouched.
 */
export function selectRange(
  state: SidebarState,
  orderedIds: readonly NoteId[],
  targetId: NoteId,
): SidebarState {
  const ti = orderedIds.indexOf(targetId);
  if (ti < 0) return state;
  const anchor = state.anchorId ?? state.selectedId ?? targetId;
  const ai = orderedIds.indexOf(anchor);
  const selectedIds = new Set<NoteId>();
  if (ai < 0) {
    selectedIds.add(targetId);
  } else {
    const lo = Math.min(ai, ti);
    const hi = Math.max(ai, ti);
    for (let i = lo; i <= hi; i++) selectedIds.add(orderedIds[i]!);
  }
  return { ...state, selectedIds };
}

/**
 * Replace the selection set wholesale; the anchor becomes the last id in
 * iteration order (or `null` when empty). `selectedId` untouched.
 */
export function replaceSelection(
  state: SidebarState,
  ids: Iterable<NoteId>,
): SidebarState {
  const selectedIds = new Set(ids);
  let last: NoteId | null = null;
  for (const id of selectedIds) last = id;
  return { ...state, selectedIds, anchorId: last };
}

/** Clear the multi-selection set + anchor. No-op (same reference) when already
 *  empty. `selectedId` untouched. */
export function clearMultiSelection(state: SidebarState): SidebarState {
  if (state.selectedIds.size === 0 && state.anchorId === null) return state;
  return { ...state, selectedIds: new Set(), anchorId: null };
}

/**
 * UUIDv7 first-48-bit unix-ms decoder. Per `protocol.md` §9.1 the
 * file name IS the UUIDv7; the leak of "approximate creation time"
 * is already accepted, so deriving a sort key + a display fallback
 * from it is free. Returns `null` for non-UUIDv7-shaped input or
 * epoch-zero results; sort callers map `null` to `0` via `?? 0`,
 * display callers (`<NoteRow>`) treat `null` as "no subtitle date".
 */
export function uuidv7Ms(id: NoteId): number | null {
  if (id.length !== 36) return null;
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32) return null;
  const ms = parseInt(hex.substring(0, 12), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Sort comparator for batch IDs in sidebar render order.
 *
 * When a manual `orderRank` map (note_id → index, derived from the
 * `note_order` prefs sequence) is supplied, it is the PRIMARY key: a note
 * listed in `note_order` sorts by its index; an unlisted note (newly created,
 * never reordered) sorts after all listed siblings. Within either group the
 * tiebreak is `updatedAt` descending, falling back to UUIDv7-derived creation
 * time descending. With no `orderRank` (or when neither note is listed) this
 * collapses to the original updatedAt-desc behavior. Per `decisions.md`
 * 2026-05-07 "User-meaningful timestamp storage path" sort key + 2026-05-15
 * MYND-82 grill Q1, extended with the manual-reorder primary key.
 */
/**
 * Build the `id → index` rank map a manual-order sequence (note_order /
 * folder_order) feeds into {@link sortBatchIds}'s `orderRank` (and the folder
 * comparator). First occurrence wins — defensive against accidental duplicates.
 */
export function buildRankMap<K extends string>(
  order: readonly K[],
): Map<K, number> {
  const m = new Map<K, number>();
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!;
    if (!m.has(k)) m.set(k, i);
  }
  return m;
}

export function sortBatchIds(
  ids: readonly NoteId[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
  orderRank?: ReadonlyMap<NoteId, number>,
): NoteId[] {
  return [...ids].sort((a, b) => {
    if (orderRank !== undefined) {
      const ra = orderRank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rb = orderRank.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
    }
    const recA = cache.get(a);
    const recB = cache.get(b);
    const ta = recA?.updatedAt?.getTime() ?? uuidv7Ms(a) ?? 0;
    const tb = recB?.updatedAt?.getTime() ?? uuidv7Ms(b) ?? 0;
    return tb - ta; // desc
  });
}

// ============================================================
// React Context + hook.
// ============================================================

export type UseSelectedNoteReturn = {
  selectedId: NoteId | null;
  /** Multi-selection set for bulk operations (MYND-367). See
   *  [`SidebarState.selectedIds`] — orthogonal to `selectedId`. */
  selectedIds: ReadonlySet<NoteId>;
  /** Range-selection pivot (MYND-367). */
  anchorId: NoteId | null;
  renamingId: NoteId | null;
  cache: ReadonlyMap<NoteId, TitleRecord>;
  /** Re-sync signal for the open note's body — see [`SidebarState.contentReloadNonce`]. */
  contentReloadNonce: number;
  /**
   * Force the currently-open note's editor body to re-read from disk by bumping
   * `contentReloadNonce`. Used when an action mutates the open note's `.myn`
   * out-of-band of the editor's own autosave — e.g. snapshot restore (MYND-97),
   * the same re-sync `commitRename` performs. No-op when nothing is selected.
   */
  reloadOpenNote: () => void;
  /** Update selection. Does NOT load editor content; caller orchestrates. */
  select: (id: NoteId | null) => void;
  /** Toggle `id` in the multi-selection set (cmd/ctrl-click). Does NOT open. */
  toggleInSelection: (id: NoteId) => void;
  /** Range-select from the anchor to `targetId` over `orderedIds` (shift-click). */
  selectRange: (orderedIds: readonly NoteId[], targetId: NoteId) => void;
  /** Clear the multi-selection set + anchor. */
  clearMultiSelection: () => void;
  /** Replace the multi-selection set wholesale. */
  replaceSelection: (ids: Iterable<NoteId>) => void;
  /** Select + emit a load-body intent (caller wires the editor). */
  open: (id: NoteId) => Promise<string>;
  /** Enter inline-rename mode for `id`. Caller renders the input. */
  startRename: (id: NoteId) => void;
  /** Leave inline-rename mode without committing. */
  cancelRename: () => void;
  /** Commit an inline rename → calls `renameNote` IPC + optimistic UI. */
  commitRename: (
    id: NoteId,
    currentBytes: string,
    newTitle: string,
  ) => Promise<void>;
  /** Create-from-scratch flow — calls `createNote` + auto-select + auto-rename. */
  createAndStartRename: (folder?: string | null) => Promise<NoteId>;
  /**
   * Duplicate `sourceId` in place (MYND-332) — clones the `.myn` via
   * `duplicateNote`, registers + caches the copy, and selects it (the Editor
   * bridge opens the selection). No rename: the copy already carries its
   * "(kopya)" title. Returns the new copy's id.
   */
  duplicateAndOpen: (sourceId: NoteId) => Promise<NoteId>;
  /** Delete a note with optimistic remove + rollback on IPC failure. */
  deleteWithRollback: (id: NoteId) => Promise<void>;
  /** Move a note to the trash (optimistic `trashed:` set + rollback). MYND-133. */
  trashWithRollback: (id: NoteId) => Promise<void>;
  /** Restore a note from the trash (optimistic `trashed:` clear + rollback). */
  restoreWithRollback: (id: NoteId) => Promise<void>;
  /** Permanently delete every id (empty trash); drops purged ids from the cache. */
  emptyTrashWithSync: (ids: readonly NoteId[]) => Promise<EmptyTrashResult>;
  /** Soft-trash every id at once (e.g. a non-empty folder delete); optimistic + rollback. */
  bulkTrashWithSync: (ids: readonly NoteId[]) => Promise<BulkTrashResult>;
  /** Move every id to `folder` (or root) at once (MYND-367 bulk move); best-effort
   *  via `bulkMoveNotes`, then surgical refresh of the movers. */
  bulkMoveWithSync: (
    ids: readonly NoteId[],
    folder: string | null,
  ) => Promise<BulkMoveResult>;
  /** Surgical refresh: re-fetch a single note's title slice. */
  refreshOne: (id: NoteId) => Promise<void>;
  /** Initial-boot full refresh: load `note_list` + chunked title batch. */
  refreshAll: (allIds: readonly NoteId[]) => Promise<void>;
};

const SidebarStateContext = createContext<UseSelectedNoteReturn | null>(null);

/**
 * Provider mounts inside the Editor screen (above the LeftSidebar /
 * CenterPane / RightSidebar tree). Owns the `useState<SidebarState>`
 * slot + the IPC orchestration callbacks (memoized via `useCallback`).
 */
export function SidebarStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidebarState>(EMPTY_SIDEBAR_STATE);
  // Always-current snapshot of `state` for synchronous reads inside async
  // callbacks (e.g. `commitRename` must read the PRE-rename cache before the
  // optimistic `setState` updater is flushed). Updated on every render.
  const stateRef = useRef(state);
  stateRef.current = state;

  const select = useCallback((id: NoteId | null) => {
    setState((prev) => ({ ...prev, selectedId: id }));
  }, []);

  // Multi-selection set actions (MYND-367) — thin wrappers over the pure
  // helpers. Named `*Action` here to avoid shadowing the module-level helpers;
  // re-exposed under the helper names in the context value.
  const toggleInSelectionAction = useCallback((id: NoteId) => {
    setState((prev) => toggleInSelection(prev, id));
  }, []);
  const selectRangeAction = useCallback(
    (orderedIds: readonly NoteId[], targetId: NoteId) => {
      setState((prev) => selectRange(prev, orderedIds, targetId));
    },
    [],
  );
  const clearMultiSelectionAction = useCallback(() => {
    setState((prev) => clearMultiSelection(prev));
  }, []);
  const replaceSelectionAction = useCallback((ids: Iterable<NoteId>) => {
    setState((prev) => replaceSelection(prev, ids));
  }, []);

  const open = useCallback(
    async (id: NoteId): Promise<string> => {
      setState((prev) => ({ ...prev, selectedId: id }));
      return await noteRead(id);
    },
    [],
  );

  const startRename = useCallback((id: NoteId) => {
    setState((prev) => ({ ...prev, renamingId: id }));
  }, []);

  const cancelRename = useCallback(() => {
    setState((prev) => ({ ...prev, renamingId: null }));
  }, []);

  const refreshOne = useCallback(async (id: NoteId) => {
    const [record] = await loadNoteBatch([id]);
    if (record !== undefined) {
      setState((prev) => applyCacheUpdate(prev, id, record));
    }
  }, []);

  const refreshAll = useCallback(
    async (allIds: readonly NoteId[]) => {
      const records = await loadNoteBatch([...allIds]);
      setState((prev) => {
        const cache = new Map(prev.cache);
        for (const r of records) {
          cache.set(r.noteUuid, r);
        }
        return { ...prev, cache };
      });
      // MYND-31 + MYND-271 Task 8: unlock sweep with the MYI1 fast path —
      // hydrate the persisted vault.indices blob (the host populates unchanged
      // notes + returns only the stale ids), then re-index just those. A cold /
      // undecodable blob falls back to a full rebuild. Best-effort +
      // fire-and-forget so it never blocks the sidebar boot; the index is a
      // rebuildable cache.
      void hydrateVaultIndicesOnUnlock(records.map((r) => r.noteUuid));
    },
    [],
  );

  const commitRename = useCallback(
    async (id: NoteId, currentBytes: string, newTitle: string) => {
      // Capture the PRE-rename title + resolver note-set SYNCHRONOUSLY from the
      // state ref, BEFORE the optimistic mutation: inbound `[[Old Title]]`
      // links must resolve against the note-set where this note still carries
      // its old title (else nothing resolves to it and no inbound rewrite is
      // planned). The ref read is reliable here — the `setState` updater below
      // may not have flushed by the time the `try` block reads these (MYND-85 /
      // WL-7).
      const preCache = stateRef.current.cache;
      const oldTitle: string | null = preCache.get(id)?.title ?? null;
      const preNotes = resolverNotesFromCache(preCache);
      let snapshot: RenameSnapshot = { prevTitle: null };
      setState((prev) => {
        const result = applyOptimisticRename(prev, id, newTitle);
        snapshot = result.snapshot;
        return { ...result.next, renamingId: null };
      });
      try {
        // §8.3 transactional rename auto-update: the renamed note's new body
        // (title surgery) PLUS every inbound `[[…]]`-bearing note rewrite are
        // committed all-or-nothing — a partial commit would leave an
        // un-rewritten `[[Old Title]]` resolving to nothing. WL-8 open-dirty
        // pre-flight (inside `planRenameBatch`) flushes panes before reading
        // so an open+dirty inbound note is never disk-clobbered (SYNC-15).
        const plan = await planRenameBatch(
          // `renameFlushHooks()` already yields `{ openNoteIds, flushOpenPanes }`,
          // the exact surface `defaultRenameInboundDeps` consumes.
          defaultRenameInboundDeps(renameFlushHooks()),
          {
            renamedNoteId: id,
            oldTitle,
            newTitle,
            renamedNewBody: renamedTitleBody(currentBytes, newTitle),
            preNotes,
          },
        );
        await noteWriteBatchTransactional(plan.batch);
        // Refresh in the background to pull the canonical title + updatedAt
        // from the backend (defensive — the optimistic title matches what we
        // just wrote, but updatedAt only refreshes after the round-trip).
        await refreshOne(id);
        // MYND-31: the renamed note's title-key changed AND every inbound
        // note's wikilink edges changed → re-index all of them so backlink /
        // graph resolution tracks the new state (live).
        void reindexNote(id);
        for (const inboundId of plan.inboundIds) void reindexNote(inboundId);
        // If we just renamed the OPEN note, its on-disk body now carries
        // the new title but the editor's local content (and the autosave
        // writer's view of it) is stale — a subsequent autosave would
        // overwrite the title back out. Signal the Editor to re-read.
        setState((prev) =>
          prev.selectedId === id
            ? { ...prev, contentReloadNonce: prev.contentReloadNonce + 1 }
            : prev,
        );
      } catch (err) {
        setState((prev) => rollbackOptimisticRename(prev, id, snapshot));
        throw err;
      }
    },
    [refreshOne],
  );

  const createAndStartRename = useCallback(
    async (folder: string | null = null): Promise<NoteId> => {
      const newId = await createNote(folder);
      // MYND-31: register the new note in the index (live).
      void reindexNote(newId);
      setState((prev) => {
        const seeded = applyOptimisticCreate(prev, newId);
        return { ...seeded, selectedId: newId, renamingId: newId };
      });
      // A foldered create writes `folder:` at create (a2); settle it into the
      // cache so the new row appears under its folder while still in rename mode.
      if (folder !== null) void refreshOne(newId);
      return newId;
    },
    [refreshOne],
  );

  const duplicateAndOpen = useCallback(
    async (sourceId: NoteId): Promise<NoteId> => {
      // Clone first — a read/write failure rejects here, before any optimistic
      // cache mutation, so a failed duplicate leaves the tree untouched (no
      // rollback needed). Same ordering as `createAndStartRename`.
      const newId = await duplicateNote(sourceId);
      // MYND-31: register the copy in the index (live).
      void reindexNote(newId);
      setState((prev) => {
        const seeded = applyOptimisticCreate(prev, newId);
        // Select (no rename) → the Editor selection-bridge opens the copy in
        // the focused pane. The copy already carries its "(kopya)" title.
        return { ...seeded, selectedId: newId };
      });
      // Unlike a blank new note, the copy carries create-time frontmatter
      // (title + any folder:); settle the real title slice into the cache.
      await refreshOne(newId);
      return newId;
    },
    [refreshOne],
  );

  const deleteWithRollback = useCallback(async (id: NoteId) => {
    let snapshot: DeleteSnapshot = { record: null, wasSelected: false };
    setState((prev) => {
      const result = applyOptimisticDelete(prev, id);
      snapshot = result.snapshot;
      return result.next;
    });
    try {
      await deleteNote(id);
      // MYND-31: drop the hard-deleted note from the index (live; trash
      // does NOT route here — trashed notes stay indexed, filtered TS-side).
      void vaultIndicesRemove(id);
    } catch (err) {
      setState((prev) => rollbackOptimisticDelete(prev, id, snapshot));
      throw err;
    }
  }, []);

  // Move a note to the trash: optimistically set its `trashed:` marker (the
  // row leaves the live tree at once), call `trashNote`, then refresh to the
  // canonical timestamp. Rollback restores the prior marker on IPC failure.
  const trashWithRollback = useCallback(
    async (id: NoteId) => {
      const iso = new Date().toISOString();
      let snapshot: TrashedFlagSnapshot = { prev: null };
      setState((prev) => {
        const result = applyOptimisticTrashedFlag(prev, id, iso);
        snapshot = result.snapshot;
        return result.next;
      });
      try {
        await trashNote(id);
        await refreshOne(id);
      } catch (err) {
        setState((prev) => rollbackOptimisticTrashedFlag(prev, id, snapshot));
        throw err;
      }
    },
    [refreshOne],
  );

  // Restore a note from the trash: optimistically clear `trashed:` (the row
  // re-enters the live tree), call `restoreNote`, then refresh. Rollback
  // re-applies the marker on IPC failure. Backs both the undo toast and the
  // Trash panel's Restore action.
  const restoreWithRollback = useCallback(
    async (id: NoteId) => {
      let snapshot: TrashedFlagSnapshot = { prev: null };
      setState((prev) => {
        const result = applyOptimisticTrashedFlag(prev, id, null);
        snapshot = result.snapshot;
        return result.next;
      });
      try {
        await restoreNote(id);
        await refreshOne(id);
      } catch (err) {
        setState((prev) => rollbackOptimisticTrashedFlag(prev, id, snapshot));
        throw err;
      }
    },
    [refreshOne],
  );

  // Permanently delete every id in `ids` (empty trash). Best-effort
  // (`emptyTrash` never rejects); the purged ids are dropped from the cache so
  // the Trash panel + count update. Returns the result for remaining-count UX.
  const emptyTrashWithSync = useCallback(
    async (ids: readonly NoteId[]): Promise<EmptyTrashResult> => {
      const result = await emptyTrash([...ids]);
      if (result.purged.length > 0) {
        const purged = new Set(result.purged);
        setState((prev) => {
          const cache = new Map(prev.cache);
          for (const id of purged) cache.delete(id);
          return { ...prev, cache };
        });
        // MYND-31: drop every purged note from the index (live).
        for (const id of result.purged) void vaultIndicesRemove(id);
      }
      return result;
    },
    [],
  );

  // Soft-trash every id in `ids` (a non-empty folder delete). Optimistically
  // marks all rows trashed (they leave the live tree at once), trashes them
  // best-effort via `bulkTrashNotes`, refreshes the survivors to their canonical
  // on-disk timestamps, and rolls back any that failed. Batched twin of
  // `trashWithRollback` with `emptyTrashWithSync`'s cache-sync posture.
  const bulkTrashWithSync = useCallback(
    async (ids: readonly NoteId[]): Promise<BulkTrashResult> => {
      if (ids.length === 0) return { trashed: [], failed: [] };
      const iso = new Date().toISOString();
      const snapshots = new Map<NoteId, TrashedFlagSnapshot>();
      setState((prev) => {
        let next = prev;
        for (const id of ids) {
          const result = applyOptimisticTrashedFlag(next, id, iso);
          snapshots.set(id, result.snapshot);
          next = result.next;
        }
        return next;
      });
      const result = await bulkTrashNotes([...ids]);
      // Roll back the failures to their prior marker (the optimistic flag was
      // wrong for those); the successes get refreshed to the canonical stamp.
      if (result.failed.length > 0) {
        setState((prev) => {
          let next = prev;
          for (const { noteId } of result.failed) {
            const snap = snapshots.get(noteId);
            if (snap !== undefined) {
              next = rollbackOptimisticTrashedFlag(next, noteId, snap);
            }
          }
          return next;
        });
      }
      await Promise.allSettled(result.trashed.map((id) => refreshOne(id)));
      return result;
    },
    [refreshOne],
  );

  // Move every id to `folder` (or root) at once (MYND-367 bulk move). Best-
  // effort via `bulkMoveNotes` (folder-move is not correctness-critical, Q4) —
  // no optimistic pre-write is needed (a move only relocates rows within the
  // tree, it doesn't make them vanish like trash), so we just refresh the
  // movers to their canonical post-move slice. Twin of `bulkTrashWithSync`.
  const bulkMoveWithSync = useCallback(
    async (
      ids: readonly NoteId[],
      folder: string | null,
    ): Promise<BulkMoveResult> => {
      if (ids.length === 0) return { moved: [], failed: [] };
      const result = await bulkMoveNotes([...ids], folder);
      await Promise.allSettled(result.moved.map((id) => refreshOne(id)));
      return result;
    },
    [refreshOne],
  );

  // MYND-97: re-read the open note's body after an out-of-band mutation
  // (snapshot restore overwrites the `.myn` via the backend, not the editor's
  // autosave). Mirrors the re-sync `commitRename` performs after a rename.
  const reloadOpenNote = useCallback(() => {
    setState((prev) =>
      prev.selectedId === null
        ? prev
        : { ...prev, contentReloadNonce: prev.contentReloadNonce + 1 },
    );
  }, []);

  const value = useMemo<UseSelectedNoteReturn>(
    () => ({
      selectedId: state.selectedId,
      selectedIds: state.selectedIds,
      anchorId: state.anchorId,
      renamingId: state.renamingId,
      cache: state.cache,
      contentReloadNonce: state.contentReloadNonce,
      reloadOpenNote,
      select,
      toggleInSelection: toggleInSelectionAction,
      selectRange: selectRangeAction,
      clearMultiSelection: clearMultiSelectionAction,
      replaceSelection: replaceSelectionAction,
      open,
      startRename,
      cancelRename,
      commitRename,
      createAndStartRename,
      duplicateAndOpen,
      deleteWithRollback,
      trashWithRollback,
      restoreWithRollback,
      emptyTrashWithSync,
      bulkTrashWithSync,
      bulkMoveWithSync,
      refreshOne,
      refreshAll,
    }),
    [
      state,
      reloadOpenNote,
      select,
      toggleInSelectionAction,
      selectRangeAction,
      clearMultiSelectionAction,
      replaceSelectionAction,
      open,
      startRename,
      cancelRename,
      commitRename,
      createAndStartRename,
      duplicateAndOpen,
      deleteWithRollback,
      trashWithRollback,
      restoreWithRollback,
      emptyTrashWithSync,
      bulkTrashWithSync,
      bulkMoveWithSync,
      refreshOne,
      refreshAll,
    ],
  );

  return (
    <SidebarStateContext.Provider value={value}>
      {children}
    </SidebarStateContext.Provider>
  );
}

/** Throws when used outside [`SidebarStateProvider`]. */
export function useSelectedNote(): UseSelectedNoteReturn {
  const ctx = useContext(SidebarStateContext);
  if (ctx === null) {
    throw new Error("useSelectedNote must be used inside <SidebarStateProvider>");
  }
  return ctx;
}
