// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "@tauri-apps/api/core";
import { resetGraphLayoutOnLock } from "../notes/graphLayoutPersist";

/** Read-only probe of the `UnlockedVault` slot. */
export async function isVaultUnlocked(): Promise<boolean> {
  return await invoke<boolean>("plugin:vault-unlock|vault_is_unlocked");
}

/** Drop the slot. Idempotent on already-locked. */
export async function lockVault(): Promise<void> {
  // Drop the in-memory graph layout + cancel any pending disk flush BEFORE the
  // slot goes away, so a vault switch can't carry one vault's positions into
  // another's encrypted cache (see `resetGraphLayoutOnLock`).
  resetGraphLayoutOnLock();
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
