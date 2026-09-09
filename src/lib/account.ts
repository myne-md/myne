// The device-local account record (the account/vault split, myne-md/myne#684):
// the types the backend answers with, the narrowing that reads its error tag,
// and the four command wrappers.
//
// The record itself is `myne_core::account`. Nothing here reads or writes a
// label in the clear: the only values that cross are the account label (the
// user's own text) and vault ids.

import { invoke } from "../platform/core";

/** Mirrors `myne_core::account::commands::AccountView`. */
export interface AccountView {
  /** The account id, hex-encoded (32 hex chars). */
  id: string;
  /** The account label (empty means unlabelled). */
  label: string;
  /** The member vault ids, canonical 36-char strings. */
  vaults: string[];
}

/** Mirrors `myne_core::account::commands::AccountCommandError`'s `kind` tag. */
export type AccountCommandErrorKind =
  | "Io"
  | "KeychainUnavailable"
  | "VaultNotFound"
  | "Backend"
  | "LabelTooLong"
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
    kind === "LabelTooLong" ||
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

/** Rename the account owning `vaultId`. */
export async function renameAccount(vaultId: string, label: string): Promise<AccountView> {
  return invoke<AccountView>("plugin:account|account_rename", { vaultId, label });
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
 * Truncate a label draft to a UTF-8 byte cap without splitting a character.
 * The backend enforces `ACCOUNT_LABEL_MAX_LEN` in bytes while inputs count in
 * characters, so a multibyte draft can pass `maxLength` and still trip
 * `LabelTooLong`: truncating on input keeps the two in agreement.
 */
export function truncateLabelToBytes(draft: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let bytes = 0;
  let end = 0;
  for (const ch of draft) {
    const len = encoder.encode(ch).length;
    if (bytes + len > maxBytes) break;
    bytes += len;
    end += ch.length;
  }
  return draft.slice(0, end);
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
