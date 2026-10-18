export interface PersonStatusView {
  enrolled: boolean;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  identity_code: string | null;
}

export async function personStatus(): Promise<PersonStatusView> {
  return { enrolled: false, identity_unlocked: false, person_id_hex: null, identity_code: null };
}

export async function memberVaultStatus(_vaultId: string): Promise<boolean> {
  return false;
}

export async function personUnlockMemberVault(_vaultId: string, _phrase: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

// The member-vault fast-unlock surface (password / PIN / biometric) is absent on
// web for the same reason member vaults are: a browser cannot hold a person
// identity. These mirror the shared `src/lib/personAccount.ts` signatures so the
// shared settings screen that imports them (`MemberPasswordSettings.tsx`) still
// bundles and type-checks; the mutators throw the same not-here error the phrase
// unlock above does, and the status probe answers "no method configured" rather
// than throwing, matching the neutral-value shape of `memberVaultStatus`.
export type MemberUnlockMethod = "password" | "pin" | "biometric";

export async function memberUnlockStatus(
  _vaultIdHex: string,
): Promise<MemberUnlockMethod | null> {
  return null;
}

export async function setMemberPassword(_password: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function setMemberPin(_pin: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function setMemberBiometric(): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function clearMemberUnlock(): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

// The identity-plane surface the member UI imports (myne-md/myne#851, #852).
// These arrived when the phrase restriction was retired (`decisions.md`
// 2026-10-18, entry 0704): `IdentityHome`, `InviteWizard` and
// `MemberVaultUnlockCard` stopped being substituted out of the bundle, so every
// symbol they import has to exist here. Same rule as the block above — reads
// answer a neutral value, mutators throw the not-here error — because the
// capability is still absent (`memberSharing`, and the person plane wholesale)
// and the dispatcher would refuse these commands anyway. What this file buys is
// a typed refusal rather than a generic one, plus call sites that still
// type-check against the real signatures.

export interface PersonSetupView {
  phrase: string | null;
  fingerprint_hex: string;
  person_id_hex: string;
  identity_code: string;
  approved: boolean;
}

export async function personSetup(_phrase?: string): Promise<PersonSetupView> {
  throw new Error("person identities are unavailable on web");
}

export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

export async function personListInvites(): Promise<InviteSummary[]> {
  return [];
}

export interface AcceptedInviteView {
  vault_id: string;
  vault_account_hash_hex: string;
  owner_fingerprint_hex: string;
  group_key_epoch: number;
}

export async function personAcceptInvite(
  _inviteIdHex: string,
  _ownerCode: string,
  _phrase: string,
  _password: string,
): Promise<AcceptedInviteView> {
  throw new Error("member vaults are unavailable on web");
}

export async function personJoinVault(
  _inviteIdHex: string,
  _vaultAccountHashHex: string,
  _phrase: string,
  _password: string,
): Promise<AcceptedInviteView> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithPassword(
  _vaultIdHex: string,
  _password: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithPin(
  _vaultIdHex: string,
  _pin: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithBiometric(
  _vaultIdHex: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}
