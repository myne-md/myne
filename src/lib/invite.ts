// SPDX-License-Identifier: AGPL-3.0
// The B2B member bindings (myne-md/myne#698, b2b-identity-substrate).
// One invoke per command. No secret crosses this boundary except the
// recovery phrase at `personUnlock`, which is the deliberate
// unlock-equivalent moment (mirrors the master password at unlock).
import { invoke } from "../platform/core";

/**
 * The person identity's public view (fingerprint only).
 *
 * Response fields are snake_case: `#[tauri::command]` renames its ARGUMENTS
 * to camelCase, but a returned struct serializes via serde's default, which
 * is the field names verbatim. `DeviceEntry.device_id_hex` in
 * `src/hooks/useDevices.ts` is the same convention.
 */
export interface PersonIdentityView {
  fingerprint_hex: string;
  person_id_hex: string;
  /** The owner-side out-of-band code a member pastes to verify the group
   *  package. Public material only. */
  identity_code: string;
}

/** A vault role as the backend serializes it (lowercase). One shared type
 *  so the three call sites cannot drift into three spellings. */
export type VaultAuthority = "owner" | "member";

/** One roster row as the UI consumes it. */
export interface RosterMemberView {
  fingerprint_hex: string;
  display_name: string;
  /** The member's vault role, serialized lowercase by the backend. */
  role: VaultAuthority;
  version: number;
  previous_fingerprint_hex: string | null;
  joined_at: number;
  member_ed_pk_hex: string;
  member_kem_ek_hex: string;
  member_mldsa_vk_hex: string;
  /** Identity-continuity state on an `NTV6` vault (`current` | `changed` |
   *  `owner-confirmed`); `null` for a legacy `NTV5`/`MYV1` roster. */
  continuity: "current" | "changed" | "owner-confirmed" | null;
}

/** The invite command's serializable result. */
export interface InviteCommandView {
  owner_fingerprint_hex: string;
  member_fingerprint_hex: string;
  owner_ed25519_pk_hex: string;
  owner_mldsa_vk_hex: string;
  /** The whole sealed invite frame (hex-JSON), for the caller to relay. */
  invite_wire: string;
}

/** Derive or open the backend-held person identity from the phrase. */
export async function personUnlock(phrase: string): Promise<PersonIdentityView> {
  return invoke<PersonIdentityView>("plugin:sync|sync_person_unlock", { phrase });
}

/** Drop the backend-held person identity. `forget` also erases the sealed file. */
export async function personLock(forget = false): Promise<void> {
  return invoke("plugin:sync|sync_person_lock", { forget });
}

/** The explicit owner-approved NTV5 to NTV6 migration's result. */
export interface B2bMigrationView {
  group_key_epoch: number;
  singletons_migrated: number;
}

/**
 * Start the explicit owner-approved migration that turns an `NTV5` vault into a
 * shared `NTV6` one. Called from the FIRST B2B action (the invite), after the
 * person identity is unlocked; an ordinary unlock never migrates. Idempotent: an
 * already-migrated vault reports its epoch and rewrites nothing.
 */
export async function startB2bMigration(ownerDisplayName: string): Promise<B2bMigrationView> {
  return invoke<B2bMigrationView>("plugin:sync|sync_start_b2b_migration", {
    ownerDisplayName,
  });
}

/** The invitee's addressable id + SAS fingerprint, decoded from a pasted
 *  identity code before the invite is sealed. */
export interface InviteCodeView {
  person_id_hex: string;
  fingerprint_hex: string;
}

/** Parse a pasted person identity code for the out-of-band SAS compare (pure:
 *  no vault, no network). */
export async function inspectInviteCode(recipientCode: string): Promise<InviteCodeView> {
  return invoke<InviteCodeView>("plugin:sync|sync_person_inspect_invite_code", {
    recipientCode,
  });
}

/** Create and relay an invite from a pasted person identity code. The owner
 *  should have confirmed the SAS fingerprint from {@link inspectInviteCode}
 *  first. */
export async function personCreateInvite(input: {
  recipientCode: string;
  vaultLabel: string;
  createdAtSecs: number;
}): Promise<InviteCommandView> {
  return invoke<InviteCommandView>("plugin:sync|sync_person_create_invite", {
    recipientCode: input.recipientCode,
    vaultLabel: input.vaultLabel,
    createdAtSecs: input.createdAtSecs,
  });
}

/**
 * The roster listing plus the caller's vault authority, so the UI gates
 * admin affordances on one typed source rather than inferring ownership.
 */
export interface RosterListView {
  members: RosterMemberView[];
  authority: VaultAuthority;
  /** The current group-key epoch on an `NTV6` vault; `null` for a legacy
   *  roster that has no group tier. */
  group_key_epoch: number | null;
}

/** List the unlocked vault's B2B roster (non-tombstoned rows) and authority. */
export async function listRoster(): Promise<RosterListView> {
  return invoke<RosterListView>("plugin:sync|sync_list_roster");
}

/** One invitation the owner has sent for this vault, with its claim state. */
export interface VaultInviteSummary {
  invite_id_hex: string;
  recipient_person_id_hex: string;
  claimed: boolean;
}

/** Owner-side claimed-versus-pending view of this vault's invitations. */
export async function listVaultInvites(): Promise<VaultInviteSummary[]> {
  return invoke<VaultInviteSummary[]>("plugin:sync|sync_list_vault_invites");
}

/** Remove a member. LIVE: the backend rotates the group hierarchy (epoch+1
 *  group key, fresh `itemsKey`, singleton reseal, signed roster tombstone),
 *  pushes the rotated `vault.meta`, records the namespace retirement and revokes
 *  the member's server binding. Revocation is future-access only; it makes no
 *  recall claim about content the removed person already copied. */
export async function removeMember(memberFingerprintHex: string): Promise<void> {
  return invoke("plugin:sync|sync_remove_member", { memberFingerprintHex });
}
