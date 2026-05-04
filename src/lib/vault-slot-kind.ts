// Tauri IPC wrapper for `vault_slot_kind` (read-only `Slot` variant
// probe in the live `VaultRuntimeState`).
//
// The Rust command lives at `plugin:vault-unlock|vault_slot_kind` (see
// `src-tauri/src/plugins/vault_unlock/commands.rs`); permission entry
// `allow-vault-slot-kind` is bundled under the existing
// `vault-unlock:default` capability.
//
// Used at boot + post-WebView-reload to disambiguate runtime slot
// state from disk state. Together with `vault_status`, the two probes
// cover the full boot decision tree (disk presence → runtime slot).
// `vault_status` is disk-bound and slow-ish (one filesystem stat +
// 345-byte read); `vault_slot_kind` is RAM-bound and microseconds.
// They're issued in parallel via `Promise.all` in App.tsx's mount
// effect.
//
// **Not the post-recovery happy path.** `complete_recovery` returns
// `Ok(())` and the frontend navigates directly to the editor; a
// defensive `vault_slot_kind` round-trip would be paranoia per
// `decisions.md` 2026-05-02 (the IPC contract pins `Slot::Unlocked`
// as the success postcondition).

import { invoke } from "@tauri-apps/api/core";
import type { SlotKind } from "../types/slot-kind";

/**
 * Probe the in-memory slot state of `VaultRuntimeState`.
 *
 * The Rust command's `Err` arm is structurally unreachable
 * (`vault_slot_kind_inner` always returns `Ok(state.slot_kind())`),
 * but the IPC layer itself can fail (plugin not registered, capability
 * ACL mismatch, host process panic). On any such failure we log in dev
 * and fall back to `"Empty"` — the disk-based routing path then takes
 * over via `initialStageFromProbe`, so the user still reaches a usable
 * screen instead of getting stuck on the loading shim.
 */
export async function probeSlotKind(): Promise<SlotKind> {
  try {
    return await invoke<SlotKind>("plugin:vault-unlock|vault_slot_kind");
  } catch (raw) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        "[vault-slot-kind] probe failed; defaulting to Empty (disk-based routing applies):",
        raw,
      );
    }
    return "Empty";
  }
}
