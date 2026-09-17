// `workspace-persist` - IPC bindings + (de)serialization for the encrypted
// editor workspace descriptor (MYND-166, Task 13).
//
// The descriptor is the `WorkspaceState` pane tree serialized to JSON. It is
// persisted ONLY on graceful exit (lock / auto-lock grace / quit) - never on
// tab switch - so the `vault.workspace` blob's mtime never becomes an editor-
// activity log (design grill 2026-06-01 Q1). The Rust side seals it opaque
// under `session_state_key` (`MYW1`, protocol.md § 9.7).

import { invoke } from "../platform/core";
import { decodeGraphSettings, encodeGraphSettings } from "../notes/graphSettings";
import { decodeTaskDisplay, encodeTaskDisplay } from "../notes/taskDisplay";
import type { DetachedEntry } from "../notes/detachedRestore";
import {
  collectLeaves,
  findLeaf,
  GRAPH_TAB_ID,
  TASKS_TAB_ID,
  itemKey,
  sameItem,
  wrapAsSingleSlot,
  type LeafPane,
  type NamedWorkspaces,
  type PersistedTaskView,
  type ViewMode,
  type WorkspaceItem,
  type WorkspaceNode,
  type WorkspaceSlot,
  type WorkspaceState,
} from "../notes/workspaceState";

/** Read the persisted descriptor, or `null` when none/unrestorable. */
export async function workspaceRead(): Promise<string | null> {
  return await invoke<string | null>("plugin:workspace|workspace_read");
}

/** Persist the descriptor (opaque JSON) to the encrypted blob. */
export async function workspaceWrite(descriptor: string): Promise<void> {
  await invoke("plugin:workspace|workspace_write", { descriptor });
}

/**
 * Stage the descriptor in the backend's in-RAM slot (no file write). Flushed
 * to `vault.workspace` only on app exit - this is the persist path for app
 * QUIT (Cmd+Q / app-menu Quit), which fires the Rust `ExitRequested` event
 * but NOT the window's `onCloseRequested`. Cheap; safe to call per layout
 * change (it never touches the blob's mtime).
 */
export async function workspaceStage(descriptor: string): Promise<void> {
  await invoke("plugin:workspace|workspace_stage", { descriptor });
}

/** Serialize a single descriptor to the on-disk string form.
 *
 * The tab-modes (MYND-319/320) `pinned` (per-tab) and `stacked` (per-leaf)
 * fields, plus the reading-source-modes (MYND-299) per-tab `viewMode`, are all
 * **omit-when-default**: the pure model never stores `pinned: false`,
 * `stacked: false`, or `viewMode: "live"` (the un-set transitions DROP the key),
 * and `JSON.stringify` omits `undefined` keys - so a workspace with no pins, no
 * stacked panes, and all-default view modes serializes BYTE-IDENTICAL to a
 * pre-feature descriptor. The single-descriptor form stays engine-opaque
 * (§9.7.2, SYNC-4); the container form ({@link serializeWorkspaces}) rides the
 * MYW1 0x02 blob (MYND-308). */
export function serializeWorkspace(state: WorkspaceState): string {
  return JSON.stringify({ root: state.root, focusedPaneId: state.focusedPaneId });
}

/**
 * Parse + structurally validate a descriptor into a `WorkspaceState`.
 * Returns `null` on any malformation (the caller falls back to a fresh
 * single empty pane) - defense against a tampered-but-AEAD-OK blob and
 * against schema drift across versions.
 */
export function deserializeWorkspace(json: string): WorkspaceState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const focusedPaneId = obj.focusedPaneId;
  if (typeof focusedPaneId !== "string") return null;
  // Normalize (not just validate): migrate legacy bare-string tabs to note
  // items, and DROP well-formed unknown-kind tabs (forward-compat) - a junk tab
  // still rejects the whole blob (the original strictness for corruption).
  const root = normalizeNode(obj.root);
  if (root === null) return null;
  const state: WorkspaceState = { root, focusedPaneId };
  // focusedPaneId must reference an existing leaf; otherwise reject.
  if (findLeaf(state.root, focusedPaneId) === null) return null;
  // Reject duplicate items across panes (the global (kind,id) invariant).
  const seen = new Set<string>();
  for (const leaf of collectLeaves(state.root)) {
    for (const t of leaf.tabs) {
      const k = itemKey(t);
      if (seen.has(k)) return null;
      seen.add(k);
    }
  }
  return state;
}

