// `workspaceState` — pure, React-free model for the editor's multi-tab +
// split-pane workspace (MYND-166, Task 1; extended to heterogeneous
// note|view items by MYND-274 Saved Views #4 / SYNC-10).
//
// Mirrors the `sidebarState` pattern: the state-transition logic lives in
// pure exported functions so tests can exercise every transition without
// rendering a tree. The React Context wrapper + multi-buffer residency
// layer over this in later tasks (Task 2/3); this slice introduces NO
// React UI and NO Tauri/IPC calls — it is the data model only.
//
// **Tab items are tagged (MYND-274).** A pane's tab strip holds
// `WorkspaceItem`s — `{ kind: "note"; id } | { kind: "view"; id }` — not bare
// note ids, so a saved view opens as a first-class tab alongside notes. Every
// op takes/returns the tagged item; identity is structural (`sameItem` /
// `itemKey`), so a note and a view may share an id-string without collision.
// Note-only workspaces behave exactly as before.
//
// Invariants enforced by every transition (grill 2026-06-01,
// `myne-agents/sessions/grill/2026-06-01-editor-multi-tab-split-pane.md`):
//
//  - **≥1 leaf pane, always.** The last leaf can never be removed:
//    `closePane` is a no-op on the only leaf, and closing the last tab of
//    the only leaf leaves it *tabless* (the empty-editor-shell), not gone.
//  - **Global duplicate-forbid.** An item opens at most ONCE across the
//    whole workspace (by `(kind,id)`). Every "open" of an already-open item
//    degrades to a REVEAL — focus the pane + activate the tab that already
//    holds it — never a second instance. This is what keeps autosave to one
//    buffer per `.myn` (Task 2) and the persisted descriptor a clean
//    partition.
//  - **`focusedPaneId` always references an existing leaf.**

import type { NoteId } from "./sidebarState";

/** Opaque identifier for a pane (leaf or split node). */
export type PaneId = string;

/** A saved-view id (MYND-274). Distinct id-space from `NoteId` — the `kind`
 *  tag, not the id, discriminates a view tab from a note tab. */
export type ViewId = string;

/**
 * A tab item: either a note or a saved view (MYND-274 / SYNC-10). The `kind`
 * tag discriminates; the id alone does not (a note and a view may share an
 * id-string). Identity across the workspace is `(kind, id)`.
 */
export type WorkspaceItem =
  | { kind: "note"; id: NoteId }
  | { kind: "view"; id: ViewId };

/** Stable string key for an item — `"note:<id>"` / `"view:<id>"`. Used for
 *  set/equality comparisons over the heterogeneous tab strip. */
export function itemKey(item: WorkspaceItem): string {
  return `${item.kind}:${item.id}`;
}

/** Structural equality of two items (same `kind` AND `id`). */
export function sameItem(a: WorkspaceItem, b: WorkspaceItem): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Wrap a note id as a tab item — the convenience callers use at the boundary. */
export function noteItem(id: NoteId): WorkspaceItem {
  return { kind: "note", id };
}

/** Wrap a view id as a tab item. */
export function viewItem(id: ViewId): WorkspaceItem {
  return { kind: "view", id };
}

/** Inverse of [`itemKey`]: parse a `"note:<id>"` / `"view:<id>"` handle back to
 *  an item. An unrecognized prefix is treated as a note id (the legacy/default
 *  kind), so a bare or note-prefixed handle always yields a note item. */
export function parseItemKey(key: string): WorkspaceItem {
  if (key.startsWith("view:")) return { kind: "view", id: key.slice(5) };
  if (key.startsWith("note:")) return { kind: "note", id: key.slice(5) };
  return { kind: "note", id: key };
}

/**
 * A leaf pane: owns an ordered tab strip (`tabs`) and the currently
 * active tab within it (`activeTab`, `null` only when the strip is empty —
 * the empty-editor-shell case for the last pane).
 */
