// `workspace-persist` — IPC bindings + (de)serialization for the encrypted
// editor workspace descriptor (MYND-166, Task 13).
//
// The descriptor is the `WorkspaceState` pane tree serialized to JSON. It is
// persisted ONLY on graceful exit (lock / auto-lock grace / quit) — never on
// tab switch — so the `vault.workspace` blob's mtime never becomes an editor-
// activity log (design grill 2026-06-01 Q1). The Rust side seals it opaque
// under `session_state_key` (`MYW1`, protocol.md § 9.7).

import { invoke } from "../platform/core";
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
 * to `vault.workspace` only on app exit — this is the persist path for app
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
 * and `JSON.stringify` omits `undefined` keys — so a workspace with no pins, no
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
 * single empty pane) — defense against a tampered-but-AEAD-OK blob and
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
  // items, and DROP well-formed unknown-kind tabs (forward-compat) — a junk tab
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
// single "Default" slot — defensive even though the Rust envelope now rejects
// 0x01.
// ============================================================

/** Serialize a `NamedWorkspaces` container to the MYW1 0x02 descriptor string.
 *  Each slot's `state` is emitted as a `{root, focusedPaneId}` object, so the
 *  same omit-when-default discipline (pinned / stacked / viewMode) applies
 *  per slot. */
export function serializeWorkspaces(container: NamedWorkspaces): string {
  return JSON.stringify({
    slots: container.slots.map((s) => ({
      id: s.id,
      name: s.name,
      state: { root: s.state.root, focusedPaneId: s.state.focusedPaneId },
    })),
    activeId: container.activeId,
    // MYND-455: sidebar folder-expand set, omit-when-empty (no format bump —
    // the named-workspaces omit-when-default discipline). A pre-455 reader
    // tolerates the unknown field; a post-455 reader tolerates its absence.
    ...(container.expandedFolders && container.expandedFolders.length > 0
      ? { expandedFolders: [...container.expandedFolders] }
      : {}),
  });
}

/**
 * Parse + structurally validate a MYW1 descriptor into a `NamedWorkspaces`
 * container. Accepts BOTH shapes:
 *  - the container shape (`{slots, activeId}`) — the 0x02 form;
 *  - a LEGACY single descriptor (`{root, focusedPaneId}` with no `slots`) —
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
  // fallback lives in `resolveActiveSlot`, applied against the MYP1 pointer —
  // a self-inconsistent blob is corruption and rejects here).
  if (!slotIds.has(obj.activeId)) return null;

  // MYND-455: sidebar folder-expand set (optional, forward/backward compatible).
  // A malformed field is tolerated as absent (a stray value is not corruption —
  // worst case the sidebar opens collapsed), keeping it strictly additive.
  const expandedFolders =
    Array.isArray(obj.expandedFolders) && obj.expandedFolders.every((k) => typeof k === "string")
      ? (obj.expandedFolders as string[])
      : undefined;

  return expandedFolders && expandedFolders.length > 0
    ? { slots, activeId: obj.activeId, expandedFolders }
    : { slots, activeId: obj.activeId };
}

/** One parsed tab: a valid item, a well-formed-but-unknown-kind tab to DROP
 *  (forward-compat), or genuinely malformed input that rejects the blob. */
type ParsedItem = { item: WorkspaceItem } | "drop" | "invalid";

/** Parse one untrusted tab entry. A bare string is a legacy note id (MYND-166
 *  format, pre-MYND-274); `{kind:"note"|"view"|"graph", id}` is a current item; a
 *  well-formed `{kind:<other>, id}` is a future kind to drop; anything else is
 *  invalid. */
/** The persisted task filter, or nothing when it is absent/unknown.
 *  Omit-when-default: `"today"` never round-trips, so a tab on the default
 *  stays byte-identical to a pre-feature descriptor. */
function parseTaskFilter(raw: unknown): { taskFilter?: string } {
  if (raw === "upcoming" || raw === "overdue" || raw === "all") return { taskFilter: raw };
  // Anything else — absent, `"today"`, or a name a future build wrote — is the
  // default. A future filter name degrades to Today rather than erroring.
  return {};
}

/** The persisted task scope, defensively. A malformed value degrades to the
 *  unset scope rather than rejecting the workspace blob. */
function parseTaskScope(raw: unknown): { taskScope?: { folder?: string; tags?: string[] } } {
  if (typeof raw !== "object" || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const folder = typeof o.folder === "string" && o.folder !== "" ? { folder: o.folder } : {};
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string" && t !== "")
    : [];
  if (Object.keys(folder).length === 0 && tags.length === 0) return {};
  return { taskScope: { ...folder, ...(tags.length > 0 ? { tags } : {}) } };
}

function parseItem(t: unknown): ParsedItem {
  if (typeof t === "string") return { item: { kind: "note", id: t } };
  if (typeof t !== "object" || t === null) return "invalid";
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string") return "invalid";
  // tab-modes (MYND-320): a per-tab `pinned` flag. Read-when-present, omit-
  // when-absent (an old descriptor — or any unpinned tab — has no key, which is
  // the unpinned default). Only a literal `true` pins; anything else (false /
  // absent / junk) is treated as unpinned, so the key never round-trips as
  // `false` and a non-pinned tab stays byte-identical to pre-feature.
  const pinned = o.pinned === true ? { pinned: true as const } : {};
  // reading-source-modes (MYND-299): a per-tab `viewMode`. Read-when-present,
  // omit-when-default — only an explicit `"reading"` / `"source"` round-trips;
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
  // The vault-wide task list (MYND-616) — a singleton like the graph, plus two
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
        ...parseTaskFilter(o.taskFilter),
        ...parseTaskScope(o.taskScope),
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
        // — reject the whole blob (the original strictness).
        return null;
      }
    }
    // tab-modes (MYND-319): a per-leaf `stacked` layout flag. Read-when-present,
    // omit-when-absent — only a literal `true` stacks; anything else (false /
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
