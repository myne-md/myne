// `workspaceState` - pure, React-free model for the editor's multi-tab +
// split-pane workspace (MYND-166, Task 1; extended to heterogeneous
// note|view items by MYND-274 Saved Views #4 / SYNC-10).
//
// Mirrors the `sidebarState` pattern: the state-transition logic lives in
// pure exported functions so tests can exercise every transition without
// rendering a tree. The React Context wrapper + multi-buffer residency
// layer over this in later tasks (Task 2/3); this slice introduces NO
// React UI and NO Tauri/IPC calls - it is the data model only.
//
// **Tab items are tagged (MYND-274).** A pane's tab strip holds
// `WorkspaceItem`s - `{ kind: "note"; id } | { kind: "view"; id }` - not bare
// note ids, so a saved view opens as a first-class tab alongside notes. Every
// op takes/returns the tagged item; identity is structural (`sameItem` /
// `itemKey`), so a note and a view may share an id-string without collision.
// Note-only workspaces behave exactly as before.
//
// Invariants enforced by every transition (grill 2026-06-01,
// `agent-tooling/sessions/grill/2026-06-01-editor-multi-tab-split-pane.md`):
//
//  - **≥1 leaf pane, always.** The last leaf can never be removed:
//    `closePane` is a no-op on the only leaf, and closing the last tab of
//    the only leaf leaves it *tabless* (the empty-editor-shell), not gone.
//  - **Global duplicate-forbid.** An item opens at most ONCE across the
//    whole workspace (by `(kind,id)`). Every "open" of an already-open item
//    degrades to a REVEAL - focus the pane + activate the tab that already
//    holds it - never a second instance. This is what keeps autosave to one
//    buffer per `.myn` (Task 2) and the persisted descriptor a clean
//    partition.
//  - **`focusedPaneId` always references an existing leaf.**

import i18n from "../i18n";
import type { GraphSettings } from "./graphSettings";
import type { TaskDisplaySettings } from "./taskDisplay";
import type { NoteId } from "./sidebarState";
import {
  DEFAULT_TASK_VIEW,
  type TaskDueFilter,
  type TaskPriorityFilter,
  type TaskSort,
  type TaskStatusFilter,
  type TaskView,
} from "./taskView";
import type { DetachedEntry } from "./detachedRestore";
import {
  AGENT_TAB_ID,
  ATTACHMENTS_TAB_ID,
  GRAPH_TAB_ID,
  TASKS_TAB_ID,
  TEMPLATES_TAB_ID,
  TAB_KIND_TAGS,
  canonicalTabId,
} from "./tabKinds";

// The singleton sentinels are DECLARED in the tab-kind registry (myne-md/myne#773)
// and re-exported here, where every caller already imported them from. See the
// registry's own note: declaring them here made the two modules circular, and at
// init time every `singletonId` was `undefined`, so no persisted singleton id was
// ever normalized to its sentinel.
export {
  AGENT_TAB_ID,
  ATTACHMENTS_TAB_ID,
  GRAPH_TAB_ID,
  TASKS_TAB_ID,
  TEMPLATES_TAB_ID,
} from "./tabKinds";

/** Opaque identifier for a pane (leaf or split node). */
export type PaneId = string;

/** A saved-view id (MYND-274). Distinct id-space from `NoteId` - the `kind`
 *  tag, not the id, discriminates a view tab from a note tab. */
export type ViewId = string;

/** The whole-vault graph is a singleton tab: there is exactly one graph per
 *  workspace, so its id is a fixed sentinel (the global duplicate-forbid
 *  invariant then makes "open graph" idempotent - a reveal, never a 2nd tab).
 *  Declared in the tab-kind registry; see the re-export note above. */

/** The attachment library and the template library are singletons too, and
 *  they are declared in the tab-kind registry with the rest; see the re-export
 *  note above for why every one of them lives there. */

/**
 * Per-tab editor view mode (reading-source-modes / MYND-299): how the tab's
 * buffer renders. `"live"` is the default WYSIWYG editing surface; `"reading"`
 * is read-only with decorations fully rendered; `"source"` shows raw markdown
 * with decorations off. **Omit-when-default** - `undefined` / absent ≡ `"live"`.
 */
export type ViewMode = "live" | "reading" | "source";

/**
 * A tab item: a note, a saved view (MYND-274 / SYNC-10), or the whole-vault
 * graph. The `kind` tag discriminates; the id alone does not (a note and a view
 * may share an id-string). Identity across the workspace is `(kind, id)`.
 *
 * `pinned` is an Obsidian-style per-tab flag (tab-modes / MYND-320): a pinned
 * tab is close-protected, and navigating from it opens a NEW tab in the same
 * pane rather than replacing it. It is **omit-when-default** - `undefined` /
 * absent means unpinned. It is NOT part of identity: `itemKey` / `sameItem`
 * ignore it, so the global `(kind,id)` duplicate-forbid invariant is unaffected.
 *
 * `viewMode` is the per-tab render mode (reading-source-modes / MYND-299), also
 * **omit-when-default** (absent ≡ `"live"`) and not part of identity. It rides
 * the opaque descriptor with no MYW1 format change (MYND-299 task 2).
 */
