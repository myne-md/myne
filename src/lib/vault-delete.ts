// Tauri IPC wrapper for the `vault-delete` plugin's `vault_delete`
// command (MYND-105 backend, MYND-108 + MYND-108-bis frontend consumers).
//
// One-shot vault destruction across three accepted Slot preconditions:
//
//   - `Slot::Unlocked` / `Slot::Recovering` — backend zeroizes
//     in-memory keys via `state.take()` (Drop on the moved-out
//     variant fires BEFORE any filesystem op), then recursively
//     unlinks `<app_data_dir>/vault/`. Same crypto-erase ordering
//     as MYND-105 ship.
//   - `Slot::Empty` + `vault.meta` exists on disk (MYND-108-bis,
//     `decisions.md` 2026-05-26 "MYND-108-bis vault_delete extended
//     to accept Slot::Empty + vault.meta-exists") — no in-memory
//     keys to zeroize (the user has lost both password and recovery
//     phrase); backend skips `state.take()` and runs the recursive
//     unlink directly. Cryptographic-erase claim is structurally
//     inapplicable on this arm; the on-disk Argon2id-wrapped keys
//     are already computationally unrecoverable.
//
// Returns `Ok(())` on full success; rejects with a `VaultDeleteError`
// variant on each failure mode (see `src/types/vault-delete-error.ts`).
// `VaultNotUnlocked` is retained in the wire format for forward
// compatibility but becomes unreachable from current backend code paths.
//
// **Frontend contract (loosened by MYND-108-bis):** caller MAY
// pre-`vault_lock` if they wish — the resulting `Slot::Empty +
// vault.meta-exists` state falls into the new accept path with the
// same end-to-end crypto-erase property (the racing `vault_lock`'s
// zeroize fires before the recursive unlink). The MYND-105 era
// contract that read "MUST NOT pre-lock" is loosened by the
// `decisions.md` 2026-05-26 "MYND-108-bis" entry.
//
// Capability ACL `vault-delete:default` is already in
// `src-tauri/capabilities/default.json` (shipped with MYND-105
// `backend-vault-delete`). No ACL change required for MYND-108 or
// MYND-108-bis.

import { invoke } from "../platform/core";
import type { VaultDeleteError } from "../types/vault-delete-error";

export type {
  VaultDeleteError,
} from "../types/vault-delete-error";
export {
  isPartialDeleteError,
  isVaultDeleteIoError,
} from "../types/vault-delete-error";

/**
 * UI-side discriminated union carrying the form-banner payload for a
 * post-fail `DeleteVaultConfirmForm`. Lives in this module (rather
 * than in `DeleteVaultConfirmForm.tsx`) so the error-mapping helper
 * below can produce values of this shape without the lib module
 * depending on a UI component.
 *
 * - `partial-delete` — backend `VaultDeleteError::PartialDelete`
 *   surfaces the count of files that could not be unlinked
 *   (AV scanner / Spotlight / OneDrive sync lock). Vault directory
 *   path comes from UI-side resolution (`appDataDir() + "vault"`),
 *   not from the backend response (backend DENY-list discipline
 *   forbids path-in-tracing). **`null` where the client has no path
 *   to show** (phase3-web-client task 72): `path.appDataDir` is a typed
 *   refusal in the browser seam, and an OPFS container is not a place a
 *   user can open a file manager on, so the manual-cleanup pointer has
 *   nothing to point at. `null` rather than `""` so the form's absence
 *   branch is a check the compiler enforces.
 * - `io` — backend `VaultDeleteError::Io { io_error_kind }`. Generic
 *   disk-error scenario; UI shows a banner with a generic copy and
 *   the resolved vault path. The `io_error_kind` discriminant is not
 *   surfaced to the user (kernel-dependent categorization).
 */
export type DeleteVaultPartialFailContext =
  | {
      kind: "partial-delete";
      remainingCount: number;
      vaultDirPath: string | null;
    }
  | {
      kind: "io";
      vaultDirPath: string | null;
    };

/**
 * Result of mapping a `VaultDeleteError` against a resolved vault
 * path. Consumers (AccountPanel + Unlock + VaultRecover sub-step)
 * pattern-match on `kind`: `"bug-canary"` triggers a dev-only
 * `console.warn` with no user-facing surface; `"partial-fail"`
 * populates the form's `partialFailContext` prop to drive the
 * post-fail banner + Continue button.
 */
export type DeleteVaultErrorMapping =
  | { kind: "bug-canary" }
  | { kind: "partial-fail"; context: DeleteVaultPartialFailContext };

function assertNeverDeleteVaultError(x: never): never {
  throw new Error(
    `[vault-delete] unhandled VaultDeleteError variant: ${JSON.stringify(x)}`,
  );
}

