// `workspaceState` — pure, React-free model for the editor's multi-tab +
// split-pane workspace (MYND-166, Task 1).
//
// Mirrors the `sidebarState` pattern: the state-transition logic lives in
// pure exported functions so tests can exercise every transition without
// rendering a tree. The React Context wrapper + multi-buffer residency
// layer over this in later tasks (Task 2/3); this slice introduces NO
// React UI and NO Tauri/IPC calls — it is the data model only.
//
// Invariants enforced by every transition (grill 2026-06-01,
// `agent-tooling/sessions/grill/2026-06-01-editor-multi-tab-split-pane.md`):
//
//  - **≥1 leaf pane, always.** The last leaf can never be removed:
//    `closePane` is a no-op on the only leaf, and closing the last tab of
//    the only leaf leaves it *tabless* (the empty-editor-shell), not gone.
//  - **Global duplicate-forbid.** A note opens at most ONCE across the
//    whole workspace. Every "open" of an already-open note degrades to a
//    REVEAL — focus the pane + activate the tab that already holds it —
//    never a second instance. This is what keeps autosave to one buffer
//    per `.myn` (Task 2) and the persisted descriptor a clean partition.
//  - **`focusedPaneId` always references an existing leaf.**

import type { NoteId } from "./sidebarState";

/** Opaque identifier for a pane (leaf or split node). */
export type PaneId = string;

/**
 * A leaf pane: owns an ordered tab strip (`tabs`) and the currently
 * active tab within it (`activeTab`, `null` only when the strip is empty —
 * the empty-editor-shell case for the last pane).
 */
export type LeafPane = {
  kind: "leaf";
  id: PaneId;
  tabs: NoteId[];
  activeTab: NoteId | null;
};

/**
 * Split direction. `row` = children laid out left-to-right (a *vertical*
 * divider between them); `column` = children stacked top-to-bottom (a
 * *horizontal* divider). Matches CSS flex-direction semantics so the
 * later layout code reads naturally.
 */
export type SplitDirection = "row" | "column";

/** An internal split node: ≥2 children laid out along `direction`. */
export type SplitNode = {
  kind: "split";
  id: PaneId;
  direction: SplitDirection;
  children: WorkspaceNode[];
};

export type WorkspaceNode = LeafPane | SplitNode;

export type WorkspaceState = {
  root: WorkspaceNode;
  /** Always a leaf id; readouts (status bar / word count) follow it. */
  focusedPaneId: PaneId;
};

/** Caller-supplied pane-id factory (the Context wires `crypto.randomUUID`). */
export type IdFactory = () => PaneId;

// ============================================================
// Construction + read helpers (pure).
// ============================================================

/** A fresh workspace: one empty, focused leaf. */
export function emptyWorkspace(rootPaneId: PaneId): WorkspaceState {
  return {
    root: { kind: "leaf", id: rootPaneId, tabs: [], activeTab: null },
    focusedPaneId: rootPaneId,
  };
}

/** All leaf panes in tree (left-to-right, depth-first) order. */
export function collectLeaves(node: WorkspaceNode): LeafPane[] {
  return node.kind === "leaf"
    ? [node]
    : node.children.flatMap(collectLeaves);
}

/** The leaf with `paneId`, or `null` if it isn't a leaf / doesn't exist. */
export function findLeaf(node: WorkspaceNode, paneId: PaneId): LeafPane | null {
  if (node.kind === "leaf") return node.id === paneId ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, paneId);
    if (found !== null) return found;
  }
  return null;
}

/** Id of the first leaf in tree order (used to relocate focus after a removal). */
export function firstLeafId(node: WorkspaceNode): PaneId {
  return node.kind === "leaf" ? node.id : firstLeafId(node.children[0]!);
}

/** The pane currently holding `noteId`, or `null` if it isn't open anywhere. */
export function findNotePane(state: WorkspaceState, noteId: NoteId): PaneId | null {
  for (const leaf of collectLeaves(state.root)) {
    if (leaf.tabs.includes(noteId)) return leaf.id;
  }
  return null;
}

