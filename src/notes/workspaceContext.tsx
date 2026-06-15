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
  allOpenItems,
  closePane as closePaneOp,
  closeTab as closeTabOp,
  collectLeaves,
  dropItemOnPane as dropItemOnPaneOp,
  emptyWorkspace,
  focusedLeaf,
  noteItem,
  openInFocusedTab,
  openInNewTab,
  openToSide as openToSideOp,
  setActiveTab,
  setFocusedPane,
  splitPane,
  splitPaneWithItem as splitPaneWithItemOp,
  viewItem,
  type LeafPane,
  type PaneId,
  type SplitDirection,
  type ViewId,
  type WorkspaceItem,
  type WorkspaceNode,
  type WorkspaceState,
} from "./workspaceState";
import {
  clearRenameFlushHooks,
  registerRenameFlushHooks,
} from "./renameFlushHook";
import {
  canStepBack,
  canStepForward,
  reconcileHistories,
  type NavIntent,
  type PaneHistory,
} from "./paneHistory";

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

  // ── back/forward history (focused pane; ephemeral, never persisted) ──
  /** Step the focused pane back to the previously viewed note (no-op when
   *  there is no history in that direction). */
  goBack: () => void;
  /** Step the focused pane forward (re-navigate after a back). */
  goForward: () => void;
  /** Whether the focused pane has a previous note to step back to. */
  canGoBack: boolean;
  /** Whether the focused pane has a note to step forward to. */
  canGoForward: boolean;

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

  // ── saved-view (item) tab ops (MYND-274) ───────────────────────
  /** Open a saved view as a tab in the focused pane (reuse-active-slot, like
   *  `openInFocused`); reveal if already open. */
  openView: (viewId: ViewId) => void;
  /** Activate any tab item (note or view) within a pane. */
  activateItemInPane: (paneId: PaneId, item: WorkspaceItem) => void;
  /** Close any tab item (note or view) within a pane. */
  closeItemInPane: (paneId: PaneId, item: WorkspaceItem) => void;
  /** Drop any tab item onto a pane's tab strip (tab drag): move/reorder an
   *  already-open item, or insert + activate a fresh one. */
  dropItemOnPane: (toPaneId: PaneId, item: WorkspaceItem, toIndex: number) => void;
  /** Drag-to-split with any tab item (note or view). */
  splitPaneWithItem: (
    targetPaneId: PaneId,
    direction: SplitDirection,
    side: "before" | "after",
    item: WorkspaceItem,
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
          ? openInNewTab(s, noteItem(id)) // pending "new tab" → append, don't replace
          : openInFocusedTab(s, noteItem(id)),
      );
    },
    [setPending],
  );
  const openNewTabInFocused = useCallback(
    (id: NoteId) => {
      setPending(null);
      setState((s) => openInNewTab(s, noteItem(id)));
    },
    [setPending],
  );
  const openToSide = useCallback(
    (id: NoteId) => {
      setPending(null);
      setState((s) => openToSideOp(s, noteItem(id), newPaneId));
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
      setState((s) => setFocusedPane(setActiveTab(s, paneId, noteItem(id)), paneId));
    },
    [setPending],
  );
  const closeTabInPane = useCallback(
    (paneId: PaneId, id: NoteId) => {
      setPending(null);
      setState((s) => closeTabOp(s, paneId, noteItem(id)));
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
      setState((s) => dropItemOnPaneOp(s, toPaneId, noteItem(id), toIndex));
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
        splitPaneWithItemOp(s, targetPaneId, direction, side, noteItem(id), newPaneId),
      );
    },
    [],
  );

  // ── saved-view (item) tab ops (MYND-274) — operate on tagged items so a
  //    view tab is a first-class peer of a note tab. ───────────────────────
  const openView = useCallback(
    (viewId: ViewId) => {
      const wasPending = pendingRef.current;
      setPending(null);
      setState((s) =>
        wasPending !== null && wasPending === s.focusedPaneId
          ? openInNewTab(s, viewItem(viewId))
          : openInFocusedTab(s, viewItem(viewId)),
      );
    },
    [setPending],
  );
  const activateItemInPane = useCallback(
    (paneId: PaneId, item: WorkspaceItem) => {
      setPending(null);
      setState((s) => setFocusedPane(setActiveTab(s, paneId, item), paneId));
    },
    [setPending],
  );
  const closeItemInPane = useCallback(
    (paneId: PaneId, item: WorkspaceItem) => {
      setPending(null);
      setState((s) => closeTabOp(s, paneId, item));
    },
    [setPending],
  );
  const dropItemOnPane = useCallback(
    (toPaneId: PaneId, item: WorkspaceItem, toIndex: number) => {
      setState((s) => dropItemOnPaneOp(s, toPaneId, item, toIndex));
    },
    [],
  );
  const splitPaneWithItem = useCallback(
    (
      targetPaneId: PaneId,
      direction: SplitDirection,
      side: "before" | "after",
      item: WorkspaceItem,
    ) => {
      setState((s) =>
        splitPaneWithItemOp(s, targetPaneId, direction, side, item, newPaneId),
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
      openNoteIds: () =>
        new Set(
          allOpenItems(stateRef.current)
            .filter((i) => i.kind === "note")
            .map((i) => i.id),
        ),
      flushOpenPanes: flushAll,
    });
    return () => clearRenameFlushHooks();
  }, [flushAll]);

  // ── Back/forward navigation history (MYND-260) ─────────────────────
  // Per-pane, EPHEMERAL: held next to — never inside — the persisted pane
  // tree, so a browsing trail never lands in `vault.workspace` (design grill
  // 2026-06-01 Q1). A reconcile pass folds each pane's live `activeTab` into
  // its history on every workspace change; the `navIntentRef` lets a
  // back/forward step land as a cursor MOVE rather than a fresh visit.
  const [histories, setHistories] = useState<
    ReadonlyMap<PaneId, PaneHistory>
  >(() => new Map());
  const historiesRef = useRef(histories);
  historiesRef.current = histories;
  const navIntentRef = useRef<NavIntent>(null);

  useEffect(() => {
    const intent = navIntentRef.current;
    navIntentRef.current = null;
    setHistories((prev) =>
      reconcileHistories(prev, collectLeaves(state.root), intent),
    );
  }, [state]);

  // Step the FOCUSED pane along its history. The cursor target is re-activated
  // through the ordinary `openInFocusedTab` transition — which re-opens a note
  // that has since left the strip (the common sidebar-browse case) or reveals
  // one already open — so the content + sidebar selection follow for free.
  const stepHistory = useCallback((delta: -1 | 1) => {
    const paneId = stateRef.current.focusedPaneId;
    const h = historiesRef.current.get(paneId);
    if (h === undefined) return;
    const targetIndex = h.index + delta;
    if (targetIndex < 0 || targetIndex >= h.entries.length) return;
    const target = h.entries[targetIndex]!;
    navIntentRef.current = { paneId, targetIndex };
    setPending(null);
    setState((s) => openInFocusedTab(s, target));
  }, [setPending]);
  const goBack = useCallback(() => stepHistory(-1), [stepHistory]);
  const goForward = useCallback(() => stepHistory(1), [stepHistory]);

  const focusedHistory = histories.get(state.focusedPaneId);
  const canGoBack = canStepBack(focusedHistory);
  const canGoForward = canStepForward(focusedHistory);

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
      goBack,
      goForward,
      canGoBack,
      canGoForward,
      splitFocused,
      closePane,
      focusPane,
      activateInPane,
      closeTabInPane,
      dropNoteOnPane,
      splitPaneWithNote,
      openView,
      activateItemInPane,
      closeItemInPane,
      dropItemOnPane,
      splitPaneWithItem,
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
      goBack,
      goForward,
      canGoBack,
      canGoForward,
      splitFocused,
      closePane,
      focusPane,
      activateInPane,
      closeTabInPane,
      dropNoteOnPane,
      splitPaneWithNote,
      openView,
      activateItemInPane,
      closeItemInPane,
      dropItemOnPane,
      splitPaneWithItem,
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
