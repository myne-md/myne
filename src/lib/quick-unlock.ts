// Tauri IPC wrappers for the `quick-unlock` plugin (MYND-329).
//
// Quick-unlock lets a re-lock be reversed with a PIN or Touch ID instead
// of the full master password. The backend stores a third wrapped copy of
// `root_key` in a device-local `vault.quickunlock` blob; these wrappers are
// the thin TS surface over the plugin's six commands. PIN material crosses
// IPC as a plain string (best-effort JS-side lifetime; the load-bearing
// zeroize is the Rust-side first-line `Zeroizing<String>` wrap, same posture
// as `vault-unlock.ts` / `vault-change-password.ts`).
//
// Capability ACL `quick-unlock:default` is already in
// `src-tauri/capabilities/default.json`.
//
// ⚠️ The biometric (Touch ID) path is HARDWARE-UNVERIFIED pending a Touch ID
// device + a primitive review (see `core/.../quick_unlock/apple.rs`).
// The UI must not present it as a trusted gate until that verification passes.

import { invoke } from "../platform/core";

/**
 * The credential kinds a quick-unlock blob can be sealed under — the TS mirror
 * of the Rust `provider_kind`. Lives here, next to the IPC surface it comes
 * from, so a third method added on the Rust side has exactly one place to land.
 */
export type QuickUnlockMethod = "pin" | "biometric";

/** Mirror of the Rust `QuickUnlockStatus` (`commands.rs`). */
export interface QuickUnlockStatus {
  /** A credential blob exists on disk. Settings uses this for "Configured via PIN". */
  configured: boolean;
  /** The configured method when `configured`, else null. */
  method: QuickUnlockMethod | null;
  /**
   * Quick-unlock can be redeemed *right now* — `configured` AND a full
   * master-password unlock has happened this process session (the spring-loaded
   * gate). `false` on a cold start, so the Unlock screen hides the PIN field
   * rather than offer a credential that would fail `RequiresFullPassword`.
   */
  available: boolean;
}

/**
 * Is quick-unlock configured, and by which method?
 *
 * `vaultId` names the target vault explicitly. The Unlock screen MUST pass it:
 * at that point no vault is unlocked, so the backend cannot infer the target
 * from the active slot and its sole-vault disk fallback resolves to the wrong
 * directory once more than one vault exists (the credential then looks absent
 * and the PIN field self-hides). The Settings panel omits it — a vault is
 * unlocked there, so the active-vault path is correct.
 */
export function quickUnlockStatus(vaultId?: string): Promise<QuickUnlockStatus> {
  return invoke<QuickUnlockStatus>("plugin:quick-unlock|quick_unlock_status", { vaultId });
}

/**
 * Configure PIN quick-unlock for the active (unlocked) vault. Rejects with a
 * `QuickUnlockError` — `PinTooShort` / `PinNotDigits` (form-level),
 * `NotUnlocked`, `Backend`, etc.
 */
export function quickUnlockSetupPin(pin: string): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_setup_pin", { pin });
}

/**
 * Attempt a PIN quick-unlock of the active vault. Rejects with a
 * `QuickUnlockError` — `WrongCredential { remaining }`, `AttemptsExhausted`,
 * `RequiresFullPassword`, `NotConfigured`, …
 */
export function quickUnlockWithPin(pin: string, vaultId?: string): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_with_pin", { pin, vaultId });
}

/** Configure Apple biometric (Touch ID) quick-unlock. `HardwareUnavailable` off Apple targets. */
export function quickUnlockSetupBiometric(): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_setup_biometric");
}

/** Attempt an Apple biometric (Touch ID) quick-unlock. `vaultId` — see {@link quickUnlockStatus}. */
export function quickUnlockWithBiometric(vaultId?: string): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_with_biometric", { vaultId });
}

/** Remove the device-local quick-unlock credential for the active vault. */
export function quickUnlockDisable(): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_disable");
}
