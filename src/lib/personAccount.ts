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
  person_id_hex: string | null;
  /** The out-of-band identity code, for the identity home to show; `null` for a
   *  pre-task-11 credential. */
  identity_code: string | null;
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
 */
export async function personAcceptInvite(
  inviteIdHex: string,
  ownerCode: string,
  phrase: string,
): Promise<AcceptedInviteView> {
  return invoke<AcceptedInviteView>("plugin:sync|sync_person_accept_invite", {
    inviteIdHex,
    ownerCode,
    phrase,
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
