// Which second credential a vault carries, and the unlock that uses it
// (myne-md/myne#911 task 10, `decisions/protocol/0758`).
//
// This module used to also drive the explicit `NTV6` → `NTV7` frame upgrade.
// That upgrade is gone with the rest of the version-migration surface: a vault
// created by this build is born `NTV8` (person-born) or `NTV5` (password-only),
// and no client is expected to carry a pre-v0.13 vault, so there is no frame to
// rewrite. What remains is the read that decides which credential a vault takes
// and the phrase unlock that follows from it.

import { invoke } from "../platform/core";

/**
 * Which second credential this vault has, if any.
 *
 * Read from `vault.meta`'s magic bytes. Read-only and safe before an unlock
 * attempt. Three answers, and the third is absence (myne-md/myne#938,
 * `decisions/protocol/0758`):
 *
 * - `true`: an `NTV7` vault, whose second credential is the owner's identity
 *   phrase.
 * - `false`: `MYV1`/`NTV5`/`NTV6`, whose second credential is the vault's own
 *   recovery phrase. Also the answer for a missing or unreadable file, because
 *   the legacy answer keeps a door on screen and a transient read failure must
 *   not hide one. **Unreachable in practice since the version-migration surface
 *   was removed**: those generations are no longer created and no longer
 *   readable, so this arm survives as the read's own legacy answer rather than
 *   as a surface any current vault reaches.
 * - `null`: an `NTV8` vault, which has no second credential at all. The vault
 *   opens with its password and nothing else, so every surface that would offer
 *   a phrase MUST render nothing for this state rather than the vault phrase
 *   grid. Typing 24 words into it cannot succeed, and the backend answers with
 *   the non-distinguishing "wrong phrase" for words that are right.
 *
 * This name is kept rather than renamed: it is the same read, and the wire
 * command is one the three clients share.
 */
export async function vaultIsPersonWrapped(
  vaultId?: string | null,
): Promise<boolean | null> {
  return invoke<boolean | null>("plugin:vault-unlock|vault_is_person_wrapped", {
    vaultId: vaultId ?? null,
  });
}

/**
 * Open the active vault with the owner's identity phrase.
 *
 * The backend normalizes the phrase (one normalization, three clients), derives
 * the person from it and opens the person wrap; the AAD binds the owner
 * fingerprint and the vault's `items_key_id`, so another person's phrase is an
 * AEAD failure rather than a code path. A vault of any other generation refuses
 * with the same non-distinguishing `InvalidCredentialOrVault` a wrong password
 * gets, which is deliberate: a credential that does not apply must not be
 * distinguishable from one that is merely wrong.
 */
export async function unlockWithPersonPhrase(
  vaultId: string | undefined,
  phrase: string,
): Promise<void> {
  return invoke<void>("plugin:vault-unlock|unlock_with_person_phrase", {
    vaultId,
    phrase,
  });
}