/**
 * Map a `VaultDeleteError` into a UI-actionable verdict. Lifted from
 * AccountPanel.tsx during MYND-108-bis so Unlock + Recovery
 * lost-credentials surfaces can reuse the same exhaustive narrowing
 * (`assertNever` default arm catches missing variants at compile
 * time).
 *
 * Three variants (`VaultBusyAuth`, `VaultNotUnlocked`,
 * `VaultNotFound`) are UI/router bug indicators in normal flow:
 *
 *   - From AccountPanel: Settings mounted → `Slot::Unlocked`; if the
 *     backend returns `VaultNotUnlocked`, something raced or the
 *     router is buggy.
 *   - From Unlock or Recovery: the IPC should accept either
 *     `Slot::Empty + meta-exists` (MYND-108-bis) or `Slot::Recovering`
 *     (MYND-105 R3); `VaultNotUnlocked` is unreachable but the
 *     frontend still treats it as bug-canary defense-in-depth.
 *   - `VaultBusyAuth` only fires if a concurrent auth-pipeline op
 *     races (rare in v0.1 single-vault single-flow UX).
 *   - `VaultNotFound` means nothing-on-disk; in lost-credentials
 *     surfaces the user shouldn't be in those screens at all if no
 *     vault.meta exists (boot probe routes to Welcome).
 *
 * Two variants are real user-facing errors:
 *
 *   - `PartialDelete { remaining_count }` — surface count + vault
 *     path; Continue → Welcome.
 *   - `Io { io_error_kind }` — generic disk-error copy + vault
 *     path; Continue → Welcome.
 *
 * Vault path comes from the caller (resolved UI-side via
 * `appDataDir() + join("vault")`).
 */
export function mapDeleteVaultError(
  e: VaultDeleteError,
  vaultDirPath: string | null,
): DeleteVaultErrorMapping {
  switch (e.kind) {
    case "VaultBusyAuth":
    case "VaultNotUnlocked":
    case "VaultNotFound":
      return { kind: "bug-canary" };
    case "PartialDelete":
      return {
        kind: "partial-fail",
        context: {
          kind: "partial-delete",
          remainingCount: e.detail.remaining_count,
          vaultDirPath,
        },
      };
    case "Io":
      return {
        kind: "partial-fail",
        context: { kind: "io", vaultDirPath },
      };
    default:
      return assertNeverDeleteVaultError(e);
  }
}

/**
 * Destroy the current vault.
 *
 * **Pre-conditions** (caller responsibility, enforced by call-site
 * gating in AccountPanel / Unlock / VaultRecover sub-views):
 *   - `Slot::Unlocked`, `Slot::Recovering`, OR `Slot::Empty +
 *     vault.meta-exists` (MYND-108-bis)
 *   - No other auth-pipeline op in flight (no concurrent
 *     vault_unlock / vault_recover / vault_complete_recovery /
 *     vault_change_password)
 *   - User has explicitly typed `DELETE` and clicked the brick-danger
 *     Submit (per the MYND-108 confirmation gate)
 *
 * **Post-condition on resolve:** `Slot::Empty` + `<app_data_dir>/vault/`
 * recursively removed (modulo the per-file partial-fail surface).
 * Caller fires the `onDeleteVaultSuccess` callback, which App.tsx wires
 * to `reprobe()` on all three surfaces (Settings → Editor, Unlock
 * screen, Recovery phrase-entry). Boot routing then selects the return
 * surface by remaining vault count: picker at ≥2, unlock at 1, welcome
 * at 0.
 *
 * Slot stays Empty regardless of resolve vs reject — on the
 * Unlocked/Recovering arms the zeroize fires before unlink; on the
 * Empty + meta-exists arm the slot was already Empty entering the
 * call.
 *
 * **Rejection paths** (see `VaultDeleteError` for the full taxonomy):
 *   - `PartialDelete { remaining_count }` — real user-facing
 *     scenario (AV scanner / Spotlight / OneDrive sync file lock).
 *     UI: post-fail mode banner with count + vault path + Continue
 *     button → same Welcome transition as happy-path.
 *   - `Io { io_error_kind }` — rare pre-walk filesystem failure.
 *     UI: generic disk-error banner + Continue.
 *   - `VaultBusyAuth` / `VaultNotUnlocked` / `VaultNotFound` —
 *     UI/router bug indicators; `mapDeleteVaultError` returns
 *     `{ kind: "bug-canary" }` for all three (dev-only `console.warn`,
 *     no user banner). `VaultNotUnlocked` is unreachable from current
 *     backend paths but retained in the wire format for forward
 *     compatibility.
 */
export async function deleteVault(vaultId: string): Promise<void> {
  // SYNC-6 explicit-id targeting (MYND-205), REQUIRED since #250: pass the
  // chosen vault's canonical hyphenated `VaultId` string to erase exactly
  // `vaults/<id>/`, leaving any sibling vault untouched.
  //
  // The parameter used to be optional, falling back to "the active vault" —
  // and that fallback was the bug. `deleteVault()` with no argument compiled
  // and read as correct at four call sites, two of which had the id sitting in
  // scope; on a device with ≥2 vaults it silently erased whichever vault a
  // best-effort disk cache happened to name. Making it required moves that
  // class of mistake to compile time, which is why the type is `string` and
  // not `string | undefined`.
  await invoke<void>("plugin:vault-delete|vault_delete", { vaultId });
}