export type WorkspaceItem =
  | { kind: "note"; id: NoteId; pinned?: boolean; viewMode?: ViewMode }
  | { kind: "view"; id: ViewId; pinned?: boolean; viewMode?: ViewMode }
  | { kind: "graph"; id: typeof GRAPH_TAB_ID; pinned?: boolean; viewMode?: ViewMode }
  /**
   * The vault-wide task list (MYND-616; the view fields redesigned for
   * myne-md/myne#656). `taskView` is **per-tab session state**, not a
   * preference: "which filter am I looking at" is where you are, and
   * preferences are for stated choices like theme and auto-lock. Carrying it
   * here also avoids the roughly thirteen-site preference registration surface.
   *
   * **Omit-when-default**, exactly like `pinned` and `viewMode`, so a tab left
   * on its defaults stays byte-identical to a pre-feature descriptor. The
   * descriptor is opaque to the storage codec - no format change.
   */
  /**
   * The attachment library (myne-md/myne#773). A singleton like the graph and
   * the task list, and carrying no per-tab state of its own: its sort, filter
   * and search are session state inside the component, which is the same
   * decision the graph made.
   */
  | {
      kind: "attachments";
      id: typeof ATTACHMENTS_TAB_ID;
      pinned?: boolean;
      viewMode?: ViewMode;
    }
  /** The note-template library (myne-md/myne#779). */
  | {
      kind: "templates";
      id: typeof TEMPLATES_TAB_ID;
      pinned?: boolean;
      viewMode?: ViewMode;
    }
  | {
      kind: "tasks";
      id: typeof TASKS_TAB_ID;
      pinned?: boolean;
      viewMode?: ViewMode;
      taskView?: PersistedTaskView;
    }
  /**
   * The agent hub (myne-md/myne#771). A singleton like the graph and the task
   * list. `agentView` is **per-tab session state** in the same sense
   * `taskView` is: whether the tab is showing the vault-wide Hub or one note's
   * Focus is where you are, not a preference. It carries the conversation it is
   * showing so a Focus tab survives a reload on the same note.
   *
   * **Omit-when-default**, so a Hub tab is byte-identical to a descriptor from
   * before this kind existed. The descriptor is opaque to the storage codec.
   */
  | {
      kind: "agent";
      id: typeof AGENT_TAB_ID;
      pinned?: boolean;
      viewMode?: ViewMode;
      agentView?: PersistedAgentView;
    };

/** The persisted delta of the agent tab's view (myne-md/myne#771). Absent means
 *  the Hub. Omitting a `focus` view with no note is the Hub by construction, so
 *  the object is absent entirely when the tab is on its default. */
export type PersistedAgentView = {
  view: "hub" | "focus";
  /** The note whose conversation Focus is showing, when `view` is `focus`. */
  noteId?: string;
  /** The conversation Focus is showing, when one is selected. */
  conversationId?: string;
};

/**
 * The persisted delta of a `TaskView`. Every key is omit-when-default, so the
 * object is absent entirely when the tab is on defaults.
 */
export type PersistedTaskView = {
  status?: TaskStatusFilter;
  due?: TaskDueFilter;
  noteId?: string;
  folders?: readonly string[];
  tags?: readonly string[];
  priority?: TaskPriorityFilter;
  sort?: TaskSort;
};

/** Stable string key for an item - `"note:<id>"` / `"view:<id>"`. Used for
 *  set/equality comparisons over the heterogeneous tab strip. Ignores `pinned`
 *  (identity is `(kind,id)` only). */
export function itemKey(item: WorkspaceItem): string {
  return `${item.kind}:${item.id}`;
}

/** Structural equality of two items (same `kind` AND `id`). Ignores `pinned` -
 *  identity is `(kind,id)`, so a pin flip never changes which tab an item is. */
export function sameItem(a: WorkspaceItem, b: WorkspaceItem): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Whether an item's tab is pinned (omit-when-default: absent ⇒ unpinned). */
export function isPinned(item: WorkspaceItem): boolean {
  return item.pinned === true;
}

/** An item's tab view mode (omit-when-default: absent ⇒ `"live"`). */
export function itemViewMode(item: WorkspaceItem): ViewMode {
  return item.viewMode ?? "live";
}

/** Wrap a note id as a tab item - the convenience callers use at the boundary. */
export function noteItem(id: NoteId): WorkspaceItem {
  return { kind: "note", id };
}

/** Wrap a view id as a tab item. */
export function viewItem(id: ViewId): WorkspaceItem {
  return { kind: "view", id };
}