export type LeafPane = {
  kind: "leaf";
  id: PaneId;
  tabs: WorkspaceItem[];
  activeTab: WorkspaceItem | null;
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

/** The pane currently holding `item`, or `null` if it isn't open anywhere. */
export function findItemPane(
  state: WorkspaceState,
  item: WorkspaceItem,
): PaneId | null {
  for (const leaf of collectLeaves(state.root)) {
    if (leaf.tabs.some((t) => sameItem(t, item))) return leaf.id;
  }
  return null;
}

/** The focused leaf. Never `null` — `focusedPaneId` is an enforced invariant. */
export function focusedLeaf(state: WorkspaceState): LeafPane {
  return findLeaf(state.root, state.focusedPaneId)!;
}

/** The item the focused pane's readouts (status bar / word count) describe. */
export function activeItem(state: WorkspaceState): WorkspaceItem | null {
  return focusedLeaf(state).activeTab;
}

/**
 * Every open item across all panes — the eager-residency set (one buffer
 * is mounted per entry). The duplicate-forbid invariant guarantees no
 * repeats, so this is already a set in list form.
 */
export function allOpenItems(state: WorkspaceState): WorkspaceItem[] {
  return collectLeaves(state.root).flatMap((leaf) => leaf.tabs);
}

/**
 * The active-tab item of each leaf — the *visible* buffers (the ones that
 * additionally mount a live editor / view surface). Tabless panes contribute
 * nothing.
 */
export function visibleItems(state: WorkspaceState): WorkspaceItem[] {
  return collectLeaves(state.root)
    .map((leaf) => leaf.activeTab)
    .filter((n): n is WorkspaceItem => n !== null);
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
 * Focus the pane + activate the tab that already holds `item`. No-op if
 * the item isn't open. This is the degraded form every "open" of an
 * already-open item takes (global duplicate-forbid).
 */
export function reveal(state: WorkspaceState, item: WorkspaceItem): WorkspaceState {
  const paneId = findItemPane(state, item);
  if (paneId === null) return state;
  return {
    root: updateLeaf(state.root, paneId, (leaf) => ({
      ...leaf,
      activeTab: item,
    })),
    focusedPaneId: paneId,
  };
}

/**
 * Sidebar-click behavior: open `item` in the focused pane's *active*
 * tab, reusing that slot (the previous item leaves the strip). Already
 * open elsewhere → reveal. Empty focused pane → seed its first tab.
 */
export function openInFocusedTab(
  state: WorkspaceState,
  item: WorkspaceItem,
): WorkspaceState {
  if (findItemPane(state, item) !== null) return reveal(state, item);
  return {
    ...state,
    root: updateLeaf(state.root, state.focusedPaneId, (leaf) => {
      if (leaf.activeTab === null) {
        return { ...leaf, tabs: [item], activeTab: item };
      }
      const idx = leaf.tabs.findIndex((t) => sameItem(t, leaf.activeTab!));
      const tabs = [...leaf.tabs];
      tabs[idx] = item; // reuse the active slot in place
      return { ...leaf, tabs, activeTab: item };
    }),
  };
}

/**
 * Explicit "Open in new tab": append `item` to the focused pane and
 * activate it. Already open elsewhere → reveal (never duplicates).
 */
export function openInNewTab(
  state: WorkspaceState,
  item: WorkspaceItem,
): WorkspaceState {
  if (findItemPane(state, item) !== null) return reveal(state, item);
  return {
    ...state,
    root: updateLeaf(state.root, state.focusedPaneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, item],
      activeTab: item,
    })),
  };
}

/**
 * Explicit "Open to the side": split the focused pane (row) into a new
 * leaf holding `item`, and focus it. Already open elsewhere → reveal
 * (no new pane — single-instance wins over the split intent).
 */
export function openToSide(
  state: WorkspaceState,
  item: WorkspaceItem,
  newId: IdFactory,
): WorkspaceState {
  if (findItemPane(state, item) !== null) return reveal(state, item);
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [item],
    activeTab: item,
  };
  return {
    root: splitLeaf(state.root, state.focusedPaneId, "row", newLeaf, newSplitId),
    focusedPaneId: newLeafId,
  };
}

/**
 * Split `paneId` along `direction` into a fresh *empty* leaf (the user
 * then opens an item into it), and focus the new leaf. The empty pane —
 * not a duplicated item — is deliberate: duplicates are forbidden, so a
 * split can't clone the source the way VS Code does.
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
 * Drop `item` onto `toPaneId`'s tab strip at `toIndex`. If the item is
 * already open somewhere this is a move / reorder (delegates to
 * {@link moveTab}); otherwise — a sidebar-origin drop of a not-yet-open
 * item — it is inserted into the target pane and activated. Focus follows
 * to the target. No-op if `toPaneId` isn't a leaf.
 */
export function dropItemOnPane(
  state: WorkspaceState,
  toPaneId: PaneId,
  item: WorkspaceItem,
  toIndex: number,
): WorkspaceState {
  const to = findLeaf(state.root, toPaneId);
  if (to === null) return state;
  const fromPaneId = findItemPane(state, item);
  if (fromPaneId !== null) {
    return moveTab(state, fromPaneId, toPaneId, item, toIndex);
  }
  const idx = Math.max(0, Math.min(toIndex, to.tabs.length));
  const tabs = [...to.tabs.slice(0, idx), item, ...to.tabs.slice(idx)];
  return {
    root: updateLeaf(state.root, toPaneId, (l) => ({
      ...l,
      tabs,
      activeTab: item,
    })),
    focusedPaneId: toPaneId,
  };
}

