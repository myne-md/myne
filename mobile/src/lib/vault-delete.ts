// Tauri IPC wrapper for the `vault-delete` plugin's `vault_delete`
// command (MYND-105 backend, MYND-108 + MYND-108-bis frontend consumers).
//
// One-shot vault destruction across three accepted Slot preconditions:
//
//   - `Slot::Unlocked` / `Slot::Recovering` — backend zeroizes
//     in-memory keys via `state.take()` (Drop on the moved-out
//     variant fires BEFORE any filesystem op), then recursively
//     unlinks `<app_data_dir>/vault/`. Same crypto-erase ordering
//     as MYND-105 ship.
//   - `Slot::Empty` + `vault.meta` exists on disk (MYND-108-bis,
//     `decisions.md` 2026-05-26 "MYND-108-bis vault_delete extended
//     to accept Slot::Empty + vault.meta-exists") — no in-memory
//     keys to zeroize (the user has lost both password and recovery
//     phrase); backend skips `state.take()` and runs the recursive
//     unlink directly. Cryptographic-erase claim is structurally
//     inapplicable on this arm; the on-disk Argon2id-wrapped keys
//     are already computationally unrecoverable.
//
// Returns `Ok(())` on full success; rejects with a `VaultDeleteError`
// variant on each failure mode (see `src/types/vault-delete-error.ts`).
// `VaultNotUnlocked` is retained in the wire format for forward
// compatibility but becomes unreachable from current backend code paths.
//
// **Frontend contract (loosened by MYND-108-bis):** caller MAY
// pre-`vault_lock` if they wish — the resulting `Slot::Empty +
// vault.meta-exists` state falls into the new accept path with the
// same end-to-end crypto-erase property (the racing `vault_lock`'s
// zeroize fires before the recursive unlink). The MYND-105 era
// contract that read "MUST NOT pre-lock" is loosened by the
// `decisions.md` 2026-05-26 "MYND-108-bis" entry.
//
// Capability ACL `vault-delete:default` is already in
// `src-tauri/capabilities/default.json` (shipped with MYND-105
// `backend-vault-delete`). No ACL change required for MYND-108 or
// MYND-108-bis.

import { invoke } from "../platform/core";
import { resetDateTimeDisplayForLock } from "@myne/editor/host/lib/datetimeFormat";
import { clearAwareness } from "@myne/awareness-store";

export type {
  VaultDeleteError,
} from "../types/vault-delete-error";
export {
  isPartialDeleteError,
  isVaultDeleteIoError,
} from "../types/vault-delete-error";

// The delete-error MAPPING is deliberately not here (myne-md/myne#476).
//
// This module used to carry a 110-line copy of desktop's
// `mapDeleteVaultError` plus its two payload types and its `assertNever` arm,
// with ZERO callers on this client. Its own docstring named the three consumers
//, AccountPanel, Unlock, VaultRecover, and all three are desktop components
// that do not exist here, so a reader comparing the two trees would have
// concluded mobile maps its delete errors. It does not: both mobile delete
// surfaces catch and show one generic message.
//
// That gap is real and is recorded rather than papered over by an uncalled
// function. Closing it means giving this client a `vaultDirDisplayPath`
// equivalent as well, desktop's mapping carries a resolved vault path into the
// partial-fail banner, and mobile has no such resolver, which is a change to
// this surface's error UX rather than to vault targeting, and belongs with
// whoever makes it.