/** The whole-vault graph tab item (singleton - see [`GRAPH_TAB_ID`]). */
export function graphItem(): WorkspaceItem {
  return { kind: "graph", id: GRAPH_TAB_ID };
}

/** The vault-wide task-list tab item (singleton - see [`TASKS_TAB_ID`]). */
export function tasksItem(): WorkspaceItem {
  return { kind: "tasks", id: TASKS_TAB_ID };
}

/** The attachment-library tab item (singleton - see [`ATTACHMENTS_TAB_ID`]). */
export function attachmentsItem(): WorkspaceItem {
  return { kind: "attachments", id: ATTACHMENTS_TAB_ID };
}

/** The template-library tab item (singleton - see [`TEMPLATES_TAB_ID`]). */
export function templatesItem(): WorkspaceItem {
  return { kind: "templates", id: TEMPLATES_TAB_ID };
}

/** The agent hub tab item (singleton - see [`AGENT_TAB_ID`]). */
export function agentItem(): WorkspaceItem {
  return { kind: "agent", id: AGENT_TAB_ID };
}

/** Inverse of [`itemKey`]: parse a `"note:<id>"` / `"view:<id>"` / `"graph:<id>"`
 *  handle back to an item. An unrecognized prefix is treated as a note id (the
 *  legacy/default kind), so a bare or note-prefixed handle always yields a note
 *  item. */
export function parseItemKey(key: string): WorkspaceItem {
  // Derived from the tab-kind registry (myne-md/myne#773) rather than an arm
  // per kind. A singleton normalizes to its sentinel whatever the key carried,
  // which is what keeps "graph:anything" resolving to the one graph tab.
  const colon = key.indexOf(":");
  if (colon > 0) {
    const tag = key.slice(0, colon) as WorkspaceItem["kind"];
    if ((TAB_KIND_TAGS as readonly string[]).includes(tag)) {
      return {
        kind: tag,
        id: canonicalTabId(tag, key.slice(colon + 1)),
      } as WorkspaceItem;
    }
  }
  // An unrecognized prefix — or a bare id — is the legacy/default `note` kind,
  // so a pre-prefix handle still opens the note it names.
  return { kind: "note", id: key };
}

/**
 * A leaf pane: owns an ordered tab strip (`tabs`) and the currently
 * active tab within it (`activeTab`, `null` only when the strip is empty -
 * the empty-editor-shell case for the last pane).
 *
 * `stacked` is the per-leaf-pane tab-layout flag (tab-modes / MYND-319): when
 * set, the pane renders its tabs as a horizontally-scrolling, partially-
 * overlapping deck instead of the normal strip. It is a per-LEAF flag so it
 * composes with the recursive split-pane tree (one pane stacked, another
 * normal). **Omit-when-default** - `undefined` / absent means not stacked.
 */
