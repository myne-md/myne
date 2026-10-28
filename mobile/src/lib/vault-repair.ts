// Tauri IPC wrappers for the `vault-repair` plugin (MYND-159) — mobile port of
// the desktop plugin. In-app cleanup of orphan vault residue left by a
// partial-fail `vault_delete`. Two commands:
//
//   - `vaultResidueScan()` — read-only report of every vault root under
//     `<app_data_dir>` that still holds entries (0 roots on a clean device).
//     Drives a repair banner on the Welcome screen. Takes no auth_permits,
//     mutates nothing.
//   - `vaultRepair()` — one-shot gate-free sweep over every REPAIRABLE root;
//     resolves to the number of entries removed. Proceeds only on (slot Empty +
//     no `vault.meta` in that root + residue present), rejects `VaultPresent`
//     for a root that still carries a `vault.meta`, so it can never bypass
//     `vault_delete`'s typed-DELETE gate. Rejects `NothingToRepair` on a clean
//     device and surfaces `PartialDelete { remaining_count }` on a file-lock.
//
// Capability ACL `vault-repair:default` is in
// `src-tauri/capabilities/default.json`; the commands are declared as an
// `InlinedPlugin` in `build.rs`.

import { invoke } from "../platform/core";
import type { VaultRepairError } from "../types/vault-repair-error";

/**
 * One vault root that still holds something on disk.
 *
 * **`hasVaultMeta` decides which button the caller may show, and it is the
 * reason this is a report rather than a count.** A root carrying `vault.meta`
 * is refused by `vaultRepair` by design (it may be somebody's vault, so only
 * `vault_delete`'s typed-DELETE gate may destroy it). A count alone cannot say
 * that, so a banner built on a count offers "clean up" for a root that is
 * structurally un-cleanable and the user gets "couldn't finish cleaning up"
 * every single time, with no way to tell that retrying will never work.
 *
 * `vaultId` is the id the root is addressable by, so the gated case can be
 * routed to `deleteVault(vaultId)`. It is the fixed legacy sentinel for a
 * pre-migration `<app_data_dir>/vault/` root, which
 * `vault_root_for_id_from_base` resolves back to that directory.
 */
export interface ResidueRoot {
  vaultId: string;
  /** Recursive entry count under the root. */
  entries: number;
  /** `vault.meta` byte-present ⇒ `vault_delete`'s territory, never the sweep. */
  hasVaultMeta: boolean;
}

/** Report every vault root that still holds entries (empty array when clean). */
export async function vaultResidueScan(): Promise<ResidueRoot[]> {
  return await invoke<ResidueRoot[]>("plugin:vault-repair|vault_residue_scan");
}

/** Sweep every repairable residue root; resolves to the count removed. Rejects
 *  with a {@link VaultRepairError} (e.g. `NothingToRepair`, `PartialDelete`,
 *  `VaultPresent` when nothing repairable is left). */
export async function vaultRepair(): Promise<number> {
  return await invoke<number>("plugin:vault-repair|vault_repair");
}

export type { VaultRepairError };
