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
// No confirm-discard dialog: `vault_lock()`'s `flushIfDirty` already
// persists any unsaved edit before the keys zeroize (the canonical
// flush-on-lock, `decisions.md` 2026-05-07 — the same one the editor Lock
// button relies on). So a switch never silently drops an edit and never
// needs a "you have unsaved changes" prompt.

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
  onSavingChange(true);
  try {
    // Param-less lock = "lock the sole unlocked (active) vault" (SYNC-8).
    // Its `flushIfDirty` covers unsaved edits — no confirm-discard dialog.
    await lockVault("switch");
  } catch (err) {
    // Best-effort: route to the target anyway (see docstring). Surface to
    // the dev console so a genuinely broken lock IPC isn't silent.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[switchVault] vault_lock rejected; routing to target anyway:", err);
    }
  } finally {
    onSavingChange(false);
  }
  // Route to the target's unlock screen carrying its VaultId (SYNC-6). The
  // password entry + vault-addressed unlock IPC happen on the Unlock screen.
  dispatch({ type: "editor.switch-vault", vaultId: targetVaultId });
}
