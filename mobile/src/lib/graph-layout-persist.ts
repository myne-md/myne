// Disk persistence for the graph layout. Reads/writes the encrypted
// `vault.graph` blob (`MYG1`, protocol.md §9.19) via the `graph-layout` Tauri
// plugin, so the laid-out node positions survive an app restart AND the graph
// tab's constant mount/unmount churn — reopening the graph restores the
// previous arrangement instead of recomputing it.
//
// A rebuildable cache: every failure (locked slot, absent blob, decode-fail)
// degrades to "empty store → recompute the layout", never an error to the
// user (§9.19.4). Near-verbatim port of the desktop
// `src/notes/graphLayoutPersist.ts`, plus `ensureGraphLayoutHydrated` —
// mobile's graph is a TAB that remounts on every visit (not desktop's modal),
// so the disk read latches once per unlock session: a per-mount re-read would
// both spend an IPC round-trip per tab switch and clobber in-memory positions
// newer than disk inside the 800 ms debounce window.

import { invoke } from "@tauri-apps/api/core";
import {
  clearGraphLayout,
  hasGraphLayout,
  hydrateGraphLayout,
  serializeGraphLayout,
} from "@myne/editor/host/notes/graphLayoutStore";

/** Read the persisted layout payload, or `null` when there is none / the slot
 *  is locked (the Rust command returns `Option<String>`). */
export async function graphLayoutRead(): Promise<string | null> {
  return await invoke<string | null>("plugin:graph-layout|graph_layout_read");
}

/** Write the layout payload to `vault.graph` (atomic, sealed). */
export async function graphLayoutWrite(payload: string): Promise<void> {
  await invoke("plugin:graph-layout|graph_layout_write", { payload });
}

/** Once-per-unlock-session hydration latch (cleared by
 *  {@link resetGraphLayoutOnLock}). */
let hydratedThisSession = false;

/**
 * Hydrate the in-memory store from `vault.graph` ONCE per unlock session;
 * subsequent calls (every graph-tab remount) are store-served no-ops. Returns
 * whether the store holds any positions afterwards — the mount's
 * full/partial/cold classification input. Best-effort: a locked slot / absent
 * blob / decode-fail resolves to "empty store → recompute" (§9.19.4).
 */
export async function ensureGraphLayoutHydrated(): Promise<boolean> {
  if (!hydratedThisSession) {
    hydratedThisSession = true;
    try {
      hydrateGraphLayout(await graphLayoutRead());
    } catch {
      hydrateGraphLayout(null); // clear on failure too
    }
  }
  return hasGraphLayout();
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced, best-effort flush of the current store to `vault.graph`.
 * Coalesces rapid changes (a fresh cold-start layout, then several node
 * drags, then the sim settling) into one write, so the graph blob's mtime
 * does not churn per interaction. Fire-and-forget — a write failure is
 * swallowed (the layout is a cache).
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
 * Flush the current layout to `vault.graph` SYNCHRONOUSLY (awaited),
 * cancelling the pending debounce. Called from the graph tab's unmount
 * cleanup (the hot teardown seam — the tab unmounts on every navigation) and
 * from `lockVault()` BEFORE the reset, so a drag less than the 800 ms
 * debounce before the teardown is written rather than lost. Best-effort (the
 * layout is a rebuildable cache); a locked slot / write failure is swallowed.
 * The `hasGraphLayout()` guard makes a post-lock call (the unmount cascade
 * after a lock reset) a no-op — it can never re-write vault A's positions.
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
 * Reset on vault lock: cancel any pending flush, drop the in-memory layout,
 * and re-arm the session hydration latch. Ensures vault A's positions never
 * linger into vault B, and a flush scheduled just before lock can never write
 * A's positions to B's `vault.graph`. Wired into `lockVault()` — the mobile
 * frontend's single lock choke point (Lock button, idle auto-lock, vault
 * switch all funnel through it).
 */
export function resetGraphLayoutOnLock(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  clearGraphLayout();
  hydratedThisSession = false;
}

/** Test-only reset of the module latch/timer. */
export function __resetGraphLayoutPersistForTest(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  hydratedThisSession = false;
}
