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
  if (!isWorkspaceNode(obj.root)) return null;
  const state: WorkspaceState = { root: obj.root, focusedPaneId };
  // focusedPaneId must reference an existing leaf; otherwise reject.
  if (findLeaf(state.root, focusedPaneId) === null) return null;
  // Reject duplicate note ids across panes (the global invariant).
  const seen = new Set<string>();
  for (const leaf of collectLeaves(state.root)) {
    for (const t of leaf.tabs) {
      if (seen.has(t)) return null;
      seen.add(t);
    }
  }
  return state;
}

/** Recursive structural validator for an untrusted `WorkspaceNode`. */
function isWorkspaceNode(n: unknown): n is WorkspaceNode {
  if (typeof n !== "object" || n === null) return false;
  const node = n as Record<string, unknown>;
  if (node.kind === "leaf") {
    if (typeof node.id !== "string") return false;
    if (!Array.isArray(node.tabs) || !node.tabs.every((t) => typeof t === "string")) {
      return false;
    }
    if (node.activeTab !== null && typeof node.activeTab !== "string") return false;
    // activeTab, when set, must be one of the tabs.
    if (node.activeTab !== null && !(node.tabs as string[]).includes(node.activeTab as string)) {
      return false;
    }
    return true;
  }
  if (node.kind === "split") {
    if (typeof node.id !== "string") return false;
    if (node.direction !== "row" && node.direction !== "column") return false;
    if (!Array.isArray(node.children) || node.children.length < 2) return false;
    return node.children.every(isWorkspaceNode);
  }
  return false;
}
