// Tauri IPC wrapper for `vault_status` (read-only `vault.meta` probe).
//
// The Rust command lives at `plugin:vault-unlock|vault_status` (see
// `src-tauri/src/plugins/vault_unlock/commands.rs`); permission entry
// in `src-tauri/permissions/vault-unlock/default.toml` allows it via
// the existing `vault-unlock:default` capability.
//
// `invoke` throws on Err — we catch + normalize into a discriminated
// union so callers can `switch` over a single shape rather than
// awaiting + try/catch every call site. The probe is read-only,
// idempotent, and runs in microseconds (vault.meta is 345 bytes).

import { invoke } from "../platform/core";
import type {
  VaultStatus,
  VaultStatusError,
  VaultStatusResult,
} from "../types/vault-status";

/**
 * Probe `<app_data_dir>/vault/vault.meta` and classify it.
 *
 * Caller pattern:
 * ```ts
 * const result = await probeVaultStatus();
 * if ("ok" in result) {
 *   // result.ok: VaultStatus
 * } else {
 *   // result.err: VaultStatusError
 * }
 * ```
 *
 * Both arms are handled by `initialStageFromProbe` in `lib/stage.ts`
 * so App.tsx's boot effect is a single line.
 */
export async function probeVaultStatus(): Promise<VaultStatusResult> {
  try {
    const ok = await invoke<VaultStatus>("plugin:vault-unlock|vault_status");
    return { ok };
  } catch (raw) {
    return { err: raw as VaultStatusError };
  }
}
