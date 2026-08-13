// Tauri IPC wrapper for the `vault-change-password` plugin's
// `change_password` command — A8c standalone password rotation
// (current password known + new password set).
//
// **Password lifetime is best-effort on the JS side** per the same
// V8-immutable-strings posture as `vault-recover.ts` and
// `vault-unlock.ts`. The load-bearing zeroize is Rust-side via the
// plugin's first-line `Zeroizing<String>` wrap on both
// `current_password` and `new_password` parameters (per
// `src-tauri/CLAUDE.md` "Secret-handling logging discipline"). The
// wrapper drops its closure-captured references on resolve/reject so
// the JS heap allocations become GC-able. Callers (PasswordChangeForm
// + AccountPanel) keep both passwords in component-local state and
// clear them on success/cancel/unmount per Q9 memory hygiene
// commitment from the grill log.
//
// Capability ACL `vault-change-password:default` is already in
// `src-tauri/capabilities/default.json` — no ACL change required.

import { invoke } from "@tauri-apps/api/core";

/**
 * A8c — change the master password of the currently-unlocked vault.
 * The slot must be `Slot::Unlocked` (the Settings UI is unreachable
 * otherwise); the user must know the current password (re-auth
 * requirement per `decisions.md` 2026-05-06 OWASP ASVS V2.5.6
 * extension).
 *
 * Resolves `void` on success — the slot remains `Slot::Unlocked`
 * with a freshly-rewritten `vault.meta` password side (recovery-side
 * bytes preserved per `protocol.md` §7.3). Frontend keeps the user
 * in-place; the Settings modal closes on resolve and shows a brief
 * success toast.
 *
 * Rejects with a `VaultChangePasswordError` on any failure path:
 *   - `InvalidCredentialOrVault` — non-distinguishing wrong-current
 *     OR password-side tampered (form-level error, LITERAL compound
 *     copy per `decisions.md` 2026-05-02 + 2026-05-06).
 *   - `InvalidVaultMeta` — structural corruption; force-relock,
 *     route to `<FailClosedError reason="corrupted-vault" />`.
 *   - `VaultMetaChangedExternally` — CAS mismatch; force-relock with
 *     suspicion banner (`Stage.unlock.suspicionReason =
 *     "vault-meta-changed-externally"`).
 *   - `VaultLockedDuringChange` — user fired vault_lock during
 *     Argon2id; force-relock with informational banner
 *     (`suspicionReason = "vault-locked-during-change"`).
 *   - `SamePasswordRejected` — pre-Argon2id reject; form-level error.
 *   - `WeakNewPassword` — defensive backend min-len floor; form-level
 *     error (frontend gate normally fires first).
 *   - `IoError` / `JoinFailure` — recoverable; modal stays open,
 *     form preserved, retry banner.
 *   - `ChangePasswordInProgress` / `VaultNotUnlocked` — UI/router bug
 *     indicators; not user-facing.
 *
 * See `src/types/vault-change-password-error.ts` for the full error
 * mirror and per-variant UX wiring.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await invoke<void>("plugin:vault-change-password|change_password", {
    currentPassword,
    newPassword,
  });
}
