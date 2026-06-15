// `workspace-persist` — IPC bindings + (de)serialization for the encrypted
// editor workspace descriptor (MYND-166, Task 13).
//
// The descriptor is the `WorkspaceState` pane tree serialized to JSON. It is
// persisted ONLY on graceful exit (lock / auto-lock grace / quit) — never on
// tab switch — so the `vault.workspace` blob's mtime never becomes an editor-
// activity log (design grill 2026-06-01 Q1). The Rust side seals it opaque
// under `session_state_key` (`MYW1`, protocol.md § 9.7).

import { invoke } from "@tauri-apps/api/core";
import {
  collectLeaves,
  findLeaf,
  itemKey,
  sameItem,
  type WorkspaceItem,
  type WorkspaceNode,
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

/** Serialize a workspace to the on-disk descriptor string. */
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

/** One parsed tab: a valid item, a well-formed-but-unknown-kind tab to DROP
 *  (forward-compat), or genuinely malformed input that rejects the blob. */
type ParsedItem = { item: WorkspaceItem } | "drop" | "invalid";

/** Parse one untrusted tab entry. A bare string is a legacy note id (MYND-166
 *  format, pre-MYND-274); `{kind:"note"|"view", id}` is a current item; a
 *  well-formed `{kind:<other>, id}` is a future kind to drop; anything else is
 *  invalid. */
function parseItem(t: unknown): ParsedItem {
  if (typeof t === "string") return { item: { kind: "note", id: t } };
  if (typeof t !== "object" || t === null) return "invalid";
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string") return "invalid";
  if (o.kind === "note" || o.kind === "view") {
    return { item: { kind: o.kind, id: o.id } };
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
    return { kind: "leaf", id: node.id, tabs, activeTab };
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