/** The focused leaf. Never `null` — `focusedPaneId` is an enforced invariant. */
export function focusedLeaf(state: WorkspaceState): LeafPane {
  return findLeaf(state.root, state.focusedPaneId)!;
}

/** The note the focused pane's readouts (status bar / word count) describe. */
export function activeNote(state: WorkspaceState): NoteId | null {
  return focusedLeaf(state).activeTab;
}

/**
 * Every open note across all panes — the eager-residency set (one buffer
 * is mounted per entry). The duplicate-forbid invariant guarantees no
 * repeats, so this is already a set in list form.
 */
export function allOpenNotes(state: WorkspaceState): NoteId[] {
  return collectLeaves(state.root).flatMap((leaf) => leaf.tabs);
}

/**
 * The active-tab note of each leaf — the *visible* buffers (the ones that
 * additionally mount a live editor surface). Tabless panes contribute
 * nothing.
 */
export function visibleNotes(state: WorkspaceState): NoteId[] {
  return collectLeaves(state.root)
    .map((leaf) => leaf.activeTab)
    .filter((n): n is NoteId => n !== null);
}

// ============================================================
// Internal immutable tree edits.
// ============================================================

/** Replace the matching leaf in place (same structure, new tab/active state). */
function updateLeaf(
  node: WorkspaceNode,
  paneId: PaneId,
  updater: (leaf: LeafPane) => LeafPane,
): WorkspaceNode {
  if (node.kind === "leaf") {
    return node.id === paneId ? updater(node) : node;
  }
  return {
    ...node,
    children: node.children.map((c) => updateLeaf(c, paneId, updater)),
  };
}

/**
 * Remove the matching leaf and collapse the tree: a split left with a
 * single child becomes that child; an empty subtree returns `null`.
 * Callers guarantee at least one leaf survives before invoking this.
 */