// ============================================================
// Named-workspaces container (de)serialization (MYND-308 task 2).
//
// This is the inner plaintext sealed into the MYW1 0x02 blob. The container is
// `{ slots: WorkspaceSlot[]; activeId: string }`; each slot's `state` is an
// ordinary single descriptor handled by the functions above (so per-tab
// `viewMode` omit-when-default is preserved per slot automatically). Migration-
// on-read wraps a stray LEGACY single-descriptor payload (the 0x01 shape) as a
// single "Default" slot - defensive even though the Rust envelope now rejects
// 0x01.
// ============================================================

/** Serialize a `NamedWorkspaces` container to the MYW1 0x02 descriptor string.
 *  Each slot's `state` is emitted as a `{root, focusedPaneId}` object, so the
 *  same omit-when-default discipline (pinned / stacked / viewMode) applies
 *  per slot. */
export function serializeWorkspaces(container: NamedWorkspaces): string {
  // graph-connection-ux-polish task 5: the graph pane's device-local settings,
  // omit-when-default per field (see `graphSettings.ts`). Same discipline as
  // `expandedFolders` below - no format bump, an old reader tolerates the
  // unknown field, a reader on a default-only vault sees no key at all.
  const encodedGraphSettings = container.graphSettings
    ? encodeGraphSettings(container.graphSettings)
    : undefined;
  // myne-md/myne#656 item 4: task-surface display, same container-level,
  // omit-when-default discipline.
  const encodedTaskDisplay = container.taskDisplay
    ? encodeTaskDisplay(container.taskDisplay)
    : undefined;
  return JSON.stringify({
    slots: container.slots.map((s) => ({
      id: s.id,
      name: s.name,
      state: { root: s.state.root, focusedPaneId: s.state.focusedPaneId },
    })),
    activeId: container.activeId,
    // MYND-455: sidebar folder-expand set, omit-when-empty (no format bump -
    // the named-workspaces omit-when-default discipline). A pre-455 reader
    // tolerates the unknown field; a post-455 reader tolerates its absence.
    ...(container.expandedFolders && container.expandedFolders.length > 0
      ? { expandedFolders: [...container.expandedFolders] }
      : {}),
    ...(encodedGraphSettings ? { graphSettings: encodedGraphSettings } : {}),
    ...(encodedTaskDisplay ? { taskDisplay: encodedTaskDisplay } : {}),
    // Container-level last task view (myne-md/myne#656 review): stored here so a
    // closed-and-reopened Tasks tab restores its filters. Already the delta shape.
    ...(container.taskView ? { taskView: container.taskView } : {}),
    // myne#678 task 6 (SYNC-10): open detached (pop-out) windows to restore next
    // launch, omit-when-empty (same discipline as `expandedFolders`). A
    // pre-feature reader tolerates the unknown field; a reader on a vault with no
    // pop-outs sees no key at all, so the blob stays byte-identical.
    ...(container.detached && container.detached.length > 0
      ? {
          detached: container.detached.map((d) => ({
            noteId: d.noteId,
            geometry: { ...d.geometry },
          })),
        }
      : {}),
  });
}

/**
 * Splice the current detached-window snapshot into an already-serialized MYW1
 * descriptor (myne#678 task 6), read-modify-write.
 *
 * The detached geometry is fetched from the host asynchronously at persist time
 * (a detached window's move is not a main-window event, so the snapshot has to be
 * taken when the blob is written), while the descriptor itself is serialized
 * synchronously each render. Splicing the two here keeps the pane-tree
 * serialization untouched and is the same read-modify-write mobile uses for
 * `expandedFolders`. An empty list removes the key (omit-when-empty); a
 * malformed base descriptor is returned unchanged rather than dropped.
 */
export function withDetached(descriptor: string, detached: DetachedEntry[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(descriptor);
  } catch {
    return descriptor;
  }
  if (typeof parsed !== "object" || parsed === null) return descriptor;
  const obj = parsed as Record<string, unknown>;
  if (detached.length > 0) {
    obj.detached = detached.map((d) => ({ noteId: d.noteId, geometry: { ...d.geometry } }));
  } else {
    delete obj.detached;
  }
  return JSON.stringify(obj);
}

/** Parse the persisted detached-window list defensively (myne#678 task 6). A
 *  malformed entry is skipped rather than rejecting the whole blob (a bad
 *  geometry must not lose every open note), the same tolerance `expandedFolders`
 *  and `graphSettings` take. */
