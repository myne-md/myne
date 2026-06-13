// `workspaceContext` — React Context wrapping the pure `workspaceState`
// model (MYND-166). Holds the pane tree + focused pane in a `useState`
// slot and exposes bound operations to the editor chrome, pane views, tab
// strips, and sidebar.
//
// Multi-pane (Task 4): the editor renders one live editor per leaf pane
// (`<PaneView>`), each owning its own content + autosave. Cross-pane
// concerns that the per-pane views can't own alone live here:
//  - the focused-pane pointer (drives the bottom bar's readouts),
//  - a flush registry so the chrome's lock / close / blur hooks can flush
//    EVERY pane's pending save, not just one.
//
// The structural tree ops (split / close-pane / open-to-side, the
// ≥1-leaf invariant, duplicate-forbid reveal) are the pure, unit-tested
// functions from `workspaceState`; this Context only binds them to the
// `useState` slot + a `crypto.randomUUID` id factory.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NoteId } from "./sidebarState";
import {
  allOpenNotes,
  closePane as closePaneOp,
  closeTab as closeTabOp,
  collectLeaves,
  dropNoteOnPane as dropNoteOnPaneOp,
  emptyWorkspace,
  focusedLeaf,
  openInFocusedTab,
  openInNewTab,
  openToSide as openToSideOp,
  setActiveTab,
  setFocusedPane,
  splitPane,
  splitPaneWithNote as splitPaneWithNoteOp,
  type LeafPane,
  type PaneId,
  type SplitDirection,
  type WorkspaceNode,
  type WorkspaceState,
} from "./workspaceState";
import {
  clearRenameFlushHooks,
  registerRenameFlushHooks,
} from "./renameFlushHook";

function newPaneId(): PaneId {
  return crypto.randomUUID();
}