function removeLeaf(node: WorkspaceNode, paneId: PaneId): WorkspaceNode | null {
  if (node.kind === "leaf") return node.id === paneId ? null : node;
  const children = node.children
    .map((c) => removeLeaf(c, paneId))
    .filter((c): c is WorkspaceNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!; // collapse single-child split
  return { ...node, children };
}

/**
 * Insert `newLeaf` next to `paneId` along `direction`. When `paneId`'s
 * parent split already runs in `direction`, the new leaf is inserted as an
 * adjacent sibling (no redundant nesting); otherwise the target leaf is
 * wrapped in a fresh split node (id = `newSplitId`).
 */
function splitLeaf(
  node: WorkspaceNode,
  paneId: PaneId,
  direction: SplitDirection,
  newLeaf: LeafPane,
  newSplitId: PaneId,
): WorkspaceNode {
  if (node.kind === "leaf") {
    if (node.id !== paneId) return node;
    return { kind: "split", id: newSplitId, direction, children: [node, newLeaf] };
  }
  const idx = node.children.findIndex(
    (c) => c.kind === "leaf" && c.id === paneId,
  );
  if (idx >= 0 && node.direction === direction) {
    const children = [...node.children];
    children.splice(idx + 1, 0, newLeaf);
    return { ...node, children };
  }
  return {
    ...node,
    children: node.children.map((c) =>
      splitLeaf(c, paneId, direction, newLeaf, newSplitId),
    ),
  };
}

/**
 * Like {@link splitLeaf} but inserts `newLeaf` on a chosen `side` of
 * `paneId`: `"before"` puts it ahead of the target (left for a `row`, top
 * for a `column`); `"after"` puts it behind (right / bottom). Used by the
 * drag-to-split drop zones, where which edge the cursor lands on decides
 * the side.
 */
function splitLeafSide(
  node: WorkspaceNode,
  paneId: PaneId,
  direction: SplitDirection,
  side: "before" | "after",
  newLeaf: LeafPane,
  newSplitId: PaneId,
): WorkspaceNode {
  if (node.kind === "leaf") {
    if (node.id !== paneId) return node;
    const children = side === "before" ? [newLeaf, node] : [node, newLeaf];
    return { kind: "split", id: newSplitId, direction, children };
  }
  const idx = node.children.findIndex(
    (c) => c.kind === "leaf" && c.id === paneId,
  );
  if (idx >= 0 && node.direction === direction) {
    const children = [...node.children];
    children.splice(side === "before" ? idx : idx + 1, 0, newLeaf);
    return { ...node, children };
  }
  return {
    ...node,
    children: node.children.map((c) =>
      splitLeafSide(c, paneId, direction, side, newLeaf, newSplitId),
    ),
  };
}

// ============================================================
// Public transitions (pure: each returns a fresh WorkspaceState).
// ============================================================

/**
 * Focus the pane + activate the tab that already holds `noteId`. No-op if
 * the note isn't open. This is the degraded form every "open" of an
 * already-open note takes (global duplicate-forbid).
 */
export function reveal(state: WorkspaceState, noteId: NoteId): WorkspaceState {
  const paneId = findNotePane(state, noteId);
  if (paneId === null) return state;
  return {
    root: updateLeaf(state.root, paneId, (leaf) => ({
      ...leaf,
      activeTab: noteId,
    })),
    focusedPaneId: paneId,
  };
}

/**
 * Sidebar-click behavior: open `noteId` in the focused pane's *active*
 * tab, reusing that slot (the previous note leaves the strip). Already
 * open elsewhere → reveal. Empty focused pane → seed its first tab.
 */
export function openInFocusedTab(
  state: WorkspaceState,
  noteId: NoteId,
): WorkspaceState {
  if (findNotePane(state, noteId) !== null) return reveal(state, noteId);
  return {
    ...state,
    root: updateLeaf(state.root, state.focusedPaneId, (leaf) => {
      if (leaf.activeTab === null) {
        return { ...leaf, tabs: [noteId], activeTab: noteId };
      }
      const idx = leaf.tabs.indexOf(leaf.activeTab);
      const tabs = [...leaf.tabs];
      tabs[idx] = noteId; // reuse the active slot in place
      return { ...leaf, tabs, activeTab: noteId };
    }),
  };
}

/**
 * Explicit "Open in new tab": append `noteId` to the focused pane and
 * activate it. Already open elsewhere → reveal (never duplicates).
 */
export function openInNewTab(
  state: WorkspaceState,
  noteId: NoteId,
): WorkspaceState {
  if (findNotePane(state, noteId) !== null) return reveal(state, noteId);
  return {
    ...state,
    root: updateLeaf(state.root, state.focusedPaneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, noteId],
      activeTab: noteId,
    })),
  };
}

/**
 * Explicit "Open to the side": split the focused pane (row) into a new
 * leaf holding `noteId`, and focus it. Already open elsewhere → reveal
 * (no new pane — single-instance wins over the split intent).
 */
export function openToSide(
  state: WorkspaceState,
  noteId: NoteId,
  newId: IdFactory,
): WorkspaceState {
  if (findNotePane(state, noteId) !== null) return reveal(state, noteId);
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [noteId],
    activeTab: noteId,
  };
  return {
    root: splitLeaf(state.root, state.focusedPaneId, "row", newLeaf, newSplitId),
    focusedPaneId: newLeafId,
  };
}

/**
 * Split `paneId` along `direction` into a fresh *empty* leaf (the user
 * then opens a note into it), and focus the new leaf. The empty pane —
 * not a duplicated note — is deliberate: duplicates are forbidden, so a
 * split can't clone the source note the way VS Code does.
 */
export function splitPane(
  state: WorkspaceState,
  paneId: PaneId,
  direction: SplitDirection,
  newId: IdFactory,
): WorkspaceState {
  if (findLeaf(state.root, paneId) === null) return state;
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [],
    activeTab: null,
  };
  return {
    root: splitLeaf(state.root, paneId, direction, newLeaf, newSplitId),
    focusedPaneId: newLeafId,
  };
}

