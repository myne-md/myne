// SPDX-License-Identifier: AGPL-3.0
// Identity-only setup binding (myne-md/myne#711, b2b-member-sync).
//
// One invoke. The recovery phrase is the only secret that crosses this
// boundary, and only at the same ceremony moment vault creation shows one:
// `personSetup()` with no phrase GENERATES a phrase and returns it once for the
// user to write down; `personSetup(phrase)` recovers an existing identity.
//
// The command registers a person-level server account under `person_id_hash`
// and stores the per-device token device-scoped; no vault is created.
import { invoke } from "../platform/core";

export const PERSON_ACCOUNT_ABSENCE_MARKER = "person-account-binding";

/**
 * The identity-only setup result, as the backend serializes it.
 *
 * `phrase` is non-null ONLY when this call generated a new identity. Response
 * fields are snake_case: `#[tauri::command]` renames ARGUMENTS to camelCase, but
 * a returned struct serializes via serde's default (the field names verbatim),
 * the same convention `PersonIdentityView` in `src/lib/invite.ts` follows.
 */
export interface PersonSetupView {
  phrase: string | null;
  fingerprint_hex: string;
  person_id_hex: string;
  /** The out-of-band identity code an owner pastes to invite this person
   *  (public material only). */
  identity_code: string;
  /** False when a second password-path device is awaiting approval. */
  approved: boolean;
}

/**
 * Create a vault-less identity (no phrase) or recover one (phrase). The account
 * is registered at the configured sync endpoint; a missing endpoint is a typed
 * `NotConfigured` error the caller surfaces as "set a sync server first".
 */
export async function personSetup(phrase?: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_setup", {
    phrase: phrase ?? null,
  });
}

/** Whether this device holds a person account, and whose it is. */
export interface PersonStatusView {
  enrolled: boolean;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  /** The out-of-band public identity code; available while the private identity is locked. */
  identity_code: string | null;
  /**
   * Whether this device holds a recoverable sealed person keypair, even with no
   * token issued (myne-md/myne#780). `enrolled` is false in that state, so the
   * app shows Welcome, but "Create an identity" cannot open the sealed frame it
   * did not write. The first-run dialog reads this to steer to Recover or an
   * explicit forget.
   */
  sealed_keypair_present: boolean;
}

/** Device-local probe; no network. Drives the identity-only home. */
export async function personStatus(): Promise<PersonStatusView> {
  return invoke<PersonStatusView>("plugin:sync|sync_person_status");
}

/** One invite addressed to this person. The payload is NOT here; only a claim
 *  releases it. */
export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

/** List the invites addressed to this person account (sealed relay). */
export async function personListInvites(): Promise<InviteSummary[]> {
  return invoke<InviteSummary[]>("plugin:sync|sync_person_list_invites");
}

/** What a successful acceptance reports: public fields only. */
export interface AcceptedInviteView {
  vault_id: string;
  vault_account_hash_hex: string;
  owner_fingerprint_hex: string;
  group_key_epoch: number;
}

/**
 * Accept a sealed invite: claim it, verify the owner's group package against
 * the owner's identity code (public halves, obtained out of band), and unlock
 * the shared vault as a Member.
 *
 * `password` is REQUIRED and becomes the vault's device-local fast credential
 * (`vault.member-unlock`), written as part of installing the member session. It
 * is this device's password, not the vault owner's, and the recovery phrase stays
 * the portable fallback (myne-md/myne#851 task 7). The command checks the project
 * floor before it claims anything, so a short password cannot leave a claimed
 * invite behind.
 */
export async function personAcceptInvite(
  inviteIdHex: string,
  ownerCode: string,
  phrase: string,
  password: string,
): Promise<AcceptedInviteView> {
  return invoke<AcceptedInviteView>("plugin:sync|sync_person_accept_invite", {
    inviteIdHex,
    ownerCode,
    phrase,
    password,
  });
}

