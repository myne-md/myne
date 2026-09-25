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
