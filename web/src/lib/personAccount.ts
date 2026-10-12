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
