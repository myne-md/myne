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

/** Invite one member to the unlocked vault. */
export async function inviteMember(input: {
  memberKemEkHex: string;
  memberEdPkHex: string;
  memberMldsaVkHex: string;
  vaultLabel: string;
  createdAtSecs: number;
}): Promise<InviteCommandView> {
  return invoke<InviteCommandView>("plugin:sync|sync_invite_member", {
    memberKemEkHex: input.memberKemEkHex,
    memberEdPkHex: input.memberEdPkHex,
    memberMldsaVkHex: input.memberMldsaVkHex,
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
}

/** List the unlocked vault's B2B roster (non-tombstoned rows) and authority. */
export async function listRoster(): Promise<RosterListView> {
  return invoke<RosterListView>("plugin:sync|sync_list_roster");
}

/** Remove a member. PARKED until the roster wire ships: the backend refuses
 *  with `RemovalUnavailable` before touching the vault, and the roster panel
 *  offers no Remove affordance. Kept wired so the binding stays covered. */
export async function removeMember(memberFingerprintHex: string): Promise<void> {
  return invoke("plugin:sync|sync_remove_member", { memberFingerprintHex });
}
