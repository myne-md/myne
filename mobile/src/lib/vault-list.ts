// Tauri IPC wrapper for `vault_list` (read-mostly multi-vault enumeration).
//
// The Rust command lives at `plugin:vault-unlock|vault_list` (see
// `src-tauri/src/plugins/vault_unlock/commands.rs`); permission entry in
// `src-tauri/permissions/vault-unlock/default.toml` (`allow-vault-list`)
// allows it via the existing `vault-unlock:default` capability.
//
// `vault_list` is the SYNC-4 multi-vault generalization of `vault_status`:
// it returns one `VaultSummary` per discovered `vaults/<id>/` directory. A
// downstream picker (sub-feature 3) consumes this list (plus the runtime slot
// map) to route boot. It returns only DENY-list-clean fields — no
// `account_number_hash` bytes, no filesystem paths.
//
// `invoke` throws on Err — we catch + normalize into a discriminated union so
// callers can `switch` over a single shape. The probe is read-mostly and
// idempotent-in-effect: a disk-scan plus a best-effort registry read that may
// transparently rebuild the non-authoritative `registry.json` cache when it is
// missing/stale (the rebuild is swallowed; discovery never depends on it).

import { invoke } from "@tauri-apps/api/core";
import type {
  VaultListError,
  VaultListResult,
  VaultSummary,
} from "../types/vault-summary";

/**
 * Enumerate every discovered vault under `<app_data_dir>/vaults/`.
 *
 * Caller pattern:
 * ```ts
 * const result = await listVaults();
 * if ("ok" in result) {
 *   // result.ok: VaultSummary[]
 * } else {
 *   // result.err: VaultListError
 * }
 * ```
 */
export async function listVaults(): Promise<VaultListResult> {
  try {
    const ok = await invoke<VaultSummary[]>("plugin:vault-unlock|vault_list");
    return { ok };
  } catch (raw) {
    return { err: raw as VaultListError };
  }
}

/**
 * Order vaults by last-unlock, most-recent first (SYNC-7) — the canonical
 * ordering shared by the boot picker, the in-app switcher dropdown, and the
 * Settings active-vault resolution. A vault with no `last_unlock` (never
 * unlocked) sorts after every dated vault (treated as -∞ on the recency axis);
 * ties break on `id` for a stable, deterministic order. Pure — does not mutate
 * its input.
 */
export function orderByLastUnlock(vaults: VaultSummary[]): VaultSummary[] {
  return [...vaults].sort((a, b) => {
    const av = a.last_unlock ?? -Infinity;
    const bv = b.last_unlock ?? -Infinity;
    if (av !== bv) return bv - av; // descending → most-recent first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The stable per-vault number behind the `Vault N` fallback (myne-md/myne#411).
 * Twin of `src/lib/vault-list.ts::stableVaultNumber` in the desktop tree, and
 * the two must not drift: a vault that reads `Vault 2` on the phone and
 * `Vault 3` on the laptop is worse than the defect this replaces.
 *
 * **The rule.** N is the vault's 1-based rank in the ascending `VaultId` order
 * of the vaults on this device. It is a function of the SET, not of the array's
 * order, so every caller may keep rendering in whatever order suits it.
 *
 * **Why a rank and not a hash.** The number is the name a user is asked to
 * remember for a vault whose real name this device cannot read, so two things
 * have to hold: it must not move as the app is used, and two vaults must never
 * land on the same one. A rank over a set of distinct ids gives the second by
 * construction, because it is an injection. A hash of the `VaultId` folded into
 * a small range gives it only probabilistically, and would need a tie-break
 * that changes one vault's number to resolve the collision anyway. It also
 * produces `Vault 47` beside `Vault 3`, which reads as an identifier rather
 * than as a name. The rank keeps 1..n, dense, exactly as the old positional
 * numbers looked.
 *
 * **What it is NOT stable against, said plainly.** A change to the set. A newly
 * created vault gets a UUIDv7, which sorts after every existing one, so
 * creating a vault appends and renumbers nobody; DELETING one shifts the vaults
 * that sort after it down by one. That is the honest cost, and it is the right
 * trade: deletion is rare, deliberate and already irreversible, while unlocking
 * a vault is the single most common thing a user does here and used to renumber
 * every row on the screen.
 *
 * Total by construction: an id absent from the list still gets a number.
 */
export function stableVaultNumber(
  vaults: readonly VaultSummary[],
  id: string,
): number {
  let rank = 1;
  for (const v of vaults) if (v.id < id) rank += 1;
  return rank;
}

/**
 * Resolve the active vault's id — the head of the canonical last-unlock
 * ordering (the same vault the boot picker / switcher treat as active under
 * SYNC-1). `null` when no vault is discoverable. Shared by the automatic-backup
 * scheduler ({@link ../hooks/useBackupScheduler}) and its Settings block.
 */
export async function resolveActiveVaultId(): Promise<string | null> {
  const res = await listVaults();
  if (!("ok" in res) || res.ok.length === 0) return null;
  return orderByLastUnlock(res.ok)[0].id;
}
