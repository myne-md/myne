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

import { invoke } from "../platform/core";
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
 * The id of the ONLY vault on this device, or `null` when there are zero or
 * two-plus (#250).
 *
 * The pre-unlock delete surfaces (`Unlock`, `VaultRecover`) run with no
 * unlocked slot, so {@link activeVaultId} has nothing to report — the disk list
 * is the only source. They normally receive the chosen vault's id from the
 * stage; this covers the single-vault entry that carries none. Returning `null`
 * at ≥2 is the point: "delete the vault" is ambiguous there, and picking one
 * silently is exactly the class of guess #250 removes.
 */
export async function soleVaultId(): Promise<string | null> {
  const res = await listVaults();
  if (!("ok" in res) || res.ok.length !== 1) return null;
  return res.ok[0].id;
}

/**
 * The AUTHORITATIVE active vault id, read from the runtime slot map (#250).
 *
 * This replaces `resolveActiveVaultId()`, which answered the same question by
 * ordering `listVaults()` on `last_unlock` and taking the head. That ordering
 * reads the non-authoritative `registry.json` cache, and the cache was stamped
 * by the password-unlock path only — so after a quick-unlock or a recovery it
 * named a *different* vault than the one actually open, while three consumers
 * (the danger-zone delete, the backup scheduler, the Settings schedule block)
 * treated its answer as fact.
 *
 * `null` means no vault is unlocked. Callers must treat that as "no target" —
 * never as "use whichever one looks most recent". Prefer threading the id you
 * already hold (`stage.vaultId`) over calling this; it exists for the surfaces
 * that genuinely cannot receive it, such as a post-reload editor mount.
 */
export async function activeVaultId(): Promise<string | null> {
  try {
    return (
      (await invoke<string | null>("plugin:vault-unlock|vault_active_id")) ??
      null
    );
  } catch {
    // A refused/failed probe is "unknown", which is the same instruction as
    // "no vault": do not act on a guess.
    return null;
  }
}