export type LeafPane = {
  kind: "leaf";
  id: PaneId;
  tabs: WorkspaceItem[];
  activeTab: WorkspaceItem | null;
  stacked?: boolean;
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

/** The focused leaf. Never `null` - `focusedPaneId` is an enforced invariant. */
export function focusedLeaf(state: WorkspaceState): LeafPane {
  return findLeaf(state.root, state.focusedPaneId)!;
}

/** The item the focused pane's readouts (status bar / word count) describe. */
export function activeItem(state: WorkspaceState): WorkspaceItem | null {
  return focusedLeaf(state).activeTab;
}

/**
 * Every open item across all panes - the eager-residency set (one buffer
 * is mounted per entry). The duplicate-forbid invariant guarantees no
 * repeats, so this is already a set in list form.
 */
export function allOpenItems(state: WorkspaceState): WorkspaceItem[] {
  return collectLeaves(state.root).flatMap((leaf) => leaf.tabs);
}

/**
 * The active-tab item of each leaf - the *visible* buffers (the ones that
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
      // Activate the STORED tab (preserving its `pinned` flag) rather than the
      // caller's item, which may be a bare `(kind,id)` handle with no flag.
      activeTab: leaf.tabs.find((t) => sameItem(t, item)) ?? item,
    })),
    focusedPaneId: paneId,
  };
}

/**
 * Sidebar-click behavior: open `item` in the focused pane's *active*
 * tab, reusing that slot (the previous item leaves the strip). Already
 * open elsewhere → reveal. Empty focused pane → seed its first tab.
 *
 * **Pin-aware (tab-modes / MYND-320, Obsidian-full):** when the focused
 * pane's active tab is PINNED, the reuse-the-active-slot path is suppressed -
 * the open APPENDS a new tab (like {@link openInNewTab}) so the pinned tab is
 * never replaced. A non-pinned active tab keeps the original reuse behavior.
 */
export function openInFocusedTab(
  state: WorkspaceState,
  item: WorkspaceItem,
): WorkspaceState {
  if (findItemPane(state, item) !== null) return reveal(state, item);
  const focused = findLeaf(state.root, state.focusedPaneId);
  // Pinned active tab → never reuse its slot; append a fresh tab instead.
  if (focused !== null && focused.activeTab !== null && isPinned(focused.activeTab)) {
    return openInNewTab(state, item);
  }
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
 * (no new pane - single-instance wins over the split intent).
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
 * then opens an item into it), and focus the new leaf. The empty pane -
 * not a duplicated item - is deliberate: duplicates are forbidden, so a
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
 * {@link moveTab}); otherwise - a sidebar-origin drop of a not-yet-open
 * item - it is inserted into the target pane and activated. Focus follows
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
 * bottom), and focus that new leaf. Move semantics - if the item is open
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
  // Degenerate: dragging a pane's only tab onto its own edge - there is
  // nothing to split out (it would have to be in two places, which the
  // duplicate-forbid invariant rejects).
  if (fromPaneId === targetPaneId && target.tabs.length <= 1) return state;

  // Carry the source tab's `pinned` flag onto the moved item (a pinned tab
  // stays pinned after a drag-to-split) - the caller's `item` may be a bare
  // `(kind,id)` handle with no flag.
  const moved: WorkspaceItem =
    fromPaneId !== null
      ? (findLeaf(state.root, fromPaneId)!.tabs.find((t) => sameItem(t, item)) ?? item)
      : item;

  // 1. Detach the item from its current pane (if open). `detachTab` (the
  //    unguarded form - a pinned tab relocates, it doesn't close) collapses an
  //    emptied non-last source; the degenerate guard above ensures the target
  //    itself survives this removal.
  let s = state;
  if (fromPaneId !== null) {
    s = detachTab(s, fromPaneId, item);
  }
  // 2. The target must still exist (it had other tabs, or wasn't the source).
  if (findLeaf(s.root, targetPaneId) === null) return state;

  // 3. Split the target with a fresh leaf holding the item.
  const newLeafId = newId();
  const newSplitId = newId();
  const newLeaf: LeafPane = {
    kind: "leaf",
    id: newLeafId,
    tabs: [moved],
    activeTab: moved,
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

/** Activate `item` within `paneId` (no-op if that pane doesn't hold it). The
 *  STORED tab is activated, so its `pinned` flag survives a bare-handle call. */
export function setActiveTab(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
): WorkspaceState {
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) => {
      const stored = leaf.tabs.find((t) => sameItem(t, item));
      return stored !== undefined ? { ...leaf, activeTab: stored } : leaf;
    }),
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
 * Set the `pinned` flag on `item`'s tab within `paneId` (tab-modes /
 * MYND-320). No-op if that pane doesn't hold the item. The flag is written
 * omit-when-default: pinning sets `pinned: true`; unpinning DROPS the key so
 * an unpinned tab serializes byte-identical to a pre-feature tab. Both the
 * `tabs` entry and `activeTab` (when it is this item) are kept in sync.
 */
export function setPinned(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
  pinned: boolean,
): WorkspaceState {
  const apply = (t: WorkspaceItem): WorkspaceItem => {
    if (pinned) return { ...t, pinned: true };
    // Unpin → drop the key entirely (omit-when-default discipline).
    const { pinned: _drop, ...rest } = t;
    return rest as WorkspaceItem;
  };
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) =>
      leaf.tabs.some((t) => sameItem(t, item))
        ? {
            ...leaf,
            tabs: leaf.tabs.map((t) => (sameItem(t, item) ? apply(t) : t)),
            activeTab:
              leaf.activeTab !== null && sameItem(leaf.activeTab, item)
                ? apply(leaf.activeTab)
                : leaf.activeTab,
          }
        : leaf,
    ),
  };
}

/**
 * Set the per-tab `viewMode` on `item`'s tab within `paneId` (reading-source-
 * modes / MYND-299). No-op if that pane doesn't hold the item. Mirrors
 * {@link setPinned}: the flag is written omit-when-default - setting `"reading"`
 * or `"source"` writes the key; setting `"live"` (the default) DROPS the key so
 * a default-mode tab serializes byte-identical to a pre-feature tab. Both the
 * `tabs` entry and `activeTab` (when it is this item) are kept in sync.
 */
export function setItemViewMode(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
  viewMode: ViewMode,
): WorkspaceState {
  const apply = (t: WorkspaceItem): WorkspaceItem => {
    if (viewMode !== "live") return { ...t, viewMode };
    // Default (`"live"`) → drop the key entirely (omit-when-default discipline).
    const { viewMode: _drop, ...rest } = t;
    return rest as WorkspaceItem;
  };
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) =>
      leaf.tabs.some((t) => sameItem(t, item))
        ? {
            ...leaf,
            tabs: leaf.tabs.map((t) => (sameItem(t, item) ? apply(t) : t)),
            activeTab:
              leaf.activeTab !== null && sameItem(leaf.activeTab, item)
                ? apply(leaf.activeTab)
                : leaf.activeTab,
          }
        : leaf,
    ),
  };
}