/**
 * Drag-to-split: split `targetPaneId` along `direction`, placing `item`
 * in a fresh leaf on `side` (`"before"` = left/top, `"after"` = right/
 * bottom), and focus that new leaf. Move semantics — if the item is open
 * elsewhere it leaves that pane first (duplicate-forbid), collapsing an
 * emptied source. No-op when the item is already the target pane's sole
 * tab (nothing to split out) or the target isn't a leaf.
 */
export function splitPaneWithItem(
  state: WorkspaceState,
  targetPaneId: PaneId,
  direction: SplitDirection,
  side: "before" | "after",
  item: WorkspaceItem,
  newId: IdFactory,
): WorkspaceState {
  const target = findLeaf(state.root, targetPaneId);
  if (target === null) return state;
  const fromPaneId = findItemPane(state, item);
  // Degenerate: dragging a pane's only tab onto its own edge — there is
  // nothing to split out (it would have to be in two places, which the
  // duplicate-forbid invariant rejects).
  if (fromPaneId === targetPaneId && target.tabs.length <= 1) return state;

  // 1. Detach the item from its current pane (if open). `closeTab`
  //    collapses an emptied non-last source; the degenerate guard above
  //    ensures the target itself survives this removal.
  let s = state;
  if (fromPaneId !== null) {
    s = closeTab(s, fromPaneId, item);
  }
  // 2. The target must still exist (it had other tabs, or wasn't the source).
  if (findLeaf(s.root, targetPaneId) === null) return state;

  // 3. Split the target with a fresh leaf holding the item.
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [item],
    activeTab: item,
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

/** Activate `item` within `paneId` (no-op if that pane doesn't hold it). */
export function setActiveTab(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
): WorkspaceState {
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) =>
      leaf.tabs.some((t) => sameItem(t, item))
        ? { ...leaf, activeTab: item }
        : leaf,
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
 * Close `item`'s tab in `paneId`. A surviving tab inherits focus
 * (right neighbor, else left). When the strip empties: the only pane
 * stays tabless (empty-editor-shell); any other pane is removed and the
 * tree collapses, relocating focus if it lived there.
 */
export function closeTab(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
): WorkspaceState {
  const leaf = findLeaf(state.root, paneId);
  if (leaf === null || !leaf.tabs.some((t) => sameItem(t, item))) return state;

  const tabs = leaf.tabs.filter((t) => !sameItem(t, item));

  if (tabs.length > 0) {
    let activeTab = leaf.activeTab;
    if (activeTab !== null && sameItem(activeTab, item)) {
      const idx = leaf.tabs.findIndex((t) => sameItem(t, item));
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
 * Move `item` from `fromPaneId` to `toPaneId`, inserting at `toIndex`
 * and activating it there. Same-pane move = reorder within the strip.
 * Cross-pane move that empties the source removes the source pane (the
 * "drag the last tab out closes that pane" rule) and collapses the tree.
 * No-op if either pane / the item is missing. The item is never
 * duplicated — it leaves the source as it enters the target.
 */
export function moveTab(
  state: WorkspaceState,
  fromPaneId: PaneId,
  toPaneId: PaneId,
  item: WorkspaceItem,
  toIndex: number,
): WorkspaceState {
  const from = findLeaf(state.root, fromPaneId);
  const to = findLeaf(state.root, toPaneId);
  if (from === null || to === null || !from.tabs.some((t) => sameItem(t, item)))
    return state;

  if (fromPaneId === toPaneId) {
    const without = from.tabs.filter((t) => !sameItem(t, item));
    const idx = Math.max(0, Math.min(toIndex, without.length));
    const tabs = [...without.slice(0, idx), item, ...without.slice(idx)];
    return {
      ...state,
      root: updateLeaf(state.root, fromPaneId, (l) => ({
        ...l,
        tabs,
        activeTab: item,
      })),
    };
  }

  const removedIdx = from.tabs.findIndex((t) => sameItem(t, item));
  const fromTabs = from.tabs.filter((t) => !sameItem(t, item));
  const fromActive =
    from.activeTab !== null && sameItem(from.activeTab, item)
      ? (from.tabs[removedIdx + 1] ??
        from.tabs[removedIdx - 1] ??
        fromTabs[0] ??
        null)
      : from.activeTab;
  const idx = Math.max(0, Math.min(toIndex, to.tabs.length));
  const toTabs = [...to.tabs.slice(0, idx), item, ...to.tabs.slice(idx)];

  let root = updateLeaf(state.root, toPaneId, (l) => ({
    ...l,
    tabs: toTabs,
    activeTab: item,
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
