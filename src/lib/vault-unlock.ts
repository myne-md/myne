// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "../platform/core";
import { resetGraphLayoutOnLock } from "../notes/graphLayoutPersist";
import { resetVimStateOnLock } from "../editor/vim";
import { releaseAttachmentUrls } from "../platform/attachments";
import { resetTaskIndexCache } from "../notes/taskIndex";
import { clearAgentForLock } from "../notes/agent/agentStore";

/** Read-only probe of the `UnlockedVault` slot. */
export async function isVaultUnlocked(): Promise<boolean> {
  return await invoke<boolean>("plugin:vault-unlock|vault_is_unlocked");
}

/**
 * Run one plaintext-teardown step so that a throw cannot skip the next one, or
 * the lock (myne-md/myne#535).
 *
 * `runFlushChain` states this rule one layer up ("the chain is best-effort and
 * CANNOT skip the lock"), and the rule was not applied inside the lock itself.
 * The five resets below are module-scope stores, an object-URL cache and a
 * WebView teardown; each is ordinary frontend code that can throw, and a throw
 * from any of them rejected `lockVault()` **before the IPC was ever issued**.
 * Both callers then swallowed that rejection and routed to the lock screen
 * anyway, so the screen stood over a slot that still held `root_key`, with the
 * plaintext-derived state the failed step was supposed to wipe still resident.
 *
 * That is the exact shape task 93 fixed for the flush chain, one level down.
 * Worth stating because the ordering reads as defensive already: the resets run
 * before the invoke deliberately (a vault switch must not carry one vault's
 * positions into another's cache), and "before" quietly became "instead of" on
 * any failure.
 *
 * A `console.warn` in dev only, matching every other best-effort teardown here.
 * There is nothing for a user to do about a failed cache reset, and the thing
 * that matters (the keys) is handled by letting the invoke proceed.
 */
function teardownStep(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[lockVault] ${name} threw; continuing to the lock:`, err);
    }
  }
}

/** Drop the slot. Idempotent on already-locked. */
export async function lockVault(): Promise<void> {
  // Drop the in-memory graph layout + cancel any pending disk flush BEFORE the
  // slot goes away, so a vault switch can't carry one vault's positions into
  // another's encrypted cache (see `resetGraphLayoutOnLock`).
  teardownStep("resetGraphLayoutOnLock", () => resetGraphLayoutOnLock());
  // vim-keyboard-mode (MYND-313): yank registers and recorded macros live in the
  // vim engine's MODULE-GLOBAL state, which survives the editor unmount that
  // locking performs. Cleared here for the same reason as the graph layout above
  // — so one vault's note text can never be pasted into another's.
  teardownStep("resetVimStateOnLock", () => resetVimStateOnLock());
  // Render-side attachment resources (phase3-web-client task 44). A no-op on
  // desktop, where `attachment://<id>` caches nothing; on web it drops the
  // `blob:` URL strings whose objects the Worker is about to revoke, so a render
  // after a re-unlock cannot paint a revoked URL. Same category as the two calls
  // above: platform state that outlives the slot.
  teardownStep("releaseAttachmentUrls", () => releaseAttachmentUrls());
  // The agent run's proposal, on the same leg and for the strongest version of
  // the same reason: `proposal.edits` holds anchors and replacements copied
  // VERBATIM out of note bodies, `agentStore` is module scope, and no lock path
  // reloads the WebView. It sits HERE rather than at each caller because the
  // callers are the problem: four paths lock the vault (the Lock button, the
  // vault switch, the StorageLost takeover, the invalid-state fail-closed CTA)
  // and only two of them remembered. A choke point cannot be forgotten by the
  // fifth one.
  teardownStep("clearAgentForLock", () => clearAgentForLock());
  // The task list is the one nonce consumer that answers from MODULE state
  // rather than refetching in its own mount effect, so unlike every other
  // reader surface it does not self-heal on remount (myne#277). The backend
  // wipes `VaultIndicesState` on lock; a cache keyed on a monotonic counter has
  // to be dropped alongside the data it describes, or the next session reads a
  // pre-lock snapshot. Same category as the three calls above: plaintext-derived
  // state that outlives the slot. (The idle auto-lock path reloads the WebView,
  // which clears this for free — the manual Lock button does not.)
  teardownStep("resetTaskIndexCache", () => resetTaskIndexCache());
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
