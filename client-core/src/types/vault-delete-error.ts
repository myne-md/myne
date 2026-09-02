// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                   (IoFailureKind)
//   - src-tauri/src/plugins/vault_delete/error.rs        (VaultDeleteError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the
 * `vault-delete` Tauri plugin's `vault_delete` command (MYND-105).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change. `decisions.md` 2026-05-26 entries (a)-(d) anchor the
 * design rationale across all 5 variants.
 *
 * Three variants (`VaultBusyAuth`, `VaultNotUnlocked`, `VaultNotFound`)
 * are **UI/router bug indicators** in normal flow (Settings being open
 * implies `Slot::Unlocked` + `vault.meta` on disk + no other auth op
 * in flight). Frontend handling at `mapDeleteVaultError` returns
 * `null` for these + dev-only `console.warn`. The two user-facing
 * variants are `PartialDelete` (real partial-fail scenario: AV
 * scanner / Spotlight / OneDrive sync file locks) and `Io` (rare
 * pre-walk filesystem failure).
 */
export type VaultDeleteError =
  /**
   * Another auth-pipeline op (vault_unlock / vault_recover_with_phrase /
   * vault_complete_recovery / vault_change_password) holds the
   * capacity-1 `auth_permits` semaphore. `vault_delete` uses
   * `try_acquire` (reject, never queue) per `decisions.md`
   * 2026-05-02 + 2026-05-26 entry (b). UI/router bug indicator,
   * Settings should never fire vault_delete while change_password is
   * mid-Argon2id (AccountPanel's view state machine renders the
   * Delete affordance only in `view === "idle"`, not `"change-password"`).
   */
  | { kind: "VaultBusyAuth" }
  /**
   * `Slot::Empty` AND `vault.meta` exists on disk. Bug-canary
   * (`decisions.md` 2026-05-26 entry (b)). UI/router bug indicator,
   * the Settings shell mounts only inside the Editor, which requires
   * `Slot::Unlocked`; if this fires, the React Stage state and the
   * Rust slot have desynced (a different bug entirely).
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * `Slot::Empty` AND `vault.meta` missing on disk. UI/router bug
   * indicator, Settings being open implies a vault exists.
   * Idempotent no-op success was deliberately rejected in favor of
   * this explicit rejection per `decisions.md` 2026-05-26 entry (b).
   */
  | { kind: "VaultNotFound" }
  /**
   * One or more files in `<vault>/` could not be unlinked during the
   * recursive walk (AV scanner / Spotlight / OneDrive sync file
   * locks, FS permission denied, etc.). `remaining_count` is the
   * count of failures the walk collected; per-file paths are NOT
   * surfaced (DENY-list discipline). The slot zeroize fired BEFORE
   * the unlink loop (per backend's `take_and_run_blocking`
   * drop-before-spawn_blocking ordering), so partial-fail does NOT
   * weaken the cryptographic-erase claim, orphan ciphertext bytes
   * remain Argon2id-wrapped junk without the in-memory keys.
   *
   * User-facing recovery: manual cleanup of the vault directory
   * (path resolved UI-side via `tauri::api::path::app_data_dir()` +
   * displayed in the Delete vault confirmation form's post-fail
   * banner). v0.2 in-app cleanup is tracked under Plane MYND-159
   * (`vault_repair`); user-facing copy does NOT reference v0.2
   * vault_repair (no vaporware per PRODUCT.md design principle 3).
   */
  | { kind: "PartialDelete"; detail: { remaining_count: number } }
  /**
   * Filesystem IO failure outside the per-file unlink loop,
   * typically `read_dir` failure when enumerating the vault
   * directory itself, before per-file unlink has started. Per-file
   * failures accumulate into `PartialDelete` instead. The closed
   * [`IoFailureKind`] keeps OS error messages (which may contain
   * kernel-dependent path strings on some platforms) off the wire.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } };

/** Type-narrowing helper for the `PartialDelete` variant. */
export function isPartialDeleteError(
  e: VaultDeleteError,
): e is { kind: "PartialDelete"; detail: { remaining_count: number } } {
  return e.kind === "PartialDelete";
}

/** Type-narrowing helper for the `Io` variant. */
export function isVaultDeleteIoError(
  e: VaultDeleteError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