export type WorkspaceApi = {
  root: WorkspaceNode;
  focusedPaneId: PaneId;
  /** All leaves, left-to-right (render order). */
  leaves: LeafPane[];
  /** The focused leaf (drives the bottom bar's readouts). */
  focusedLeaf: LeafPane;

  // ── selection / open (always into the focused pane) ────────────
  /** Open in the focused pane's active tab (reuse) — or, if that pane has a
   *  pending "new tab", append into it; reveal if already open. */
  openInFocused: (id: NoteId) => void;
  /** Open in a NEW tab in the focused pane; reveal if open. */
  openNewTabInFocused: (id: NoteId) => void;
  /** Split the focused pane and open the note to the side; reveal if open. */
  openToSide: (id: NoteId) => void;

  // ── empty "new tab" chooser ────────────────────────────────────
  /** The pane currently showing the empty new-tab chooser, or `null`. */
  pendingNewTabPaneId: PaneId | null;
  /** Open an empty "new tab" (chooser) in `paneId` and focus it. */
  beginNewTab: (paneId: PaneId) => void;
  /** Dismiss the empty new-tab chooser. */
  cancelNewTab: () => void;

  /** Replace the whole workspace (used to restore a persisted session). */
  restore: (state: WorkspaceState) => void;

  // ── pane structure ─────────────────────────────────────────────
  /** Split the focused pane into a fresh empty pane and focus it. */
  splitFocused: (direction: SplitDirection) => void;
  /** Close a pane (no-op on the only leaf). */
  closePane: (paneId: PaneId) => void;
  /** Move focus to a pane. */
  focusPane: (paneId: PaneId) => void;

  // ── per-pane tab ops ───────────────────────────────────────────
  activateInPane: (paneId: PaneId, id: NoteId) => void;
  closeTabInPane: (paneId: PaneId, id: NoteId) => void;
  /** Drop a note onto a pane's tab strip (tab drag OR sidebar drag): an
   *  already-open note moves/reorders, a fresh one is inserted + activated. */
  dropNoteOnPane: (toPaneId: PaneId, id: NoteId, toIndex: number) => void;
  /** Drag-to-split: split `targetPaneId` along `direction` with `id` in a
   *  new leaf on `side` ("before" = left/top, "after" = right/bottom). */
  splitPaneWithNote: (
    targetPaneId: PaneId,
    direction: SplitDirection,
    side: "before" | "after",
    id: NoteId,
  ) => void;

  // ── flush registry (one entry per live pane editor) ────────────
  registerFlush: (paneId: PaneId, flush: () => Promise<void>) => void;
  unregisterFlush: (paneId: PaneId) => void;
  /** Flush every registered pane editor's pending save (lock / close). */
  flushAll: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspaceState>(() =>
    emptyWorkspace(newPaneId()),
  );

  // Which pane (if any) is showing the empty "new tab" chooser (MYND-166).
  // Lifted here — NOT PaneView-local — so a sidebar click (which routes
  // through `openInFocused`) APPENDS into the pending new tab instead of
  // replacing the previously-active tab. Mirrored into a ref so the open ops
  // can read it synchronously inside their `setState` updaters.
  const [pendingNewTabPaneId, setPendingNewTabPaneIdState] =
    useState<PaneId | null>(null);
  const pendingRef = useRef<PaneId | null>(null);
  const setPending = useCallback((v: PaneId | null) => {
    pendingRef.current = v;
    setPendingNewTabPaneIdState(v);
  }, []);

  const openInFocused = useCallback(
    (id: NoteId) => {
      const wasPending = pendingRef.current;
      setPending(null);
      setState((s) =>
        wasPending !== null && wasPending === s.focusedPaneId
          ? openInNewTab(s, id) // pending "new tab" → append, don't replace
          : openInFocusedTab(s, id),
      );
    },
    [setPending],
  );
  const openNewTabInFocused = useCallback(
    (id: NoteId) => {
      setPending(null);
      setState((s) => openInNewTab(s, id));
    },
    [setPending],
  );
  const openToSide = useCallback(
    (id: NoteId) => {
      setPending(null);
      setState((s) => openToSideOp(s, id, newPaneId));
    },
    [setPending],
  );
  const splitFocused = useCallback((direction: SplitDirection) => {
    setState((s) => splitPane(s, s.focusedPaneId, direction, newPaneId));
  }, []);
  const closePane = useCallback((paneId: PaneId) => {
    setState((s) => closePaneOp(s, paneId));
  }, []);
  const focusPane = useCallback(
    (paneId: PaneId) => {
      setPending(null);
      setState((s) => setFocusedPane(s, paneId));
    },
    [setPending],
  );
  const restore = useCallback((next: WorkspaceState) => {
    setState(next);
  }, []);
  const activateInPane = useCallback(
    (paneId: PaneId, id: NoteId) => {
      setPending(null);
      setState((s) => setFocusedPane(setActiveTab(s, paneId, id), paneId));
    },
    [setPending],
  );
  const closeTabInPane = useCallback(
    (paneId: PaneId, id: NoteId) => {
      setPending(null);
      setState((s) => closeTabOp(s, paneId, id));
    },
    [setPending],
  );
  // Begin an empty "new tab" in `paneId` (focuses it + shows the chooser).
  const beginNewTab = useCallback(
    (paneId: PaneId) => {
      setState((s) => setFocusedPane(s, paneId));
      setPending(paneId);
    },
    [setPending],
  );
  const cancelNewTab = useCallback(() => setPending(null), [setPending]);
  const dropNoteOnPane = useCallback(
    (toPaneId: PaneId, id: NoteId, toIndex: number) => {
      setState((s) => dropNoteOnPaneOp(s, toPaneId, id, toIndex));
    },
    [],
  );
  const splitPaneWithNote = useCallback(
    (
      targetPaneId: PaneId,
      direction: SplitDirection,
      side: "before" | "after",
      id: NoteId,
    ) => {
      setState((s) =>
        splitPaneWithNoteOp(s, targetPaneId, direction, side, id, newPaneId),
      );
    },
    [],
  );

  // Flush registry — refs (no re-render). Keyed by paneId.
  const flushers = useRef<Map<PaneId, () => Promise<void>>>(new Map());
  const registerFlush = useCallback(
    (paneId: PaneId, flush: () => Promise<void>) => {
      flushers.current.set(paneId, flush);
    },
    [],
  );
  const unregisterFlush = useCallback((paneId: PaneId) => {
    flushers.current.delete(paneId);
  }, []);
  const flushAll = useCallback(async () => {
    await Promise.all(
      [...flushers.current.values()].map((f) =>
        f().catch(() => {
          /* per-flush error already routed through that pane's saveStatus */
        }),
      ),
    );
  }, []);

  // WL-8 rename auto-update seam: expose the open-note set + flush-all to the
  // rename orchestrator, which runs in `SidebarStateProvider` (mounted ABOVE
  // this provider, so it can't read this context directly). `stateRef` keeps
  // the registered `openNoteIds` closure reading the latest pane tree without
  // re-registering on every state change; `flushAll` is stable.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    registerRenameFlushHooks({
      openNoteIds: () => new Set(allOpenNotes(stateRef.current)),
      flushOpenPanes: flushAll,
    });
    return () => clearRenameFlushHooks();
  }, [flushAll]);

  const leaves = collectLeaves(state.root);
  const focused = focusedLeaf(state);
  const api = useMemo<WorkspaceApi>(
    () => ({
      root: state.root,
      focusedPaneId: state.focusedPaneId,
      leaves,
      focusedLeaf: focused,
      openInFocused,
      openNewTabInFocused,
      openToSide,
      pendingNewTabPaneId,
      beginNewTab,
      cancelNewTab,
      restore,
      splitFocused,
      closePane,
      focusPane,
      activateInPane,
      closeTabInPane,
      dropNoteOnPane,
      splitPaneWithNote,
      registerFlush,
      unregisterFlush,
      flushAll,
    }),
    [
      state,
      leaves,
      focused,
      openInFocused,
      openNewTabInFocused,
      openToSide,
      pendingNewTabPaneId,
      beginNewTab,
      cancelNewTab,
      restore,
      splitFocused,
      closePane,
      focusPane,
      activateInPane,
      closeTabInPane,
      dropNoteOnPane,
      splitPaneWithNote,
      registerFlush,
      unregisterFlush,
      flushAll,
    ],
  );

  return (
    <WorkspaceContext.Provider value={api}>{children}</WorkspaceContext.Provider>
  );
}

/** Throws when used outside [`WorkspaceProvider`]. */
export function useWorkspace(): WorkspaceApi {
  const ctx = useContext(WorkspaceContext);
  if (ctx === null) {
    throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  }
  return ctx;
}
