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
  useState,
  type ReactNode,
} from "react";
import { createNote } from "./createNote";
import { deleteNote } from "./deleteNote";
import {
  loadNoteBatch,
  type TitleRecord,
} from "./loadNoteBatch";
import { noteRead } from "./readNote";
import { renameNote } from "./renameNote";

export type NoteId = string;

export type SidebarState = {
  selectedId: NoteId | null;
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
  });
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
 * Sort comparator for batch IDs in sidebar render order: `updatedAt`
 * descending, falling back to UUIDv7-derived creation time descending.
 * Per `decisions.md` 2026-05-07 "User-meaningful timestamp storage path"
 * sort key + 2026-05-15 MYND-82 grill Q1.
 */
export function sortBatchIds(
  ids: readonly NoteId[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
): NoteId[] {
  return [...ids].sort((a, b) => {
    const ra = cache.get(a);
    const rb = cache.get(b);
    const ta = ra?.updatedAt?.getTime() ?? uuidv7Ms(a) ?? 0;
    const tb = rb?.updatedAt?.getTime() ?? uuidv7Ms(b) ?? 0;
    return tb - ta; // desc
  });
}

// ============================================================
// React Context + hook.
// ============================================================

export type UseSelectedNoteReturn = {
  selectedId: NoteId | null;
  renamingId: NoteId | null;
  cache: ReadonlyMap<NoteId, TitleRecord>;
  /** Re-sync signal for the open note's body — see [`SidebarState.contentReloadNonce`]. */
  contentReloadNonce: number;
  /** Update selection. Does NOT load editor content; caller orchestrates. */
  select: (id: NoteId | null) => void;
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
  /** Delete a note with optimistic remove + rollback on IPC failure. */
  deleteWithRollback: (id: NoteId) => Promise<void>;
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

  const select = useCallback((id: NoteId | null) => {
    setState((prev) => ({ ...prev, selectedId: id }));
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
    },
    [],
  );

  const commitRename = useCallback(
    async (id: NoteId, currentBytes: string, newTitle: string) => {
      let snapshot: RenameSnapshot = { prevTitle: null };
      setState((prev) => {
        const result = applyOptimisticRename(prev, id, newTitle);
        snapshot = result.snapshot;
        return { ...result.next, renamingId: null };
      });
      try {
        await renameNote(id, currentBytes, newTitle);
        // Refresh in the background to pull the canonical title +
        // updatedAt from the backend (defensive — the optimistic title
        // matches what we just wrote, but updatedAt only refreshes
        // after the round-trip).
        await refreshOne(id);
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

  const deleteWithRollback = useCallback(async (id: NoteId) => {
    let snapshot: DeleteSnapshot = { record: null, wasSelected: false };
    setState((prev) => {
      const result = applyOptimisticDelete(prev, id);
      snapshot = result.snapshot;
      return result.next;
    });
    try {
      await deleteNote(id);
    } catch (err) {
      setState((prev) => rollbackOptimisticDelete(prev, id, snapshot));
      throw err;
    }
  }, []);

  const value = useMemo<UseSelectedNoteReturn>(
    () => ({
      selectedId: state.selectedId,
      renamingId: state.renamingId,
      cache: state.cache,
      contentReloadNonce: state.contentReloadNonce,
      select,
      open,
      startRename,
      cancelRename,
      commitRename,
      createAndStartRename,
      deleteWithRollback,
      refreshOne,
      refreshAll,
    }),
    [
      state,
      select,
      open,
      startRename,
      cancelRename,
      commitRename,
      createAndStartRename,
      deleteWithRollback,
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
