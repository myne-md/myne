// Mobile person-account bindings (myne-md/myne#768).
//
// A 1:1 port of the desktop `src/lib/personAccount.ts` over the mobile-registered
// `sync` plugin. The commands are the SAME ones the desktop client calls, so the
// identity a phone creates is the identity a laptop sees: one person account,
// keyed by `person_id_hash`, addressable for invites.
//
// Secret discipline: the phrase is passed per-call straight to IPC and is never
// parked in module or hook state. `personSetup()` with no phrase GENERATES a
// phrase and returns it once; `personSetup(phrase)` recovers an existing
// identity. `memberVaultStatus` / `personUnlockMemberVault` are the member-vault
// doors, where the credential is the person's own recovery phrase, never a vault
// phrase (`docs/decisions/protocol/0606`).

import { invoke } from "../platform/core";

/** The identity-only setup result, as the backend serializes it. */
export interface PersonSetupView {
  /** Non-null ONLY when this call generated a new identity. */
  phrase: string | null;
  fingerprint_hex: string;
  person_id_hex: string;
  /** The out-of-band identity code an owner pastes to invite this person. */
  identity_code: string;
  /** False when a second password-path device is awaiting approval. */
  approved: boolean;
}

/** Create a vault-less identity, or recover one from its phrase. */
export function personSetup(phrase?: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_setup", {
    phrase: phrase ?? null,
  });
}

/** Whether this device holds a person account, and whose it is. Device-local. */
export interface PersonStatusView {
  enrolled: boolean;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  identity_code: string | null;
}

export function personStatus(): Promise<PersonStatusView> {
  return invoke<PersonStatusView>("plugin:sync|sync_person_status");
}

/** One invite addressed to this person. The payload is not here; only a claim
 *  releases it. */
export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

export function personListInvites(): Promise<InviteSummary[]> {
  return invoke<InviteSummary[]>("plugin:sync|sync_person_list_invites");
}

/** Claim an invite and materialize the member vault. */
export function personAcceptInvite(
  inviteIdHex: string,
  ownerCode: string,
  phrase: string,
): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_accept_invite", {
    inviteIdHex,
    ownerCode,
    phrase,
  });
}

/** Property of an invite code the invitee compares out of band. */
export interface InviteCodeView {
  person_id_hex: string;
  fingerprint_hex: string;
}

export function inspectInviteCode(code: string): Promise<InviteCodeView> {
  return invoke<InviteCodeView>("plugin:sync|sync_person_inspect_invite_code", {
    code,
  });
}

/** Whether this vault is a member vault (unlocked by the person phrase). */
export function memberVaultStatus(vaultId: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_member_vault_status", { vaultId });
}

/** Re-unlock a member vault from the person's own recovery phrase. */
export function personUnlockMemberVault(vaultId: string, phrase: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_unlock_member_vault", {
    vaultId,
    phrase,
  });
}