function parseDetachedEntries(raw: unknown): DetachedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DetachedEntry[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.noteId !== "string" || o.noteId === "") continue;
    const g = o.geometry;
    if (typeof g !== "object" || g === null) continue;
    const gg = g as Record<string, unknown>;
    // Persisted geometry is untrusted input (written by an earlier session,
    // possibly hand-edited on disk): shape alone is not enough, since NaN,
    // Infinity, and zero or negative sizes would reach the host spawn and fail
    // there. Reject non-finite and non-positive sizes here with the same
    // skip-the-entry tolerance as a malformed entry.
    if (
      typeof gg.x !== "number" ||
      typeof gg.y !== "number" ||
      typeof gg.width !== "number" ||
      typeof gg.height !== "number" ||
      !Number.isFinite(gg.x) ||
      !Number.isFinite(gg.y) ||
      !Number.isFinite(gg.width) ||
      !Number.isFinite(gg.height) ||
      gg.width <= 0 ||
      gg.height <= 0
    ) {
      continue;
    }
    out.push({
      noteId: o.noteId,
      geometry: { x: gg.x, y: gg.y, width: gg.width, height: gg.height },
    });
  }
  return out;
}

/**
 * Parse + structurally validate a MYW1 descriptor into a `NamedWorkspaces`
 * container. Accepts BOTH shapes:
 *  - the container shape (`{slots, activeId}`) - the 0x02 form;
 *  - a LEGACY single descriptor (`{root, focusedPaneId}` with no `slots`) -
 *    migrated-on-read by wrapping it as a single "Default" slot.
 * Returns `null` on any malformation (the caller falls back to a fresh single
 * empty slot). `newId` mints the migration slot id (defaults to
 * `crypto.randomUUID`; tests inject a deterministic value).
 */
export function deserializeWorkspaces(
  json: string,
  newId: () => string = () => crypto.randomUUID(),
): NamedWorkspaces | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Legacy single-descriptor migration: no `slots`, but the bare descriptor
  // shape. Re-serialize the descriptor sub-object and run it through the
  // single-descriptor validator, then wrap as a single Default slot.
  if (!("slots" in obj)) {
    const legacy = deserializeWorkspace(json);
    if (legacy === null) return null;
    return wrapAsSingleSlot(legacy, newId());
  }

  if (!Array.isArray(obj.slots) || obj.slots.length === 0) return null;
  if (typeof obj.activeId !== "string") return null;

  const slots: WorkspaceSlot[] = [];
  const slotIds = new Set<string>();
  for (const raw of obj.slots) {
    if (typeof raw !== "object" || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.name !== "string") return null;
    if (slotIds.has(s.id)) return null; // duplicate slot ids reject
    const state = deserializeWorkspace(JSON.stringify(s.state));
    if (state === null) return null;
    slotIds.add(s.id);
    slots.push({ id: s.id, name: s.name, state });
  }

  // activeId must name an existing slot; otherwise reject (the consistency
  // fallback lives in `resolveActiveSlot`, applied against the MYP1 pointer -
  // a self-inconsistent blob is corruption and rejects here).
  if (!slotIds.has(obj.activeId)) return null;

  // MYND-455: sidebar folder-expand set (optional, forward/backward compatible).
  // A malformed field is tolerated as absent (a stray value is not corruption -
  // worst case the sidebar opens collapsed), keeping it strictly additive.
  const expandedFolders =
    Array.isArray(obj.expandedFolders) && obj.expandedFolders.every((k) => typeof k === "string")
      ? (obj.expandedFolders as string[])
      : undefined;

  // graph-connection-ux-polish task 5: decode field-by-field (a malformed
  // value degrades to its default, never rejects the whole blob - see
  // `decodeGraphSettings`), then drop the key entirely when the result is
  // all-default (the same omit-when-default check `encodeGraphSettings` uses
  // on write, kept as the single source of truth for "is this default").
  const decodedGraphSettings = decodeGraphSettings(obj.graphSettings);
  const graphSettings = encodeGraphSettings(decodedGraphSettings) ? decodedGraphSettings : undefined;

  // myne-md/myne#656 item 4: task-surface display, decoded field-by-field (a
  // malformed colour degrades to the default, never rejects the blob).
  const decodedTaskDisplay = decodeTaskDisplay(obj.taskDisplay);
  const taskDisplay = encodeTaskDisplay(decodedTaskDisplay) ? decodedTaskDisplay : undefined;

  // myne#678 task 6: the detached-window restore list (optional, forward/backward
  // compatible), parsed defensively like the two fields above.
  const detached = parseDetachedEntries(obj.detached);

  const result: NamedWorkspaces = { slots, activeId: obj.activeId };
  if (expandedFolders && expandedFolders.length > 0) result.expandedFolders = expandedFolders;
  if (graphSettings) result.graphSettings = graphSettings;
  if (taskDisplay) result.taskDisplay = taskDisplay;
  if (detached.length > 0) result.detached = detached;
  // Container-level last task view. Reuses the item parser by faking its shape.
  const containerTaskView = parseTaskView({ taskView: obj.taskView }).taskView;
  if (containerTaskView !== undefined) result.taskView = containerTaskView;
  return result;
}

