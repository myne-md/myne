// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                  (IoFailureKind)
//   - core/src/plugins/vault_recover/error.rs      (VaultRecoveryError)
//
// Plan: derive `ts_rs::TS` on those enums, run `cargo test` to emit
// the file at this path, and have CI fail if `git diff --exit-code`
// shows drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enums must be reflected here in the same change.
//
// **Mirrors `vault-unlock-error.ts` in shape.** Both files import the
// same `IoFailureKind` (top-level helper at
// `core/src/io_failure_kind.rs`) and use the same
// `#[serde(tag = "kind", content = "detail")]` wire convention. The
// variant `InvalidCredentialOrVault` shares its **name** with
// `VaultUnlockError::InvalidCredentialOrVault` per `decisions.md`
// 2026-05-02 "Recovery error discipline parallels unlock", distinct
// TS types, identical kind tag, identical absence of payload. Do not
// merge the two unions; the plugin-error coupling is intentional.

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the
 * `vault-recover` Tauri plugin's commands (`recover_with_phrase`,
 * future `complete_recovery`).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type VaultRecoveryError =
  /**
   * `vault.meta` does not exist at the expected path. Frontend (B4b)
   * routes to vault-creation flow rather than the recovery screen,
   * the recovery flow is unreachable when no vault exists.
   */
  | { kind: "VaultNotFound" }
  /**
   * AEAD-tag failure on the recovery wrap-key. **By design this
   * single tag does NOT distinguish** "wrong phrase" from "tampered
   * recovery section of vault.meta", see
   * `agent-tooling/docs/spec/recovery-flow.md` § 3.4:
   *
   * > Tag-verification failure means either the phrase was entered
   * > wrong or the `vault.meta` was tampered. The client MUST NOT
   * > distinguish these two cases to the user beyond "phrase or
   * > vault is invalid".
   *
   * The variant name is shared with `VaultUnlockError::InvalidCredentialOrVault`
   * (distinct TS type, identical name + shape) per `decisions.md`
   * 2026-05-02 "Recovery error discipline parallels unlock". Frontend
   * maps to a screen-aware string, B4b copy: "Phrase or vault is
   * invalid, please retry."
   */
  | { kind: "InvalidCredentialOrVault" }
  /**
   * `vault.meta` is structurally malformed (bad magic, wrong length,
   * wrong protocol_version, invalid KDF block) OR the post-derivation
   * `items_key` wrap blob fails AEAD verification after the recovery
   * wrap-key has already verified. Both share a single user-facing
   * CTA, the internal sub-stage is emitted via Rust-side
   * `tracing::error!(stage = "...")` for ops debugging only and does
   * NOT cross the IPC boundary as a distinguisher.
   *
   * B4b copy: "Vault file is unreadable. Restore from a backup."
   * **Not** "use a different phrase", recovery does not get a
   * second chance here, the file is structurally broken.
   */
  | { kind: "InvalidVaultMeta" }
  /**
   * File-system IO failure while reading `vault.meta`. The bounded
   * [`IoFailureKind`] keeps OS error messages off the wire. Frontend
   * i18n maps each `io_error_kind` value to a user-facing message.
   */
  | { kind: "IoError"; detail: { io_error_kind: IoFailureKind } }
  /**
   * Another Argon2id-bound auth operation is currently in flight,
   * the shared `auth_permits` Semaphore (capacity 1) is held by
   * either `vault_unlock`, `vault_recover_with_phrase`, or
   * `vault_complete_recovery`. Returned by Rust-side
   * `Semaphore::try_acquire()` rather than queued (see
   * `decisions.md` 2026-05-02 "Slot state machine + auth_permits
   * generalization", recovery-flow.md § 3.3 reject-not-queue
   * posture, generalized across plugins).
   *
   * **Not user-facing**: B4b holds an `inFlight` boolean locally and
   * disables Submit during the in-flight window. If the user ever
   * sees this, it indicates a UI-side disable bug.
   */
  | { kind: "RecoveryInProgress" }
  /**
   * A vault-import run is holding THIS vault open as a read-only source
   * (myne-md/myne#464). The slot map is keyed by `VaultId`, so a recovery would
   * have to evict a key context the import is actively reading through.
   *
   * **User-facing**, unlike `RecoveryInProgress` one line above, for the reason
   * its unlock-side twin gives: that variant's window is one the frontend
   * disables Submit across, and this state has no such window.
   */
  | { kind: "VaultOpenAsImportSource" }
  /**
   * The vault is already unlocked (`Slot::Unlocked`). Returned by
   * the slot-peek guard when a recovery attempt arrives with a
   * fully-unlocked vault.
   *
   * **Not user-facing**: frontend routes the user to the editor
   * when the slot is Unlocked; if this surfaces from a recovery
   * attempt, a router bug.
   */
  | { kind: "VaultAlreadyUnlocked" }
  /**
   * A previous recovery (A8d) succeeded but the chained password
   * commit (A8f) has not run yet, the slot is `Slot::Recovering`.
   * A fresh recovery attempt cannot start while the old one is
   * pending its password commit per `recovery-flow.md` § 4.1's
   * "non-dismissible mandatory chained step" rule. The user must
   * either complete the password reset (A8f) or `vault_lock` to
   * abort.
   *
   * **Not user-facing**: frontend routes the user to the password-
   * reset form when `vault_status` returns `Recovering`; if this
   * surfaces from a recovery attempt, a router bug.
   */
  | { kind: "RecoveryAlreadyInProgress" }
  /**
   * `vault_complete_recovery` was invoked but the slot is not in
   * `Slot::Recovering`, either no recovery has started
   * (`Slot::Empty`) or the vault is already fully unlocked
   * (`Slot::Unlocked`). The post-recovery password commit can only
   * run against an in-flight recovery session per
   * `recovery-flow.md` § 4.1.
   *
   * **Not user-facing**: frontend routes the user via `vault_status`
   * and only invokes `vault_complete_recovery` when the slot is
   * Recovering; if this surfaces, a router bug.
   */
  | { kind: "VaultRecoveryRequiresActiveSession" }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error
   * (panic in the blocking task, runtime shutdown). User-facing
   * CTA is "try again", recoverable banner, not a credential error.
   */
  | { kind: "JoinFailure" }
  /**
   * `vault_lock` (or another slot-dropping action) fired while
   * `complete_recovery`'s Argon2id-bound derivation ran in
   * `spawn_blocking`, the post-Argon2id slot peek found
   * `Slot::Recovering` dropped to `Slot::Empty`; the rewrite was
   * bailed without touching `vault.meta` and the recovery material
   * zeroized with the slot. The user restarts from A8d
   * (phrase-entry). Symmetric with `VaultLockedDuringChange`
   * (change-password). Contract is vacuous-by-affordance-absence
   * today (no Cancel during decrypting per `recovery-flow.md` §3.3)
   * but pinned for any future Cancel affordance.
   *
   * (MYND-219 / SYNC-18(c): mirror drift fix, the variant existed
   * Rust-side without a TS twin.)
   */
  | { kind: "RecoveryAbortedByLock" }
  /**
   * Backend min-length floor (`protocol::MIN_PASSWORD_LEN`, 12
   * Unicode chars) rejected the new password chosen during the
   * post-recovery password reset (A8f). The frontend form already
   * gates this; the backend arm is belt+suspenders against a
   * frontend bypass. Shared variant name with the creation /
   * change-password `WeakNewPassword`.
   *
   * (MYND-219 / SYNC-18(c): mirror drift fix, the variant existed
   * Rust-side without a TS twin.)
   */
  | { kind: "WeakNewPassword" };

/**
 * Type-narrowing helper. Use to access `e.detail.io_error_kind`
 * without a type assertion.
 */
export function isIoError(
  e: VaultRecoveryError,
): e is { kind: "IoError"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "IoError";
}
