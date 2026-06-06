// Tauri IPC wrappers for the `vault-repair` plugin (MYND-159).
//
// In-app cleanup of orphan vault artefacts left under
// `<app_data_dir>/vault/` by a partial-fail `vault_delete`. Two commands:
//
//   - `vaultResidueScan()` — read-only count of residue entries. Pure read
//     (no `auth_permits`, no side effect — uses the non-creating path
//     resolver). Drives the Welcome repair banner's count. Only ever
//     rejects with the `Io` variant.
//   - `vaultRepair()` — the gate-free sweep. Proceeds only when slot Empty
//     + `vault.meta` byte-absent + residue present; returns the count of
//     entries removed. Rejects `VaultPresent` (a live vault — refuses to
//     bypass `vault_delete`'s typed-DELETE gate), `NothingToRepair`,
//     `VaultBusyAuth`, or `PartialDelete { remaining_count }`.
//
// Capability ACL `vault-repair:default` is in
// `src-tauri/capabilities/default.json`.

import { invoke } from "@tauri-apps/api/core";

export type { VaultRepairError } from "../types/vault-repair-error";
export { isVaultRepairPartial } from "../types/vault-repair-error";

/**
 * Read-only count of orphan residue under the vault directory. Returns 0
 * when the directory is absent or empty. Safe to call on any boot where
 * `vault.meta` is missing (Welcome stage) — it never mutates or creates.
 *
 * Rejects only with `{ kind: "Io" }` (rare `app_data_dir` lookup failure).
 */
export async function vaultResidueScan(): Promise<number> {
  return await invoke<number>("plugin:vault-repair|vault_residue_scan");
}

/**
 * Sweep orphan residue. Returns the count of entries removed on success.
 * Rejects with a {@link VaultRepairError} variant on each failure mode —
 * the caller maps `PartialDelete` to the manual-cleanup fallback and
 * `VaultPresent` / `NothingToRepair` to bug-canary handling (these should
 * not surface in the normal Welcome → repair flow).
 */
export async function vaultRepair(): Promise<number> {
  return await invoke<number>("plugin:vault-repair|vault_repair");
}