/** One parsed tab: a valid item, a well-formed-but-unknown-kind tab to DROP
 *  (forward-compat), or genuinely malformed input that rejects the blob. */
type ParsedItem = { item: WorkspaceItem } | "drop" | "invalid";

/** Parse one untrusted tab entry. A bare string is a legacy note id (MYND-166
 *  format, pre-MYND-274); `{kind:"note"|"view"|"graph", id}` is a current item; a
 *  well-formed `{kind:<other>, id}` is a future kind to drop; anything else is
 *  invalid. */
/**
 * The persisted task view, defensively (myne-md/myne#656).
 *
 * Field-by-field, omit-when-default: a malformed or unknown value degrades to
 * its default rather than rejecting the whole workspace blob and losing every
 * open tab. Reads the nested `taskView` shape, and ALSO migrates a pre-redesign
 * descriptor's `taskFilter`/`taskScope` so an open tab keeps its narrowing.
 */
function parseTaskView(o: Record<string, unknown>): { taskView?: PersistedTaskView } {
  const raw =
    typeof o.taskView === "object" && o.taskView !== null
      ? (o.taskView as Record<string, unknown>)
      : {};
  const v: PersistedTaskView = {};

  if (raw.status === "all" || raw.status === "done") v.status = raw.status;
  if (
    raw.due === "overdue" ||
    raw.due === "today" ||
    raw.due === "upcoming" ||
    raw.due === "later" ||
    raw.due === "none"
  ) {
    v.due = raw.due;
  }
  if (typeof raw.noteId === "string" && raw.noteId !== "") v.noteId = raw.noteId;
  if (Array.isArray(raw.folders)) {
    const folders = raw.folders.filter((f): f is string => typeof f === "string" && f !== "");
    if (folders.length > 0) v.folders = folders;
  }
  // Migration: the first multi-folder shape was a single `folder` string.
  if (v.folders === undefined && typeof raw.folder === "string" && raw.folder !== "") {
    v.folders = [raw.folder];
  }
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.filter((t): t is string => typeof t === "string" && t !== "");
    if (tags.length > 0) v.tags = tags;
  }
  if (
    raw.priority === "highest" ||
    raw.priority === "high" ||
    raw.priority === "medium" ||
    raw.priority === "low" ||
    raw.priority === "lowest"
  ) {
    v.priority = raw.priority;
  }
  if (raw.sort === "dueDesc" || raw.sort === "priority" || raw.sort === "note") {
    v.sort = raw.sort;
  }

  // Legacy migration: the pre-redesign `taskFilter` (a date bucket) and
  // `taskScope` (folder + tags). `"all"` maps to the default `due: "any"`.
  if (v.due === undefined) {
    if (o.taskFilter === "overdue" || o.taskFilter === "today" || o.taskFilter === "upcoming") {
      v.due = o.taskFilter;
    }
  }
  if (v.folders === undefined && typeof o.taskScope === "object" && o.taskScope !== null) {
    const s = o.taskScope as Record<string, unknown>;
    if (typeof s.folder === "string" && s.folder !== "") v.folders = [s.folder];
    if (v.tags === undefined && Array.isArray(s.tags)) {
      const tags = s.tags.filter((t): t is string => typeof t === "string" && t !== "");
      if (tags.length > 0) v.tags = tags;
    }
  }

  return Object.keys(v).length > 0 ? { taskView: v } : {};
}