/**
 * Persist the task tab's filter and scope **with the tab** (MYND-616 task 9).
 *
 * Session state, not a preference: "which filter am I looking at" is where the
 * user is, and preferences are for stated choices like theme and auto-lock.
 * Storing it here also keeps it **per tab** rather than global, so two panes
 * showing task lists do not fight over one setting.
 *
 * Omit-when-default throughout: the default filter and an unset scope DROP their
 * keys, so a task tab left alone serializes byte-identical to one written before
 * this existed.
 */
export function setTaskViewState(
  state: WorkspaceState,
  paneId: PaneId,
  view: TaskView,
): WorkspaceState {
  const apply = (t: WorkspaceItem): WorkspaceItem => {
    if (t.kind !== "tasks") return t;
    const rest: Record<string, unknown> = { ...t };
    delete rest.taskView;
    const v = taskViewToPersisted(view);
    if (v !== undefined) rest.taskView = v;
    return rest as WorkspaceItem;
  };
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map(apply),
      activeTab: leaf.activeTab === null ? null : apply(leaf.activeTab),
    })),
  };
}

/** The persisted delta of a `TaskView`, or `undefined` when all-default. */
export function taskViewToPersisted(view: TaskView): PersistedTaskView | undefined {
  const v: PersistedTaskView = {};
  if (view.status !== DEFAULT_TASK_VIEW.status) v.status = view.status;
  if (view.due !== "any") v.due = view.due;
  if (view.noteId !== null) v.noteId = view.noteId;
  if (view.folders.length > 0) v.folders = [...view.folders];
  if (view.tags.length > 0) v.tags = [...view.tags];
  if (view.priority !== "any") v.priority = view.priority;
  if (view.sort !== "due") v.sort = view.sort;
  return Object.keys(v).length > 0 ? v : undefined;
}

/** Resolve a persisted view (or none) to a full `TaskView`. */
export function resolveTaskView(p: PersistedTaskView | undefined): TaskView {
  return {
    status: p?.status ?? DEFAULT_TASK_VIEW.status,
    due: p?.due ?? "any",
    noteId: p?.noteId ?? null,
    folders: p?.folders ?? [],
    tags: p?.tags ?? [],
    priority: p?.priority ?? "any",
    sort: p?.sort ?? "due",
  };
}

/** Read a task tab's persisted view back as a full `TaskView`. */
export function taskViewOf(item: WorkspaceItem): TaskView {
  if (item.kind !== "tasks") return DEFAULT_TASK_VIEW;
  return resolveTaskView(item.taskView);
}

/**
 * The agent tab's view as a live value (myne-md/myne#771). Absent means the
 * Hub, so the fallback is the default rather than an error.
 */
export function agentViewOf(item: WorkspaceItem): PersistedAgentView {
  if (item.kind !== "agent") return { view: "hub" };
  return item.agentView ?? { view: "hub" };
}

/**
 * Set the agent tab's view, omit-when-default (myne-md/myne#771): a Hub view
 * DROPS the key so an untouched agent tab serializes byte-identical to a
 * descriptor from before the kind existed. `undefined` returned from the
 * to-persisted helper is what triggers the drop.
 */
export function setAgentViewState(
  state: WorkspaceState,
  paneId: PaneId,
  view: PersistedAgentView,
): WorkspaceState {
  const apply = (t: WorkspaceItem): WorkspaceItem => {
    if (t.kind !== "agent") return t;
    const rest: Record<string, unknown> = { ...t };
    delete rest.agentView;
    const v = agentViewToPersisted(view);
    if (v !== undefined) rest.agentView = v;
    return rest as WorkspaceItem;
  };
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) => ({
      ...leaf,
      tabs: leaf.tabs.map(apply),
      activeTab: leaf.activeTab === null ? null : apply(leaf.activeTab),
    })),
  };
}

/** The persisted delta of an agent view, or `undefined` when it is the Hub (the
 *  default) or a Focus with no note (incoherent, so also the default). */
export function agentViewToPersisted(
  view: PersistedAgentView,
): PersistedAgentView | undefined {
  if (view.view !== "focus") return undefined;
  if (view.noteId === undefined || view.noteId === "") return undefined;
  const v: PersistedAgentView = { view: "focus", noteId: view.noteId };
  if (view.conversationId !== undefined && view.conversationId !== "") {
    v.conversationId = view.conversationId;
  }
  return v;
}

/**
 * Set the per-leaf `stacked` layout flag (tab-modes / MYND-319). No-op if
 * `paneId` isn't a leaf. Omit-when-default: turning stacked OFF DROPS the key
 * so a non-stacked pane serializes byte-identical to a pre-feature pane.
 */
