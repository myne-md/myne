// Tauri IPC wrappers for the `vault-recover` plugin commands.
//
// **Phrase lifetime is best-effort on the JS side** per
// `recovery-flow.md` § 3.5: V8 strings are immutable and not
// zeroizable; the load-bearing zeroize is Rust-side via
// `Zeroizing<String>` (the plugin wraps the IPC argument on its
// first non-doc statement). The wrapper drops its closure-captured
// reference on resolve/reject so the JS heap allocation is GC-able.
//
// Callers (PhraseEntryStep, future PasswordResetStep) keep the
// password / phrase in component-local state and pass it directly
// to the wrapper at submit time — no module-level cache, no Tauri
// State payload that lingers across renders.

import { invoke } from "@tauri-apps/api/core";

/**
 * A8d — recover an existing vault with the user's BIP-39 24-word
 * recovery phrase. Phrase MUST already be NFKD-normalized + joined
 * with a single ASCII space per `protocol.md` § 7.4 (the Rust side
 * also normalizes defensively, but the wire shape is the
 * normalized form).
 *
 * Resolves `void` on success — the slot is now `Recovering` and
 * the chained `complete_recovery` (A8f) is the only valid next
 * IPC. Rejects with a `VaultRecoveryError` on any failure path
 * (see `src/types/vault-recovery-error.ts`).
 */
export async function recoverWithPhrase(phrase: string): Promise<void> {
  await invoke<void>("plugin:vault-recover|recover_with_phrase", { phrase });
}

/**
 * A8f — chained password commit after a successful A8d. Promotes
 * `Slot::Recovering` → `Slot::Unlocked` by rewriting `vault.meta`'s
 * password side under the new master password (recovery-side bytes
 * preserved per `recovery-flow.md` § 4.4; atomic write per § 4.2).
 *
 * Resolves `void` on success — frontend navigates directly to the
 * editor; defensive `vault_status` round-trip would be paranoia
 * per `decisions.md` 2026-05-02.
 */
export async function completeRecovery(newPassword: string): Promise<void> {
  await invoke<void>("plugin:vault-recover|complete_recovery", {
    newPassword,
  });
}
