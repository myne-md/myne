// Multi-vault in-app switch orchestration (MYND-205, multi-vault
// sub-feature 4, task 4).
//
// `switchVault(targetVaultId, …)` is the lock-then-route half of a vault
// switch: it fires the param-less `vault_lock()` (the four-surface teardown
// + graceful `flushIfDirty` — SYNC-8) to fully tear down the prior vault,
// then dispatches the `editor.switch-vault` Stage action so App.tsx routes
// to the TARGET vault's unlock screen carrying its `VaultId` on the `unlock`
// Stage payload (SYNC-6 targeting). The target's password entry + the
// vault-addressed `unlock` IPC happen on the Unlock screen (sub-feature 3
// task 8) — `switchVault` deliberately does NOT call the unlock IPC itself,
// so the password is typed on the Unlock screen exactly as for the
// picker/lock paths.
//
// Why lock-then-route (not pointer-flip): under SYNC-1 the
// `HashMap<VaultId, Slot>` holds at most one `Unlocked` entry. The
// param-less `vault_lock()` evicts (and zeroizes) the prior `Unlocked`
// slot before the target ever unlocks, so after the switch the target is
// the SOLE `Unlocked` slot — the prior vault is fully torn down (keys +
// search index + VaultIndices + attachment-refs), not merely re-pointed.
//
// `leaveActiveVault` is the first half on its own, exported because the
// device-join door in the account-chip switcher (myne#221) needs the same
// teardown without a switch target — see its docstring.
//
// No confirm-discard dialog: `vault_lock()`'s `flushIfDirty` already
// persists any unsaved edit before the keys zeroize (the canonical
// flush-on-lock, `decisions.md` 2026-05-07 — the same one the editor Lock
// button relies on). So a switch never silently drops an edit and never
// needs a "you have unsaved changes" prompt.

import { clearAgentForLock } from "../notes/agent/agentStore";
import { clearAiOutput } from "../notes/ai/aiOutputStore";
import { clearChat } from "../notes/ai/chatStore";
import { resetSessionIgnored } from "../editor/decorations/spell";
import { resetScrollMemory } from "../notes/scrollMemory";
import { resetRecentNotes } from "../notes/recentNotes";
import { resetDecodedAspects } from "../editor/attachments/decoded-aspect";
import {
  resetPreviewCache,
  resetTranscripts,
} from "../editor/attachments/session-caches";
import { flushGraphLayoutNow } from "../notes/graphLayoutPersist";
import type { Action, VaultId } from "./stage";
import { lockVault } from "./vault-unlock";

/**
 * Side effects + dispatch threaded in by the caller (App.tsx). Kept as a
 * narrow interface so the orchestration is unit-reasonable and the React
 * wiring (the `saving…` boolean + the Stage `dispatch`) stays in App.tsx.
 */
export interface SwitchVaultDeps {
  /**
   * Fired with `true` while the `vault_lock()` IPC is in flight (the brief
   * "saving…" window during which the prior vault's pending edit is flushed
   * and its slot torn down), then `false` once the lock resolves/rejects and
   * the Stage transition is dispatched. App.tsx renders the transient
   * "saving…" affordance off this boolean.
   */
  onSavingChange: (saving: boolean) => void;
  /**
   * Stage dispatch (App.tsx's `dispatch`). On a successful lock, called with
   * `{ type: "editor.switch-vault", vaultId }` → `unlock(Exists, vaultId)`
   * for the target.
   */
  dispatch: (action: Action) => void;
}

/**
 * Leave the active (sole `Unlocked`) vault: flush what this side owns, then
 * fire the param-less `vault_lock()` (four-surface teardown + `flushIfDirty`,
 * SYNC-8) and clear the module-level session-ignore spell set.
 *
 * Split out of [`switchVault`] because a switch is not the only exit that has
 * to tear the active vault down before another one unlocks. The device-join
 * door reached from the editor's account-chip switcher (myne#221) is the other:
 * `sync_join_account` bootstraps AND unlocks a different vault, and SYNC-1
 * (`set_unlocked_locking_others`) zeroizes this one on the way — so the editor
 * has to be gone before the join runs, exactly as it is before a switch.
 *
 * Best-effort on the lock's error path, for the reason [`switchVault`]'s
 * docstring gives: the backend teardown runs zeroize-before-anything, so the
 * caller routes onward regardless.
 */
