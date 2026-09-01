// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "../platform/core";
import { clearCustomTheme } from "./customTheme";
import {
  flushGraphLayoutNow,
  resetGraphLayoutOnLock,
} from "./graph-layout-persist";
import { flushWorkspaceNow, resetWorkspaceOnLock } from "./workspace-persist";
import { endAgentRun } from "./agent-lifetime";
// The attachment caches live in the SHARED editor package, and mobile compiles
// it: `editor-host.ts` wires a real `attachments` host, so the same decoration
// fills the same module-scope maps here that it does on desktop. Cleared from
// leaf modules rather than from `widgets.ts` so this import cannot drag the
// attachment-widget subtree into the eager bundle graph.
import { resetDecodedAspects } from "@myne/editor/attachments/decoded-aspect";
import {
  resetPreviewCache,
  resetTranscripts,
} from "@myne/editor/attachments/session-caches";

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
 *  - custom palette off the document root (MYND-598). Nothing to flush — it is a
 *    revert, and it runs FIRST so the screen stops wearing the vault's colours
 *    before anything is awaited. A palette says far more about vault contents
 *    than a light/dark attribute does; someone who picks up the locked phone
 *    must learn nothing from it (`design-notes.md` 2026-07-31). Riding
 *    `lockVault` rather than the Lock button is the point: an exit route added
 *    later inherits the revert instead of forgetting it.
 *
 * Every flush/reset step is best-effort; the lock itself always runs.
 */
export async function lockVault(): Promise<void> {
  clearCustomTheme();
  // **The agent run, first, and not best-effort in the way the flushes are.**
  // Everything else on this path is a WRITE that would be nice to land; this is
  // a DROP that must happen. `Proposal.edits` holds anchors and replacements
  // copied verbatim out of note bodies, so a store that survives this call
  // leaves note text resident in a locked vault's memory, and mixes two vaults
  // when the lock is really a switch (every vault change on mobile comes
  // through here). It is synchronous and cannot throw, so it runs before the
  // first await rather than after: an await that rejects must not be able to
  // skip it.
  endAgentRun("lock", "");
  await flushGraphLayoutNow();
  resetGraphLayoutOnLock();
  await flushWorkspaceNow();
  resetWorkspaceOnLock();
  // Everything the shared editor caches from decrypted attachment content:
  // the decoded image shapes, up to 24 file previews, and any completed
  // transcripts. `resetTranscripts` clears a store mobile does not populate
  // today (no `transcribe` host member is wired), and it is called anyway
  // because whether a shared store is populated is a wiring detail that can
  // change without anyone revisiting this function.
  resetDecodedAspects();
  resetPreviewCache();
  resetTranscripts();
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
