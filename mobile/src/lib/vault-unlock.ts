// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "@tauri-apps/api/core";
import {
  flushGraphLayoutNow,
  resetGraphLayoutOnLock,
} from "./graph-layout-persist";
import { flushWorkspaceNow, resetWorkspaceOnLock } from "./workspace-persist";

/** Read-only probe of the `UnlockedVault` slot. */
export async function isVaultUnlocked(): Promise<boolean> {
  return await invoke<boolean>("plugin:vault-unlock|vault_is_unlocked");
}

/**
 * Drop the slot. Idempotent on already-locked.
 *
 * This is the mobile frontend's single lock choke point (Lock button, idle
 * auto-lock, vault switch all funnel here), so the per-vault session-state
 * teardowns ride it: flush the freshest state WHILE the slot is still unlocked,
 * then drop it from RAM (vault A's state must never seed vault B — the §9.19.4 /
 * §9.7.4 posture), then lock.
 *
 *  - graph layout → `vault.graph` (MYG1)
 *  - sidebar folder-expand set → `vault.workspace` (MYND-561, MYW1). This is one
 *    of only two write seams for that blob (the other is app-background), which
 *    is what keeps its mtime from becoming an activity log.
 *
 * Every flush/reset step is best-effort; the lock itself always runs.
 */
export async function lockVault(): Promise<void> {
  await flushGraphLayoutNow();
  resetGraphLayoutOnLock();
  await flushWorkspaceNow();
  resetWorkspaceOnLock();
  await invoke<void>("plugin:vault-unlock|lock");
}

/**
 * Report window-level user activity to the auto-lock-on-idle timer
 * (MYND-121). Lock-free + infallible on the backend (a single relaxed
 * atomic store, never touches the slot lock). Best-effort from the
 * frontend — callers swallow transport errors; the backend idle timer
 * is the authoritative fail-closed clock.
 */
export async function reportUserActivity(): Promise<void> {
  await invoke<void>("plugin:vault-unlock|report_user_activity");
}