/**
 * Join a vault this identity ALREADY belongs to onto THIS device.
 *
 * The second-device path (myne-md/myne#852 task 7), and the reason it is a second
 * command rather than a flag on the accept. The accept is addressed to a person who
 * is not yet a member: it collects the owner's identity code out of band and verifies
 * the group package against THAT. A member's second device has no out-of-band code
 * and must not be given one: the owner it verifies against is the one its own
 * per-`(person, vault)` profile already pins (`decisions/protocol/0675`), read from
 * the person plane before anything is claimed. Hence no `ownerCode` here, and
 * `vaultAccountHashHex` on its own, so the pinned owner can be resolved for the named
 * vault before the re-claim.
 *
 * `inviteIdHex` comes from the recipient-scoped invite list, which INCLUDES claimed
 * rows: a re-claim by the invite's own recipient is idempotent
 * (`decisions/protocol/0672`) and mints a fresh per-vault membership token.
 *
 * `phrase` is this person's OWN recovery phrase, never a vault password a member
 * never had (`decisions/protocol/0606`). `password` is REQUIRED and becomes this
 * device's member-unlock credential; it is not the owner's password.
 */
export async function personJoinVault(
  inviteIdHex: string,
  vaultAccountHashHex: string,
  phrase: string,
  password: string,
): Promise<AcceptedInviteView> {
  return invoke<AcceptedInviteView>("plugin:sync|sync_member_join_vault", {
    inviteIdHex,
    vaultAccountHashHex,
    phrase,
    password,
  });
}

/** Whether a vault is a member vault (has a device-local member-key store), so
 *  the Unlock surface asks for the recovery phrase instead of a password. */
export async function memberVaultStatus(vaultIdHex: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_member_vault_status", {
    vaultIdHex,
  });
}

/** Re-unlock a member vault from the recovery phrase. */
export async function personUnlockMemberVault(
  vaultIdHex: string,
  phrase: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault", {
    vaultIdHex,
    phrase,
  });
}

/** The configured member-vault fast-unlock method, or null. */
export type MemberUnlockMethod = "password" | "pin" | "biometric";

/**
 * The configured member-vault fast-unlock method, or `null`, so the Unlock
 * surface offers the right credential instead of the recovery phrase.
 */
export async function memberUnlockStatus(
  vaultIdHex: string,
): Promise<MemberUnlockMethod | null> {
  return invoke<MemberUnlockMethod | null>("plugin:sync|sync_member_unlock_status", {
    vaultIdHex,
  });
}

/**
 * Set (or replace) the device-local member vault password. Requires the active
 * vault to be an unlocked member vault holding the person session: the store
 * seals the vault keys AND the person keypair, so a later password unlock is as
 * complete as a phrase one. Replaces a PIN/biometric credential. The recovery
 * phrase stays the portable fallback.
 */
export async function setMemberPassword(password: string): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_password", { password });
}

/** Set (or replace) the device-local member vault PIN (replaces other methods). */
export async function setMemberPin(pin: string): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_pin", { pin });
}

/** Set (or replace) the device-local member vault biometric credential (Apple only). */
export async function setMemberBiometric(): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_biometric");
}

/** Remove the device-local member fast-unlock credential for the active vault. */
export async function clearMemberUnlock(): Promise<void> {
  return invoke("plugin:sync|sync_person_clear_member_unlock");
}

/** Re-unlock a member vault from its device-local password. */
export async function personUnlockMemberVaultWithPassword(
  vaultIdHex: string,
  password: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_password", {
    vaultIdHex,
    password,
  });
}

/** Re-unlock a member vault from its device-local PIN. */
export async function personUnlockMemberVaultWithPin(
  vaultIdHex: string,
  pin: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_pin", {
    vaultIdHex,
    pin,
  });
}

/** Re-unlock a member vault from its device-local biometric credential. */
export async function personUnlockMemberVaultWithBiometric(
  vaultIdHex: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_biometric", {
    vaultIdHex,
  });
}