export function setStacked(
  state: WorkspaceState,
  paneId: PaneId,
  stacked: boolean,
): WorkspaceState {
  return {
    ...state,
    root: updateLeaf(state.root, paneId, (leaf) => {
      if (stacked) return { ...leaf, stacked: true };
      const { stacked: _drop, ...rest } = leaf;
      return rest as LeafPane;
    }),
  };
}

/** Flip the per-leaf `stacked` flag (tab-modes / MYND-319). No-op off a leaf. */
export function toggleStacked(
  state: WorkspaceState,
  paneId: PaneId,
): WorkspaceState {
  const leaf = findLeaf(state.root, paneId);
  if (leaf === null) return state;
  return setStacked(state, paneId, leaf.stacked !== true);
}

/**
 * Close `item`'s tab in `paneId`. A surviving tab inherits focus
 * (right neighbor, else left). When the strip empties: the only pane
 * stays tabless (empty-editor-shell); any other pane is removed and the
 * tree collapses, relocating focus if it lived there.
 *
 * **Close-guarded (tab-modes / MYND-320):** a PINNED tab is not closed by the
 * normal close path - closing it is a no-op (the user must unpin first). This
 * is enforced against the flag stored in the strip, not the caller's `item`.
 */
export function closeTab(
  state: WorkspaceState,
  paneId: PaneId,
  item: WorkspaceItem,
): WorkspaceState {
  const leaf = findLeaf(state.root, paneId);
  if (leaf === null || !leaf.tabs.some((t) => sameItem(t, item))) return state;
  // Close-guard: a pinned tab can't be closed via this user-facing path (unpin
  // first). Internal detach during a move/split uses `detachTab` (no guard) -
  // a pinned tab still drags to another pane / splits; it just can't be CLOSED.
  const stored = leaf.tabs.find((t) => sameItem(t, item));
  if (stored !== undefined && isPinned(stored)) return state;
  return detachTab(state, paneId, item);
}

/**
 * Remove `item`'s tab from `paneId` with the same focus/collapse rules as
 * {@link closeTab} but WITHOUT the pinned close-guard. Internal: the detach
 * step of a tab move / drag-to-split, where a pinned tab relocates rather than
 * closes (its pin flag rides along with the moved item).
 */