/**
 * Destroy the current vault.
 *
 * **Pre-conditions** (caller responsibility, enforced by call-site
 * gating in AccountPanel / Unlock / VaultRecover sub-views):
 *   - `Slot::Unlocked`, `Slot::Recovering`, OR `Slot::Empty +
 *     vault.meta-exists` (MYND-108-bis)
 *   - No other auth-pipeline op in flight (no concurrent
 *     vault_unlock / vault_recover / vault_complete_recovery /
 *     vault_change_password)
 *   - User has explicitly typed `DELETE` and clicked the brick-danger
 *     Submit (per the MYND-108 confirmation gate)
 *
 * **Post-condition on resolve:** `Slot::Empty` + `<app_data_dir>/vault/`
 * recursively removed (modulo the per-file partial-fail surface).
 * Caller fires `onDeleteVaultSuccess`, which the shell wires to `reprobe()`
 * (#45). Boot routing then picks the return surface by REMAINING vault count —
 * picker at ≥2, that vault's unlock at 1, welcome at 0. It used to dispatch one
 * of three `*.delete-vault-success` actions that all transitioned to `welcome`,
 * which stranded a multi-vault user on the first-run screen with every other
 * vault invisible.
 *
 * Slot stays Empty regardless of resolve vs reject — on the
 * Unlocked/Recovering arms the zeroize fires before unlink; on the
 * Empty + meta-exists arm the slot was already Empty entering the
 * call.
 *
 * **Rejection paths** (see `VaultDeleteError` for the full taxonomy):
 *   - `PartialDelete { remaining_count }`, real user-facing scenario (AV
 *     scanner / Spotlight / OneDrive sync file lock).
 *   - `Io { io_error_kind }` — rare pre-walk filesystem failure.
 *   - `VaultBusyAuth` / `VaultNotUnlocked` / `VaultNotFound`, UI/router bug
 *     indicators. `VaultNotUnlocked` is unreachable from current backend paths
 *     but retained in the wire format for forward compatibility.
 *
 * **What this client DOES with them, said plainly**: both delete surfaces catch
 * and show one generic message. The paragraph that stood here described
 * desktop's behaviour, a post-fail banner carrying the count and the vault
 * path, a Continue affordance, `mapDeleteVaultError` returning a bug-canary,
 * which is exactly the misreading the note above the `deleteVault` declaration
 * says the deleted copy was causing, restated in this module's own API doc. The
 * gap is real and open; see that note for what closing it costs.
 */
export async function deleteVault(vaultId: string): Promise<void> {
  // SYNC-6 explicit-id targeting (MYND-205), REQUIRED since myne-md/myne#476:
  // pass the chosen vault's canonical hyphenated `VaultId` string to erase
  // exactly `vaults/<id>/`, leaving any sibling vault untouched.
  //
  // The parameter used to be optional here, and the comment that stood in this
  // place described a fallback that does not exist: it said omitting the id
  // "falls back to the active (sole `Unlocked`) vault … which keeps the
  // pre-multi-vault single-vault callers working unchanged". This client
  // registers `myne_core::plugins::vault_delete::commands`, whose Tauri
  // signature is `vault_id: String`, non-optional, #250 removed the optional
  // target on the Rust side because THE FALLBACK WAS THE BUG, and
  // `core/src/plugins/vault_delete/commands.rs` says so in those words. So
  // `deleteVault(undefined)` was never a fallback; it was a deserialization
  // rejection wearing a reassuring comment. Making the parameter required moves
  // that to compile time, which is why the type is `string` and not
  // `string | undefined`.
  // The ambient date/time DISPLAY store, on the one leaving path that does not
  // go through `lockVault`. It is module scope in `@myne/editor` and holds the
  // formats and TIME ZONE derived from the prefs of the vault being ERASED, and
  // this path leaves the editor without advancing the prefs nonce, so nothing
  // republishes and the deleted vault's values stay resident for the rest of the
  // process (myne-md/myne#609, found in review).
  resetDateTimeDisplayForLock();
  // The live-presence store, on the same leg and for the same reason (myne-md/myne#849
  // task 9): it is module scope in the shared `@myne/awareness-store`, and this is the
  // one leaving path that does not go through `lockVault`, so without this the erased
  // vault's peers (names, carets, selections) stay resident for the rest of the
  // process. `scripts/check-frontend-lock-teardown.mjs` asserts this call by name.
  clearAwareness();
  await invoke<void>("plugin:vault-delete|vault_delete", { vaultId });
}