/**
 * Drop `noteId` onto `toPaneId`'s tab strip at `toIndex`. If the note is
 * already open somewhere this is a move / reorder (delegates to
 * {@link moveTab}); otherwise — a sidebar-origin drop of a not-yet-open
 * note — it is inserted into the target pane and activated. Focus follows
 * to the target. No-op if `toPaneId` isn't a leaf.
 */
export function dropNoteOnPane(
  state: WorkspaceState,
  toPaneId: PaneId,
  noteId: NoteId,
  toIndex: number,
): WorkspaceState {
  const to = findLeaf(state.root, toPaneId);
  if (to === null) return state;
  const fromPaneId = findNotePane(state, noteId);
  if (fromPaneId !== null) {
    return moveTab(state, fromPaneId, toPaneId, noteId, toIndex);
  }
  const idx = Math.max(0, Math.min(toIndex, to.tabs.length));
  const tabs = [...to.tabs.slice(0, idx), noteId, ...to.tabs.slice(idx)];
  return {
    root: updateLeaf(state.root, toPaneId, (l) => ({
      ...l,
      tabs,
      activeTab: noteId,
    })),
    focusedPaneId: toPaneId,
  };
}

/**
 * Drag-to-split: split `targetPaneId` along `direction`, placing `noteId`
 * in a fresh leaf on `side` (`"before"` = left/top, `"after"` = right/
 * bottom), and focus that new leaf. Move semantics — if the note is open
 * elsewhere it leaves that pane first (duplicate-forbid), collapsing an
 * emptied source. No-op when the note is already the target pane's sole
 * tab (nothing to split out) or the target isn't a leaf.
 */
export function splitPaneWithNote(
  state: WorkspaceState,
  targetPaneId: PaneId,
  direction: SplitDirection,
  side: "before" | "after",
  noteId: NoteId,
  newId: IdFactory,
): WorkspaceState {
  const target = findLeaf(state.root, targetPaneId);
  if (target === null) return state;
  const fromPaneId = findNotePane(state, noteId);
  // Degenerate: dragging a pane's only tab onto its own edge — there is
  // nothing to split out (it would have to be in two places, which the
  // duplicate-forbid invariant rejects).
  if (fromPaneId === targetPaneId && target.tabs.length <= 1) return state;

  // 1. Detach the note from its current pane (if open). `closeTab`
  //    collapses an emptied non-last source; the degenerate guard above
  //    ensures the target itself survives this removal.
  let s = state;
  if (fromPaneId !== null) {
    s = closeTab(s, fromPaneId, noteId);
  }
  // 2. The target must still exist (it had other tabs, or wasn't the source).
  if (findLeaf(s.root, targetPaneId) === null) return state;

  // 3. Split the target with a fresh leaf holding the note.
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [noteId],
    activeTab: noteId,
  };
  return {
    root: splitLeafSide(
      s.root,
      targetPaneId,
      direction,
      side,
      newLeaf,
      newSplitId,
    ),
    focusedPaneId: newLeafId,
  };
}

/** Activate `noteId` within `paneId` (no-op if that pane doesn't hold it). */
export function setActiveTab(
  state: WorkspaceState,
  paneId: PaneId,
  noteId: NoteId,
): WorkspaceState {
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) =>
      leaf.tabs.includes(noteId) ? { ...leaf, activeTab: noteId } : leaf,
    ),
  };
}

/** Move focus to `paneId` (no-op if it isn't an existing leaf). */
export function setFocusedPane(
  state: WorkspaceState,
  paneId: PaneId,
): WorkspaceState {
  return findLeaf(state.root, paneId) !== null
    ? { ...state, focusedPaneId: paneId }
    : state;
}

/**
 * Close `noteId`'s tab in `paneId`. A surviving tab inherits focus
 * (right neighbor, else left). When the strip empties: the only pane
 * stays tabless (empty-editor-shell); any other pane is removed and the
 * tree collapses, relocating focus if it lived there.
 */
