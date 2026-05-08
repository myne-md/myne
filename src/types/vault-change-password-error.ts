// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                          (IoFailureKind)
//   - src-tauri/src/plugins/vault_change_password/error.rs       (VaultChangePasswordError)
//
// Plan: derive `ts_rs::TS` on those enums, run `cargo test` to emit
// the file at this path, and have CI fail if `git diff --exit-code`
// shows drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enum must be reflected here in the same change.
//
// **Mirrors `vault-unlock-error.ts` and `vault-recovery-error.ts` in
// shape.** All three files import the same `IoFailureKind` (top-level
// helper at `src-tauri/src/io_failure_kind.rs`) and use the same
// `#[serde(tag = "kind", content = "detail")]` wire convention. The
// variants `InvalidCredentialOrVault`, `InvalidVaultMeta`,
// `WeakNewPassword`, and `JoinFailure` share their **names** (and
// JSON wire encodings) with sibling-plugin variants per the
// cross-plugin shared-name discipline pinned by `decisions.md`
// 2026-05-02 "Recovery error discipline parallels unlock" + the
// project-wide "naming-discipline > scenario-optimization" rule from
// MYND-22 grilling Q6. Distinct TS types, identical kind tag,
// identical absence of payload (where applicable).

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the
 * `vault-change-password` Tauri plugin's `commit` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type VaultChangePasswordError =
  /**
   * AEAD-tag failure on the **current** password's wrap-key during
   * the re-auth step. **By design this single tag does NOT
   * distinguish** "wrong current password" from "tampered password
   * section of vault.meta" — see `protocol.md` §7.3 +
   * `decisions.md` 2026-05-02 "Phase 1 unlock error discipline".
   *
   * The variant name is shared with `VaultUnlockError::InvalidCredentialOrVault`
   * and `VaultRecoveryError::InvalidCredentialOrVault` (distinct TS
   * types, identical name + shape) per the cross-plugin shared-name
   * discipline. Settings-form copy: LITERAL compound `"Yanlış mevcut
   * parola veya vault dosyası bozuk."`
   */
  | { kind: "InvalidCredentialOrVault" }
  /**
   * `vault.meta` is structurally malformed (bad magic, wrong length,
   * wrong protocol_version, invalid KDF block) OR the post-derivation
   * `items_key` wrap blob fails AEAD verification. Both share a
   * single user-facing CTA — the internal sub-stage is emitted via
   * Rust-side `tracing::error!(stage = "...")` for ops debugging only
   * and does NOT cross the IPC boundary as a distinguisher.
   *
   * Force-relock: slot drops to `Empty`; frontend routes to the
   * dedicated `<InvalidVaultMetaScreen />` (shared with the boot
   * probe's corrupted-vault path). Copy: "Vault file is unreadable.
   * Restore from a backup."
   */
  | { kind: "InvalidVaultMeta" }
  /**
   * Compare-and-swap mismatch between the slot-held
   * `vault_meta_bytes_hash` (captured at unlock time) and the SHA-256
   * of the on-disk `vault.meta` re-read just before the rewrite.
   * Indicates an external mutation — typically a parallel app
   * instance (dev + prod overlap, accidental double-launch) committed
   * a competing rewrite; could also indicate disk-level tampering.
   *
   * Force-relock: slot drops to `Empty`. Frontend UX: SUSPICION
   * signal banner, `"Vault başka bir oturumda değişti — yeniden
   * açın."` Distinct from `VaultLockedDuringChange` (informational)
   * — both drop the slot but carry different UX bandwidth.
   */
  | { kind: "VaultMetaChangedExternally" }
  /**
   * `vault_lock` (or another slot-dropping action) fired while the
   * `commit` command's Argon2id-bound derivation was running. The
   * post-Argon2id slot peek (option p) detected `Slot::Unlocked` had
   * been dropped to `Slot::Empty`; the rewrite was bailed without
   * touching `vault.meta`.
   *
   * Frontend UX: INFORMATIONAL banner, `"Şifre değişikliği iptal
   * edildi: kilit atıldı."` — not a suspicion signal; user can
   * just re-unlock with their CURRENT (unchanged) password.
   */
  | { kind: "VaultLockedDuringChange" }
  /**
   * Another Argon2id-bound auth operation is in flight — the shared
   * `auth_permits` Semaphore (capacity 1) is held by either
   * `vault_unlock`, `vault_recover_with_phrase`,
   * `vault_complete_recovery`, or this command's own duplicate
   * submit. Returned by Rust-side `Semaphore::try_acquire()` rather
   * than queued.
   *
   * **Not user-facing**: the Settings UI disables Submit during the
   * in-flight window. If the user ever sees this, it indicates a
   * UI-disable bug.
   */
  | { kind: "ChangePasswordInProgress" }
  /**
   * The slot is not `Slot::Unlocked` — either no vault is unlocked
   * (`Slot::Empty`) or a recovery is mid-flight (`Slot::Recovering`).
   * Password change requires an unlocked vault.
   *
   * **Not user-facing**: the Settings UI is unreachable when the
   * slot is not `Unlocked`; if this surfaces, a router bug.
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * User typed a new password identical to the current password
   * (compared as raw UTF-8 bytes BEFORE Argon2id). Pre-Argon2id
   * reject saves 2× Argon2id cost and avoids the silent-rotate
   * "I did nothing → nothing changed" UX violation.
   *
   * Frontend UX: form-level error `"Yeni parola mevcut parolayla
   * aynı."`
   */
  | { kind: "SamePasswordRejected" }
  /**
   * Backend min-length floor (`MIN_PASSWORD_LEN = 12` Unicode chars)
   * rejected the new password. The frontend `PasswordChangeForm`
   * (and its sibling `PasswordCreateForm`) already gate this via
   * the shared `PasswordInput` primitive; the backend is a structural
   * belt+suspenders defense
   * against frontend bypass per `decisions.md` 2026-05-06
   * "Auth-pipeline backend MIN_PASSWORD_LEN floor; project-wide
   * retroactive". Cross-plugin shared variant name with
   * `AppError::WeakNewPassword` and
   * `VaultRecoveryError::WeakNewPassword`. **Not** an entropy
   * guarantee.
   *
   * Frontend UX (defensive surface; usually unreachable because the
   * frontend gate fires first): `"Yeni parola en az 12 karakter
   * olmalı."`
   */
  | { kind: "WeakNewPassword" }
  /**
   * File-system IO failure during `vault.meta` read or atomic write.
   * The bounded `IoFailureKind` keeps OS error messages off the wire.
   */
  | { kind: "IoError"; detail: { io_error_kind: IoFailureKind } }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error
   * (panic in the blocking task, runtime shutdown). User-facing CTA
   * is "try again" — recoverable banner, not a credential error.
   * Cross-plugin shared variant name with `VaultUnlockError::JoinFailure`
   * and `VaultRecoveryError::JoinFailure`.
   */
  | { kind: "JoinFailure" };

/**
 * Type-narrowing helper. Use to access `e.detail.io_error_kind`
 * without a type assertion.
 */
export function isIoError(
  e: VaultChangePasswordError,
): e is { kind: "IoError"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "IoError";
}
