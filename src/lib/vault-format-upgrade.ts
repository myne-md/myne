// Tauri IPC wrapper for the explicit `NTV6` → `NTV7` upgrade and the two probes
// that surround it (myne-md/myne#911 task 10).
//
// **Not to be confused with `vault-migrate.ts`**, which owns the whole-vault
// v0.1 → v0.2 re-key (`MYV1` → `NTV5`, `protocol.md` §10.4.1). That one
// re-encrypts every note under a freshly minted `root_key` and stages a
// `legacy/` snapshot to roll back to. This one rewrites ONE file: it appends the
// person envelope over the `root_key` the vault already has and zeroes the
// recovery-phrase wrap. There is nothing to roll back to and no snapshot,
// because there is nothing else to change.
//
// **Irreversible, and the one thing the copy must never soften.** After it
// commits, the saved vault phrase does not open the vault. The vault password
// still does, and the owner's identity phrase does, which is the whole point of
// the change: one phrase for the account instead of one per vault. A vault is
// unreadable to any client that predates `NTV7` once the frame syncs, which is
// why the confirmation says every device must be updated first.

import { invoke } from "../platform/core";

/** Closed error union mirroring the Rust `Ntv7UpgradeError` (`#[serde(tag="kind")]`). */
export type VaultUpgradeError = {
  kind:
    /** Already `NTV7`; nothing written. */
    | "AlreadyUpgraded"
    /** A pre-v0.2 (`MYV1`) vault: finish the whole-vault migration first. */
    | "MigrationRequired"
    /** `vault.meta` unreadable, truncated, or a generation this cannot carry. */
    | "InvalidVaultMeta"
    /** The group-key package or the roster envelope did not open (tampered). */
    | "CannotDecrypt"
    /** The identity on this device is not the roster's owner. */
    | "PersonMismatch"
    /** No identity on this device; creating one is the remedy. */
    | "PersonRequired"
    /** An identity exists but its keypair is not in the session, and an `NTV5`
     *  source must sign its first roster. */
    | "IdentityLocked"
    /** This session is a MEMBER of the vault; a member does not author the
     *  credential side of an owner-signed frame. */
    | "NotOwner"
    /** The vault is shared with another person. This is a ROLLOUT rule, not a
     *  capability one: a client that predates the person-wrapped generation
     *  rejects the magic outright, and a shared vault's other devices belong to
     *  other people. `protocol.md` §10.4.2 item 9. */
    | "SharedVault"
    /** No vault is open. */
    | "NotUnlocked"
    | "Csprng"
    /** A read or write failed; the previous metadata is intact. */
    | "Io"
    /** Another auth-pipeline operation is in flight. */
    | "AuthOperationInProgress";
};

/** Mirrors the Rust `Ntv7UpgradeView`. */
export interface VaultUpgradeView {
  /** The generation the frame was upgraded FROM (`"NTV5"` or `"NTV6"`). */
  upgraded_from: string;
  /** The group-key epoch the committed frame carries. */
  group_key_epoch: number;
}

/** The error's `kind`, or `null` for anything that is not this command's union. */
export function vaultUpgradeErrorKind(
  e: unknown,
): VaultUpgradeError["kind"] | null {
  const kind = (e as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" ? (kind as VaultUpgradeError["kind"]) : null;
}

/**
 * Upgrade the open vault to the person-wrapped generation.
 *
 * Needs no credential from the caller: the vault is already unlocked, so the
 * backend has `root_key`, and the owner's person public half is on disk in the
 * person credential. An `NTV5` source is chained through the owner B2B
 * migration first, which DOES need the identity unlocked (it signs the first
 * roster), and that is what `IdentityLocked` names.
 */
export async function upgradeVaultToNtv7(): Promise<VaultUpgradeView> {
  return invoke<VaultUpgradeView>("plugin:vault-migrate|vault_upgrade_to_ntv7");
}

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
 *   not hide one.
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
