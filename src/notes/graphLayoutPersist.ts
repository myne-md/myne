// Disk persistence for the graph layout (Tier 3). Reads/writes the encrypted
// `vault.graph` blob (`MYG1`, protocol.md §9.19) via the `graph-layout` Tauri
// plugin, so the laid-out node positions survive an app restart — reopening the
// graph restores the previous arrangement instead of recomputing it.
//
// A rebuildable cache: every failure (locked slot, absent blob, decode-fail)
// degrades to "empty store → recompute the layout", never an error to the user.
// Mirrors the frontend-driven shape of `src/lib/workspace-persist.ts`.

import { invoke } from "../platform/core";
import {
  clearGraphLayout,
  hasGraphLayout,
  hydrateGraphLayout,
  serializeGraphLayout,
} from "./graphLayoutStore";

/** Read the persisted layout payload, or `null` when there is none / the slot
 *  is locked (the Rust command returns `Option<String>`). */
export async function graphLayoutRead(): Promise<string | null> {
  return await invoke<string | null>("plugin:graph-layout|graph_layout_read");
}

/** Write the layout payload to `vault.graph` (atomic, sealed). */
export async function graphLayoutWrite(payload: string): Promise<void> {
  await invoke("plugin:graph-layout|graph_layout_write", { payload });
}

/**
 * Read the persisted layout (if any) and hydrate the in-memory store. ALWAYS
 * clears the store first (via {@link hydrateGraphLayout}), so a vault switch
 * (lock A → unlock B) can never seed B's graph with A's positions. Best-effort:
 * a locked slot / absent blob / decode-fail all resolve to "empty store".
 */
export async function loadGraphLayoutFromDisk(): Promise<void> {
  try {
    hydrateGraphLayout(await graphLayoutRead());
  } catch {
    hydrateGraphLayout(null); // clear on failure too
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced, best-effort flush of the current store to `vault.graph`. Coalesces
 * rapid changes (a fresh worker layout, then several node drags) into one write,
 * so the graph blob's mtime does not churn per interaction. Fire-and-forget —
 * a write failure is swallowed (the layout is a cache).
 */
export function scheduleGraphLayoutFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!hasGraphLayout()) return;
    void graphLayoutWrite(serializeGraphLayout()).catch(() => {});
  }, 800);
}

/**
 * Flush the current layout to `vault.graph` SYNCHRONOUSLY (awaited), cancelling
 * the pending debounce. Called from the graceful vault-teardown seams (lock /
 * window-close / idle-auto-lock / vault-switch) — beside `persistWorkspace` /
 * `persistVaultIndices` — so the most-recent layout (a fresh worker layout, or a
 * node drag less than the 800 ms debounce before the lock) is written BEFORE the
 * slot goes away, instead of being lost with the cancelled debounce. Best-effort
 * (the layout is a rebuildable cache); a locked slot / write failure is swallowed.
 */
export async function flushGraphLayoutNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!hasGraphLayout()) return;
  try {
    await graphLayoutWrite(serializeGraphLayout());
  } catch {
    // best-effort — the layout is a rebuildable cache.
  }
}

/**
 * Reset on vault lock: cancel any pending flush and drop the in-memory layout.
 * Ensures vault A's positions never linger into vault B, and a flush scheduled
 * just before lock can never write A's positions to B's `vault.graph`. Wired
 * into `lockVault()` — the frontend lock choke point.
 */
export function resetGraphLayoutOnLock(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  clearGraphLayout();
}
