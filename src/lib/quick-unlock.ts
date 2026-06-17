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
// device + a primitive review (see `src-tauri/.../quick_unlock/macos.rs`).
// The UI must not present it as a trusted gate until that verification passes.

import { invoke } from "@tauri-apps/api/core";

/** Mirror of the Rust `QuickUnlockStatus` (`commands.rs`). */
export interface QuickUnlockStatus {
  configured: boolean;
  /** `"pin"` | `"biometric"` when configured, else null. */
  method: "pin" | "biometric" | null;
}

/** Is quick-unlock configured for the active vault, and by which method? */
export function quickUnlockStatus(): Promise<QuickUnlockStatus> {
  return invoke<QuickUnlockStatus>("plugin:quick-unlock|quick_unlock_status");
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
export function quickUnlockWithPin(pin: string): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_with_pin", { pin });
}

/** Configure macOS Touch ID quick-unlock. `HardwareUnavailable` off macOS. */
export function quickUnlockSetupBiometric(): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_setup_biometric");
}

/** Attempt a macOS Touch ID quick-unlock of the active vault. */
export function quickUnlockWithBiometric(): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_with_biometric");
}

/** Remove the device-local quick-unlock credential for the active vault. */
export function quickUnlockDisable(): Promise<void> {
  return invoke("plugin:quick-unlock|quick_unlock_disable");
}
