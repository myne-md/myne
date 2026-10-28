// Tauri IPC wrappers for the `vault-recover` plugin commands.
//
// **Phrase lifetime is best-effort on the JS side** per
// `recovery-flow.md` § 3.5: V8 strings are immutable and not
// zeroizable; the load-bearing zeroize is Rust-side via
// `Zeroizing<String>` (the plugin wraps the IPC argument on its
// first non-doc statement). The wrapper drops its closure-captured
// reference on resolve/reject so the JS heap allocation is GC-able.
//
// Callers (PhraseEntryStep, future PasswordResetStep) keep the
// password / phrase in component-local state and pass it directly
// to the wrapper at submit time — no module-level cache, no Tauri
// State payload that lingers across renders.

import { invoke } from "../platform/core";

/**
 * A8d — recover an existing vault with the user's BIP-39 24-word
 * recovery phrase. Phrase MUST already be NFKD-normalized + joined
 * with a single ASCII space per `protocol.md` § 7.4 (the Rust side
 * also normalizes defensively, but the wire shape is the
 * normalized form).
 *
 * Resolves `void` on success — the slot is now `Recovering` and
 * the chained `complete_recovery` (A8f) is the only valid next
 * IPC. Rejects with a `VaultRecoveryError` on any failure path
 * (see `src/types/vault-recovery-error.ts`).
 *
 * `vaultId` (multi-vault sub-feature 2 task 4 — SYNC-6 targeting) is an
 * optional canonical `VaultId` string: omitted → the sole-vault fallback
 * (current single-vault recovery flow); a string → recover exactly
 * `vaults/<id>/`. The recovery picker (sub-feature 5) passes the chosen id.
 */
export async function recoverWithPhrase(
  phrase: string,
  vaultId?: string,
): Promise<void> {
  await invoke<void>("plugin:vault-recover|recover_with_phrase", {
    vaultId,
    phrase,
  });
}

/**
 * Optional multi-vault recovery selector (MYND-206). Resolve a user-typed
 * account-number to the `VaultId` of the on-disk vault whose `vault.meta`
 * header `account_number_hash` matches.
 *
 * Resolves to the canonical `VaultId` string for the first matching vault, or
 * `null` for EVERY failure mode (malformed account-number OR no on-disk match)
 * — the single non-distinguishing result per `account-number.md` §5. The
 * caller cannot tell a typo from a no-match; both surface the same generic
 * "invalid account number" affordance. **Never required** — the account-number
 * is an optional jump-to-vault convenience; the 24-word phrase stays the sole
 * recovery secret (SYNC-12).
 *
 * Selection-only: the backend reads only the plaintext `account_number_hash`
 * header field — no decrypt, no unlock, no Argon2id, no `auth_permits`.
 */
export async function resolveVaultByAccountNumber(
  accountNumber: string,
): Promise<string | null> {
  return invoke<string | null>(
    "plugin:vault-recover|resolve_vault_by_account_number",
    { accountNumber },
  );
}

/**
 * A8f — chained password commit after a successful A8d. Promotes
 * `Slot::Recovering` → `Slot::Unlocked` by rewriting `vault.meta`'s
 * password side under the new master password (recovery-side bytes
 * preserved per `recovery-flow.md` § 4.4; atomic write per § 4.2).
 *
 * Resolves `void` on success — frontend navigates directly to the
 * editor; defensive `vault_status` round-trip would be paranoia
 * per `decisions.md` 2026-05-02.
 *
 * `vaultId` (multi-vault sub-feature 2 task 4 — SYNC-6 targeting) is an
 * optional canonical `VaultId` string: omitted → the sole-vault fallback;
 * a string → commit against exactly `vaults/<id>/`. The recovering vault is
 * the one the prior `recoverWithPhrase` targeted, so the same id is passed.
 */
export async function completeRecovery(
  newPassword: string,
  vaultId?: string,
): Promise<void> {
  await invoke<void>("plugin:vault-recover|complete_recovery", {
    vaultId,
    newPassword,
  });
}
