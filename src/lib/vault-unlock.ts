// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "../platform/core";
import { resetGraphLayoutOnLock } from "../notes/graphLayoutPersist";
import { resetVimStateOnLock } from "../editor/vim";
import { releaseAttachmentUrls } from "../platform/attachments";

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
  // vim-keyboard-mode (MYND-313): yank registers and recorded macros live in the
  // vim engine's MODULE-GLOBAL state, which survives the editor unmount that
  // locking performs. Cleared here for the same reason as the graph layout above
  // — so one vault's note text can never be pasted into another's.
  resetVimStateOnLock();
  // Render-side attachment resources (phase3-web-client task 44). A no-op on
  // desktop, where `attachment://<id>` caches nothing; on web it drops the
  // `blob:` URL strings whose objects the Worker is about to revoke, so a render
  // after a re-unlock cannot paint a revoked URL. Same category as the two calls
  // above: platform state that outlives the slot.
  releaseAttachmentUrls();
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
