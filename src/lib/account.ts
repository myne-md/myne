// The device-local account record (the account/vault split, myne-md/myne#684):
// the types the backend answers with, the narrowing that reads its error tag,
// and the three command wrappers.
//
// The record itself is `myne_core::account`. Nothing here carries user-authored
// text: an account has no name (`design-notes/ui/0728`), so the only values
// that cross are hex account ids and vault ids, and the heading a surface draws
// for a group is derived from that group's own vault names.

import { invoke } from "../platform/core";

/** Mirrors `myne_core::account::commands::AccountView`. */
export interface AccountView {
  /** The account id, hex-encoded (32 hex chars). */
  id: string;
  /** The member vault ids, canonical 36-char strings. */
  vaults: string[];
}

/** Mirrors `myne_core::account::commands::AccountCommandError`'s `kind` tag. */
export type AccountCommandErrorKind =
  | "Io"
  | "KeychainUnavailable"
  | "VaultNotFound"
  | "Backend"
  | "Hidden"
  | "RecordUnreadable"
  | "Locked";

/** Narrow an unknown thrown value to the backend error's `kind` tag. */
export function accountCommandErrorKind(e: unknown): AccountCommandErrorKind | null {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return kind === "Io" ||
    kind === "KeychainUnavailable" ||
    kind === "VaultNotFound" ||
    kind === "Backend" ||
    kind === "Hidden" ||
    kind === "RecordUnreadable" ||
    kind === "Locked"
    ? kind
    : null;
}

/** List the account grouping. Empty when there is no account (no vaults, or no
 *  keychain), which is the standalone state. */
export async function listAccounts(): Promise<AccountView[]> {
  return invoke<AccountView[]>("plugin:account|account_list");
}

/** Move `vaultId` into the account owning `targetVaultId`. */
export async function moveVault(vaultId: string, targetVaultId: string): Promise<AccountView[]> {
  return invoke<AccountView[]>("plugin:account|account_move", { vaultId, targetVaultId });
}

/** Split `vaultId` into a fresh account. */
export async function splitVault(vaultId: string): Promise<AccountView[]> {
  return invoke<AccountView[]>("plugin:account|account_split", { vaultId });
}

/**
 * The account id a vault belongs to, or `null` when the vault is not a member
 * of any account (the standalone state, or a keychain-less device). The
 * account/vault split (myne-md/myne#684): grouping is a per-device
 * organisational choice, so this reads the device-local record, never the
 * vault's own membership field.
 */
export function accountIdForVault(
  accounts: readonly AccountView[],
  vaultId: string,
): string | null {
  for (const account of accounts) {
    if (account.vaults.includes(vaultId)) return account.id;
  }
  return null;
}

/**
 * The heading a surface draws for an account: the names of the vaults it holds,
 * joined. An account has no name of its own (`design-notes/ui/0728`), and this
 * is the replacement: a group is identified by what is inside it, so a picker
 * cannot show two groups under one invented label.
 *
 * `nameOf` resolves ONE vault id to its display name, and returning `null` for
 * an id it cannot name (a vault the list failed to enumerate) drops that name
 * rather than rendering a placeholder inside the heading. `fallback` is what is
 * left when nothing could be named at all.
 */
export function accountHeading(
  account: AccountView,
  nameOf: (vaultId: string) => string | null,
  fallback: string,
): string {
  const names = account.vaults
    .map((id) => nameOf(id))
    .filter((name): name is string => name !== null && name !== "");
  return names.length === 0 ? fallback : names.join(" · ");
}

/** One grouped row of vaults: the owning account, or `null` for standalone
 *  vaults (no account), which form a trailing header-less group. */
export interface AccountGroup<V> {
  account: AccountView | null;
  vaults: V[];
}

/**
 * Group the ordered vault list by account, preserving the last-unlock order
 * within each group and the account order by first appearance. The single
 * implementation every picker shares (desktop, recovery select, mobile), so
 * grouping cannot drift per surface.
 */
export function groupVaultsByAccount<V extends { id: string }>(
  vaults: readonly V[],
  accounts: readonly AccountView[],
): AccountGroup<V>[] {
  const byAccount = new Map<string | null, V[]>();
  for (const vault of vaults) {
    const accountId = accountIdForVault(accounts, vault.id);
    const list = byAccount.get(accountId) ?? [];
    list.push(vault);
    byAccount.set(accountId, list);
  }
  const order: (string | null)[] = [];
  for (const vault of vaults) {
    const accountId = accountIdForVault(accounts, vault.id);
    if (!order.includes(accountId)) order.push(accountId);
  }
  return order.map((accountId) => ({
    account: accounts.find((a) => a.id === accountId) ?? null,
    vaults: byAccount.get(accountId) ?? [],
  }));
}