function parseItem(t: unknown): ParsedItem {
  if (typeof t === "string") return { item: { kind: "note", id: t } };
  if (typeof t !== "object" || t === null) return "invalid";
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string") return "invalid";
  // tab-modes (MYND-320): a per-tab `pinned` flag. Read-when-present, omit-
  // when-absent (an old descriptor - or any unpinned tab - has no key, which is
  // the unpinned default). Only a literal `true` pins; anything else (false /
  // absent / junk) is treated as unpinned, so the key never round-trips as
  // `false` and a non-pinned tab stays byte-identical to pre-feature.
  const pinned = o.pinned === true ? { pinned: true as const } : {};
  // reading-source-modes (MYND-299): a per-tab `viewMode`. Read-when-present,
  // omit-when-default - only an explicit `"reading"` / `"source"` round-trips;
  // anything else (absent / `"live"` / junk) is the `"live"` default, so the key
  // never persists for a default-mode tab and stays byte-identical to pre-feature.
  const viewMode: { viewMode?: ViewMode } =
    o.viewMode === "reading"
      ? { viewMode: "reading" }
      : o.viewMode === "source"
        ? { viewMode: "source" }
        : {};
  if (o.kind === "note" || o.kind === "view") {
    return { item: { kind: o.kind, id: o.id, ...pinned, ...viewMode } };
  }
  // The whole-vault graph (MYND-198) is a singleton tab; its id is the fixed
  // sentinel, so any persisted id normalizes to a canonical graph item.
  if (o.kind === "graph") {
    return { item: { kind: "graph", id: GRAPH_TAB_ID, ...pinned, ...viewMode } };
  }
  // The vault-wide task list (MYND-616) - a singleton like the graph, plus two
  // pieces of per-tab session state. Both are read-when-present and
  // **degrade to the default rather than erroring**: an unknown filter name from
  // a future build, or junk in `taskScope`, must not reject the whole workspace
  // blob and lose every open tab.
  if (o.kind === "tasks") {
    return {
      item: {
        kind: "tasks",
        id: TASKS_TAB_ID,
        ...pinned,
        ...viewMode,
        ...parseTaskView(o),
      },
    };
  }
  if (typeof o.kind === "string") return "drop"; // unknown future kind
  return "invalid";
}

/**
 * Recursive normalizer for an untrusted `WorkspaceNode`. Returns a cleaned node
 * (legacy tabs migrated, unknown-kind tabs dropped) or `null` on structural
 * malformation. A leaf whose `activeTab` was dropped/absent falls back to its
 * first surviving tab (or `null` when tabless).
 */
function normalizeNode(n: unknown): WorkspaceNode | null {
  if (typeof n !== "object" || n === null) return null;
  const node = n as Record<string, unknown>;
  if (node.kind === "leaf") {
    if (typeof node.id !== "string") return null;
    if (!Array.isArray(node.tabs)) return null;
    const tabs: WorkspaceItem[] = [];
    for (const t of node.tabs) {
      const parsed = parseItem(t);
      if (parsed === "invalid") return null;
      if (parsed === "drop") continue;
      tabs.push(parsed.item);
    }
    let activeTab: WorkspaceItem | null = null;
    const rawActive = node.activeTab;
    if (rawActive !== null && rawActive !== undefined) {
      const parsed = parseItem(rawActive);
      if (parsed === "invalid") return null;
      if (parsed === "drop") {
        // The active tab was a dropped unknown-kind item → fall back to the
        // first surviving tab (graceful forward-compat), or null if tabless.
        activeTab = tabs.length > 0 ? tabs[0]! : null;
      } else if (tabs.some((x) => sameItem(x, parsed.item))) {
        activeTab = parsed.item;
      } else {
        // A well-formed activeTab absent from the surviving tabs is corruption
        // - reject the whole blob (the original strictness).
        return null;
      }
    }
    // tab-modes (MYND-319): a per-leaf `stacked` layout flag. Read-when-present,
    // omit-when-absent - only a literal `true` stacks; anything else (false /
    // absent / junk) is the not-stacked default, so the key never round-trips as
    // `false` and a non-stacked pane stays byte-identical to pre-feature.
    const leaf: LeafPane = { kind: "leaf", id: node.id, tabs, activeTab };
    if (node.stacked === true) leaf.stacked = true;
    return leaf;
  }
  if (node.kind === "split") {
    if (typeof node.id !== "string") return null;
    if (node.direction !== "row" && node.direction !== "column") return null;
    if (!Array.isArray(node.children) || node.children.length < 2) return null;
    const children: WorkspaceNode[] = [];
    for (const c of node.children) {
      const cn = normalizeNode(c);
      if (cn === null) return null;
      children.push(cn);
    }
    return { kind: "split", id: node.id, direction: node.direction, children };
  }
  return null;
}
