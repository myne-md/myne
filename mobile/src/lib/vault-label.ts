/** Single fallback for a vault whose user-set name is unset (`label == null` —
 *  the name lives encrypted-only in `vault.prefs.label`; a never-renamed vault
 *  has none). Every surface that renders a vault name routes through here so an
 *  unnamed vault reads the same in the header, the switcher, Settings, and the
 *  boot picker (they used to split between "Personal" and "Vault"). */
export const VAULT_FALLBACK_LABEL = "Vault";

/** Display name for a vault. Pass `ordinal` (1-based) in multi-vault lists so
 *  unnamed vaults stay distinguishable ("Vault 2"), matching the desktop
 *  switcher's fallback. */
export function vaultDisplayLabel(label: string | null | undefined, ordinal?: number): string {
  return label ?? (ordinal != null ? `${VAULT_FALLBACK_LABEL} ${ordinal}` : VAULT_FALLBACK_LABEL);
}