export async function leaveActiveVault(deps: {
  onSavingChange: (saving: boolean) => void;
}): Promise<void> {
  const { onSavingChange } = deps;
  onSavingChange(true);
  try {
    // Persist the current graph layout to the ACTIVE (still-unlocked) vault
    // before locking it — this path bypasses the Editor graceful-teardown trio,
    // so it needs its own flush (best-effort, mirrors the trio's flushes).
    await flushGraphLayoutNow();
    // Param-less lock = "lock the sole unlocked (active) vault" (SYNC-8).
    // Its `flushIfDirty` covers unsaved edits — no confirm-discard dialog.
    await lockVault();
  } catch (err) {
    // Best-effort: the caller routes on anyway (see docstring). Surface to the
    // dev console so a genuinely broken lock IPC isn't silent.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[leaveActiveVault] vault_lock rejected; routing on anyway:", err);
    }
  } finally {
    onSavingChange(false);
  }
  // Vault change: clear the editor's module-level session-ignore spell set so
  // "ignore this session" words from the prior vault don't suppress squiggles in
  // the target vault.
  resetSessionIgnored();
  // And the agent run's frontend state, for the stronger version of the same
  // reason. `proposal.edits` holds anchors and replacements copied VERBATIM out
  // of the previous vault's note bodies, the store is module scope, and this
  // path does not reload the WebView, so without this they stay resident into
  // the next vault's session. The host drops its half through
  // `teardown_on_lock` on the `lockVault()` above; this is the WebView half,
  // and `decisions/ai/0515` rests its "nothing survives a lock" claim on both.
  clearAgentForLock();
  // And the chat transcript, for the reason that is specific to a CHANGE: the
  // questions and answers describe the vault being left, so carrying them into
  // the next one would show a second vault a first vault's conversation. The
  // `lockVault()` above clears it too; this path is asserted separately because
  // a later refactor could stop routing through that call without anything
  // noticing (`scripts/check-frontend-lock-teardown.mjs`).
  clearChat();
  // The rendered AI output, on the same reasoning: a summary of a note in the
  // vault being left, and the Q and A answers over its content, are as
  // vault-specific as the conversation above.
  clearAiOutput();
  // The per-note scroll positions and the picker's recency order, on the same
  // reasoning one step weaker: both are keyed by note id, so the next vault
  // would not READ either of them, but both are a live record of what the vault
  // being left contains and what was opened in it. The `lockVault()` above
  // clears them too; asserted here for the same reason as the two calls above.
  resetScrollMemory();
  resetRecentNotes();
  // And the decoded image shapes, which enumerate every attachment this vault
  // rendered: an attachment-id key with a value derived from decrypted content
  // has no business surviving into a different vault's session.
  resetDecodedAspects();
  // And the two that hold the decrypted content itself: cached file previews
  // and completed voice-note transcripts. Carrying either into a DIFFERENT
  // vault's session is wider than what `docs/threat-model.md` AS7 records for
  // this surface, which is the whole reason a switch clears rather than trusts
  // an unmount.
  resetPreviewCache();
  resetTranscripts();
}

/**
 * Switch from the active (sole `Unlocked`) vault to `targetVaultId`:
 * lock the current vault (param-less `vault_lock()` — four-surface teardown
 * + `flushIfDirty`), then route to the target's unlock screen via the
 * `editor.switch-vault` Stage action.
 *
 * The lock IPC is best-effort on its error path: even if `vault_lock()`
 * rejects, the slot is left in a defined state by the backend (the teardown
 * runs zeroize-before-anything), and the Stage still routes to the target's
 * unlock screen — the worst case is the user re-types the target password on
 * an already-locked prior vault, which is the desired end state anyway. This
 * mirrors the editor Lock button's "lock is best-effort, route regardless"
 * posture (`Editor.tsx::handleLockFlushed`).
 *
 * Returns once the lock IPC settles and the Stage action has been
 * dispatched. The target's actual unlock (Argon2id + IPC) happens later on
 * the Unlock screen, so this promise resolving does NOT mean the target is
 * unlocked — only that the prior vault is torn down and the route is set.
 */
export async function switchVault(
  targetVaultId: VaultId,
  deps: SwitchVaultDeps,
): Promise<void> {
  const { onSavingChange, dispatch } = deps;
  await leaveActiveVault({ onSavingChange });

  // Route to the target's unlock screen carrying its VaultId (SYNC-6). The
  // password entry + vault-addressed unlock IPC happen on the Unlock screen.
  dispatch({ type: "editor.switch-vault", vaultId: targetVaultId });
}
