// What a vault is CALLED on screen, in one place (myne-md/myne#773).
//
// ── Why this is not a helper inside the picker ─────────────────────────────
// It was: `rowLabel` lived in `VaultPicker.tsx` and was the only surface that
// needed it. The unlock screen is the second — it names the vault it is about
// to open in its own heading rather than asking for "your vault" — and two
// copies of "what is this vault called" is how a vault ends up named one
// thing in the picker and something else on the screen you reach by clicking
// it.
//
// ── The fallback is the interesting half ───────────────────────────────────
// `VaultSummary.label` is `null` for a vault this session has not unlocked,
// which on a cold unlock screen is the ordinary case — and it is `null` again
// when the device-local "hide vault names" option is on, because that option
// erases the stored name at the source rather than filtering it here. So the
// fallback is not an edge: it is what most users will read, and it must
// surface no vault-identifying string.
//
// Its N is STABLE per vault rather than positional (`stableVaultNumber`), so
// the name a user is asked to remember does not move when they open a
// different vault.

import { stableVaultNumber } from "./vault-list";
import type { VaultSummary } from "../types/vault-summary";

/** The name a vault shows on screen, or its neutral fallback. */
export function vaultDisplayName(
  vault: VaultSummary,
  vaults: readonly VaultSummary[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return (
    vault.label ??
    t("vaultPicker.vaultFallback", { n: stableVaultNumber(vaults, vault.id) })
  );
}

/**
 * The same, by id, for a caller that holds one and the list.
 *
 * `null` when the id names no vault in the list — which is a real state, not a
 * defensive branch: the unlock screen reaches the sole-vault `None` path with
 * no `vaultId` at all, and a list that failed to load is empty. A caller that
 * gets `null` says "your vault" rather than inventing a number.
 */
export function vaultDisplayNameById(
  id: string | null | undefined,
  vaults: readonly VaultSummary[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (id == null) return null;
  const vault = vaults.find((v) => v.id === id);
  return vault === undefined ? null : vaultDisplayName(vault, vaults, t);
}
