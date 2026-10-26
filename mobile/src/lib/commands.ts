import { invoke } from "../platform/core";

/**
 * Invoke wrappers the desktop calls inline inside its screen components (so
 * there is no desktop lib file to copy): vault-creation begin/commit/cancel and
 * the password unlock command. Arg shapes mirror the desktop verbatim
 * (`src/screens/CreateVault.tsx`).
 */

export interface BeginResult {
  /**
   * 24 BIP-39 words, in order, or `null` when the vault is born under a person
   * identity (myne-md/myne#911 task 5). That generation retires the vault
   * phrase, so the identity phrase is the only recovery credential.
   */
  phrase: string[] | null;
  /** Display-form account number, e.g. "MY-4F2A-9C17-8E2D-1B5F-K". */
  account_number: string;
  /** Opaque session token scoped to this creation session. */
  session_token: string;
}

/** Begin a vault-creation session — derives keys, mints account number + phrase. */
export function beginVaultCreation(password: string): Promise<BeginResult> {
  return invoke<BeginResult>("plugin:vault-creation|begin", { password });
}

/** Commit the session to disk. Returns the new vault id (null on legacy path). */
export function commitVaultCreation(sessionToken: string): Promise<string | null> {
  return invoke<string | null>("plugin:vault-creation|commit", { sessionToken });
}

/** Drop a vault-creation session (best-effort cancel). */
export function cancelVaultCreation(sessionToken: string): Promise<void> {
  return invoke("plugin:vault-creation|cancel", { sessionToken });
}

/** Unlock a vault with its master password (vaultId omitted = sole/active vault). */
export function unlockWithPassword(password: string, vaultId?: string | null): Promise<void> {
  return invoke("plugin:vault-unlock|unlock", { password, vaultId: vaultId ?? null });
}