export function closeTab(
  state: WorkspaceState,
  paneId: PaneId,
  noteId: NoteId,
): WorkspaceState {
  const leaf = findLeaf(state.root, paneId);
  if (leaf === null || !leaf.tabs.includes(noteId)) return state;

  const tabs = leaf.tabs.filter((t) => t !== noteId);

  if (tabs.length > 0) {
    let activeTab = leaf.activeTab;
    if (activeTab === noteId) {
      const idx = leaf.tabs.indexOf(noteId);
      activeTab = leaf.tabs[idx + 1] ?? leaf.tabs[idx - 1] ?? tabs[0]!;
    }
    return {
      ...state,
      root: updateLeaf(state.root, paneId, (l) => ({ ...l, tabs, activeTab })),
    };
  }

  // Strip is now empty.
  if (collectLeaves(state.root).length <= 1) {
    // Last pane: keep it, tabless.
    return {
      ...state,
      root: updateLeaf(state.root, paneId, (l) => ({
        ...l,
        tabs: [],
        activeTab: null,
      })),
    };
  }

  // Not the last pane: remove it and collapse the tree.
  const root = removeLeaf(state.root, paneId)!;
  const focusedPaneId =
    state.focusedPaneId === paneId ? firstLeafId(root) : state.focusedPaneId;
  return { root, focusedPaneId };
}

/**
 * Move `noteId` from `fromPaneId` to `toPaneId`, inserting at `toIndex`
 * and activating it there. Same-pane move = reorder within the strip.
 * Cross-pane move that empties the source removes the source pane (the
 * "drag the last tab out closes that pane" rule) and collapses the tree.
 * No-op if either pane / the note is missing. The note is never
 * duplicated — it leaves the source as it enters the target.
 */
export function moveTab(
  state: WorkspaceState,
  fromPaneId: PaneId,
  toPaneId: PaneId,
  noteId: NoteId,
  toIndex: number,
): WorkspaceState {
  const from = findLeaf(state.root, fromPaneId);
  const to = findLeaf(state.root, toPaneId);
  if (from === null || to === null || !from.tabs.includes(noteId)) return state;

  if (fromPaneId === toPaneId) {
    const without = from.tabs.filter((t) => t !== noteId);
    const idx = Math.max(0, Math.min(toIndex, without.length));
    const tabs = [...without.slice(0, idx), noteId, ...without.slice(idx)];
    return {
      ...state,
      root: updateLeaf(state.root, fromPaneId, (l) => ({
        ...l,
        tabs,
        activeTab: noteId,
      })),
    };
  }

  const removedIdx = from.tabs.indexOf(noteId);
  const fromTabs = from.tabs.filter((t) => t !== noteId);
  const fromActive =
    from.activeTab === noteId
      ? (from.tabs[removedIdx + 1] ??
        from.tabs[removedIdx - 1] ??
        fromTabs[0] ??
        null)
      : from.activeTab;
  const idx = Math.max(0, Math.min(toIndex, to.tabs.length));
  const toTabs = [...to.tabs.slice(0, idx), noteId, ...to.tabs.slice(idx)];

  let root = updateLeaf(state.root, toPaneId, (l) => ({
    ...l,
    tabs: toTabs,
    activeTab: noteId,
  }));
  if (fromTabs.length > 0) {
    root = updateLeaf(root, fromPaneId, (l) => ({
      ...l,
      tabs: fromTabs,
      activeTab: fromActive,
    }));
    return { root, focusedPaneId: toPaneId };
  }
  // Source emptied → remove it (≥2 leaves exist since to ≠ from).
  root = removeLeaf(root, fromPaneId)!;
  return { root, focusedPaneId: toPaneId };
}

/**
 * Close `paneId` outright, collapsing the tree. No-op when it's the only
 * leaf (the ≥1-leaf invariant). Focus relocates if it lived in the
 * removed pane.
 */
export function closePane(
  state: WorkspaceState,
  paneId: PaneId,
): WorkspaceState {
  if (collectLeaves(state.root).length <= 1) return state;
  const root = removeLeaf(state.root, paneId);
  if (root === null) return state;
  const focusedPaneId =
    findLeaf(root, state.focusedPaneId) !== null
      ? state.focusedPaneId
      : firstLeafId(root);
  return { root, focusedPaneId };
}
