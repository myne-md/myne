// Tauri IPC wrappers for the `vault-repair` plugin (MYND-159) — mobile port of
// the desktop plugin. In-app cleanup of orphan vault residue left by a
// partial-fail `vault_delete`. Two commands:
//
//   - `vaultResidueScan()` — read-only count of orphan artefacts under
//     `<app_data_dir>/vault/` (0 when clean). Drives a repair banner on the
//     Welcome screen. Takes no auth_permits, mutates nothing.
//   - `vaultRepair()` — one-shot gate-free sweep; resolves to the number of
//     entries removed. Proceeds only on (slot Empty + vault.meta byte-absent +
//     residue); rejects `VaultPresent` for a live vault, so it can never bypass
//     `vault_delete`'s typed-DELETE gate. Rejects `NothingToRepair` on a clean
//     device and surfaces `PartialDelete { remaining_count }` on a file-lock.
//
// Capability ACL `vault-repair:default` is in
// `src-tauri/capabilities/default.json`; the commands are declared as an
// `InlinedPlugin` in `build.rs`.

import { invoke } from "../platform/core";
import type { VaultRepairError } from "../types/vault-repair-error";

/** Count orphan residue under the vault directory (0 when clean/absent). */
export async function vaultResidueScan(): Promise<number> {
  return await invoke<number>("plugin:vault-repair|vault_residue_scan");
}

/** Sweep orphan residue; resolves to the count removed. Rejects with a
 *  {@link VaultRepairError} (e.g. `NothingToRepair`, `PartialDelete`). */
export async function vaultRepair(): Promise<number> {
  return await invoke<number>("plugin:vault-repair|vault_repair");
}

export type { VaultRepairError };