function detachTab(
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
 * duplicated - it leaves the source as it enters the target.
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

  // Move the STORED tab (preserving its `pinned` flag) - the caller's `item`
  // may be a bare `(kind,id)` handle. A pinned tab stays pinned after a move.
  const moved = from.tabs.find((t) => sameItem(t, item)) ?? item;

  if (fromPaneId === toPaneId) {
    const without = from.tabs.filter((t) => !sameItem(t, item));
    const idx = Math.max(0, Math.min(toIndex, without.length));
    const tabs = [...without.slice(0, idx), moved, ...without.slice(idx)];
    return {
      ...state,
      root: updateLeaf(state.root, fromPaneId, (l) => ({
        ...l,
        tabs,
        activeTab: moved,
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
  const toTabs = [...to.tabs.slice(0, idx), moved, ...to.tabs.slice(idx)];

  let root = updateLeaf(state.root, toPaneId, (l) => ({
    ...l,
    tabs: toTabs,
    activeTab: moved,
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

// ============================================================
// Named workspaces - N slots over the per-slot descriptor (MYND-308 task 2).
//
// Backward-compat by construction: each slot's `state` is an ordinary
// `WorkspaceState`, so every existing reducer/selector above keeps operating on
// the ACTIVE slot's descriptor unchanged. The container is a NEW layer; no
// existing consumer is forced to change. The container rides the MYW1 0x02
// opaque blob (the inner descriptor sealed under `session_state_key`); no Rust
// parsing - Rust only ticks the format version (MYND-308 task 1).
// ============================================================

/** Stable slot identifier (a uuid-like string; the app wires
 *  `crypto.randomUUID`, tests inject a deterministic factory). */
export type SlotId = string;

/** One named workspace: a stable id, a user-facing name, and its layout. */
export type WorkspaceSlot = {
  id: SlotId;
  name: string;
  state: WorkspaceState;
};

/** The container: N named slots + a pointer to the active one. Existing
 *  reducers operate on `slots[activeId].state` via {@link activeSlotState}. */
export type NamedWorkspaces = {
  slots: WorkspaceSlot[];
  activeId: SlotId;
  /** Sidebar file-tree folder-expand state (MYND-455) - the folded keys of
   *  OPEN folders. Window-global (one set for the sidebar, not per-slot), so it
   *  lives at the container level. Omit-when-empty on serialize (no format
   *  bump). Container ops spread `{...c}`, so it survives switch/save/rename;
   *  `emptyNamedWorkspaces` omits it (a fresh vault opens collapsed). */
  expandedFolders?: readonly string[];
  /** Graph pane settings (graph-connection-ux-polish task 5) - the physics +
   *  appearance controls behind the graph pane's gear. Device-local, window-
   *  global (one set for the graph, not per-slot) like `expandedFolders`.
   *  Omit-when-default (see `graphSettings.ts`); a fresh container leaves it
   *  unset. */
  graphSettings?: GraphSettings;
  /** Open detached (pop-out) note windows to restore on the next launch
   *  (myne#678 task 6, SYNC-10): each a note id + its last PHYSICAL geometry.
   *  Device-local and window-global like `expandedFolders`; omit-when-empty on
   *  serialize (no format bump: a pre-feature reader tolerates the unknown
   *  field, a fresh container has none). Restored clamped onto a currently-
   *  connected display (`planDetachedRestore`). */
  detached?: readonly DetachedEntry[];
  /** Task-surface display (myne-md/myne#656 item 4) - device-local, window-
   *  global (one chip-colour choice across every task surface) like
   *  `graphSettings`. Omit-when-default (see `taskDisplay.ts`). */
  taskDisplay?: TaskDisplaySettings;
  /** The LAST task view (filters + sort), stored at the CONTAINER level so it
   *  survives closing and reopening the Tasks tab (myne-md/myne#656 review).
   *  Window-global; omit-when-default. The per-tab copy on the item is written
   *  too, for migration and for a second pane, but this is what a reopened tab
   *  restores from. */
  taskView?: PersistedTaskView;
};

/** Caller-supplied slot-id factory (the app wires `crypto.randomUUID`). */
export type SlotIdFactory = () => SlotId;

/** The default fresh-slot name (used when the last slot is deleted). Resolved
 *  at call time via i18n (NOT a module-frozen const) so a fresh slot minted
 *  after a language switch carries the active-language name; the name is then
 *  ordinary stored data the user can rename. */
export function defaultSlotName(): string {
  return i18n.t("notes.workspace.defaultSlotName");
}

/**
 * A fresh container holding a single "Default" slot. `paneId` seeds that slot's
 * empty workspace; `slotId` (defaulting to `crypto.randomUUID`) names the slot.
 */
export function emptyNamedWorkspaces(
  paneId: PaneId,
  slotId: SlotId = crypto.randomUUID(),
  name: string = defaultSlotName(),
): NamedWorkspaces {
  return {
    slots: [{ id: slotId, name, state: emptyWorkspace(paneId) }],
    activeId: slotId,
  };
}

/** Wrap a bare descriptor as a single-slot container - the migration shape for
 *  a legacy single-`WorkspaceState` payload (MYND-308 task 2). */
export function wrapAsSingleSlot(
  state: WorkspaceState,
  slotId: SlotId = crypto.randomUUID(),
  name: string = defaultSlotName(),
): NamedWorkspaces {
  return { slots: [{ id: slotId, name, state }], activeId: slotId };
}

/** All slots (in declaration order). */
export function listSlots(container: NamedWorkspaces): WorkspaceSlot[] {
  return container.slots;
}

/** The active slot, or `null` when `activeId` dangles (a self-heal caller then
 *  falls back to the first slot - see {@link resolveActiveSlot}). */
export function activeSlot(container: NamedWorkspaces): WorkspaceSlot | null {
  return container.slots.find((s) => s.id === container.activeId) ?? null;
}

/**
 * The active slot's descriptor - the bridge existing reducers/selectors plug
 * into. Falls back to the FIRST slot when `activeId` dangles (defensive; the
 * container always has ≥1 slot, so this never returns from an empty list).
 */
export function activeSlotState(container: NamedWorkspaces): WorkspaceState {
  return (activeSlot(container) ?? container.slots[0]!).state;
}

/**
 * Replace the active slot's descriptor with `next` (immutably). This is how the
 * app layer commits the result of an existing reducer back into the container:
 * `setActiveSlotState(c, openInNewTab(activeSlotState(c), item))`.
 */
export function setActiveSlotState(
  container: NamedWorkspaces,
  next: WorkspaceState,
): NamedWorkspaces {
  const targetId = activeSlot(container) !== null
    ? container.activeId
    : container.slots[0]!.id;
  return {
    ...container,
    activeId: targetId,
    slots: container.slots.map((s) =>
      s.id === targetId ? { ...s, state: next } : s,
    ),
  };
}

/**
 * Create a new slot named `name` holding `state` (a fresh empty workspace when
 * omitted) and make it active. `newId` mints the slot id (defaults to
 * `crypto.randomUUID`); `newPaneId` seeds a fresh slot's root pane.
 */
export function createSlot(
  container: NamedWorkspaces,
  name: string,
  state?: WorkspaceState,
  newId: SlotIdFactory = () => crypto.randomUUID(),
  newPaneId: IdFactory = () => crypto.randomUUID(),
): NamedWorkspaces {
  const id = newId();
  const slot: WorkspaceSlot = {
    id,
    name,
    state: state ?? emptyWorkspace(newPaneId()),
  };
  return { slots: [...container.slots, slot], activeId: id };
}

/**
 * "Save as…": clone the ACTIVE slot's current descriptor under a new `name` and
 * switch to the clone (the original slot is left untouched). The clone is a
 * structural snapshot - later edits to either slot don't bleed across.
 */
export function saveAsSlot(
  container: NamedWorkspaces,
  name: string,
  newId: SlotIdFactory = () => crypto.randomUUID(),
): NamedWorkspaces {
  return createSlot(container, name, cloneState(activeSlotState(container)), newId);
}

/** Activate `id` (no-op if it isn't a known slot). */
export function switchToSlot(
  container: NamedWorkspaces,
  id: SlotId,
): NamedWorkspaces {
  if (!container.slots.some((s) => s.id === id)) return container;
  return { ...container, activeId: id };
}

/** Rename slot `id` (no-op if unknown). */
export function renameSlot(
  container: NamedWorkspaces,
  id: SlotId,
  name: string,
): NamedWorkspaces {
  if (!container.slots.some((s) => s.id === id)) return container;
  return {
    ...container,
    slots: container.slots.map((s) => (s.id === id ? { ...s, name } : s)),
  };
}

/**
 * Delete slot `id`. Deleting a non-active slot keeps the active pointer.
 * Deleting the active slot relocates the pointer to a sibling (the slot before
 * it in order, else the one after). Deleting the LAST remaining slot yields a
 * fresh empty "Default" slot (the container is never slotless). No-op if `id`
 * is unknown.
 */
export function deleteSlot(
  container: NamedWorkspaces,
  id: SlotId,
  newId: SlotIdFactory = () => crypto.randomUUID(),
  newPaneId: IdFactory = () => crypto.randomUUID(),
): NamedWorkspaces {
  const idx = container.slots.findIndex((s) => s.id === id);
  if (idx < 0) return container;
  const remaining = container.slots.filter((s) => s.id !== id);
  if (remaining.length === 0) {
    // Deleted the last slot → fall back to a fresh empty Default.
    return emptyNamedWorkspaces(newPaneId(), newId());
  }
  let activeId = container.activeId;
  if (activeId === id) {
    // Active slot deleted → prefer the previous sibling, else the next.
    const fallback = container.slots[idx - 1] ?? container.slots[idx + 1]!;
    activeId = fallback.id;
  }
  return { slots: remaining, activeId };
}

/**
 * The slot id to activate given a persisted `active_workspace` pref pointer
 * (MYP1, MYND-308 task 3): the pref's id when it names an existing slot,
 * otherwise the first slot's id (the consistency fallback for a stale/missing
 * pointer). Pure - the caller self-heals the pref on the next write.
 */
export function resolveActiveSlot(
  slots: WorkspaceSlot[],
  activeWorkspacePref: string | null | undefined,
): SlotId {
  if (
    activeWorkspacePref != null &&
    slots.some((s) => s.id === activeWorkspacePref)
  ) {
    return activeWorkspacePref;
  }
  return slots[0]!.id;
}

/**
 * Coalescing-flush decision (MYND-308 task 4): whether the staged MYW1
 * descriptor should be flushed to disk NOW. True at most once per ~5 minutes of
 * activity, and only while dirty. Pure - `nowMs` is injected (the app layer owns
 * the timer + Date.now + the flush-on-graceful-exit/lock path; this is only the
 * decision). `lastFlushAtMs === null` means "never flushed" → flush as soon as
 * dirty.
 */
export const WORKSPACE_FLUSH_INTERVAL_MS = 300_000; // ~5 min

export function shouldFlushWorkspace(args: {
  lastFlushAtMs: number | null;
  nowMs: number;
  dirty: boolean;
}): boolean {
  const { lastFlushAtMs, nowMs, dirty } = args;
  if (!dirty) return false;
  if (lastFlushAtMs === null) return true;
  return nowMs - lastFlushAtMs >= WORKSPACE_FLUSH_INTERVAL_MS;
}

/**
 * Revert the active slot to a last-persisted descriptor ("Reset to snapshot",
 * MYND-308 task 4). Pure - the caller supplies the last-persisted `WorkspaceState`
 * (e.g. from re-deserializing the staged/on-disk blob). No-op shape if the
 * container has no active slot (falls back to setting the first slot).
 */
export function resetActiveToSnapshot(
  container: NamedWorkspaces,
  lastPersisted: WorkspaceState,
): NamedWorkspaces {
  return setActiveSlotState(container, cloneState(lastPersisted));
}

/** Deep structural clone of a descriptor (slot snapshots must not alias the
 *  source tree). Pure data - `structuredClone` is sufficient and dependency-free. */
function cloneState(state: WorkspaceState): WorkspaceState {
  return structuredClone(state);
}
