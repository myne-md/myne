// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/vault_unlock/error.rs       (VaultUnlockError)
//
// Plan: derive `ts_rs::TS` on those enums, run `cargo test` to emit
// the file at this path, and have CI fail if `git diff --exit-code`
// shows drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enums must be reflected here in the same change.
//
// **Distinct from `IoErrorKind` in protocol-error.ts.** That mirror
// covers the inline `IoErrorKind` enum local to the `vault_creation`
// plugin (predates the top-level helper). `IoFailureKind` below is
// the repo-wide canonical enum from `src-tauri/src/io_failure_kind.rs`
// (introduced by `vault-unlock-password` Task 1) and is what the
// `VaultUnlockError::IoError` variant carries. The two error-mapping
// enums temporarily coexist; migration is a separate follow-on.

/**
 * Bounded categorization of `std::io::ErrorKind` for IPC surfaces
 * exposed by the `vault-unlock` Tauri plugin (and, in the future,
 * `vault-change-password`, `vault-backup`, etc.).
 *
 * Wire shape: bare quoted variant name. The Rust enum derives only
 * `Serialize` (no `#[serde(tag = ...)]`), so unit variants serialize
 * as JSON strings — `"PermissionDenied"`, `"NotFound"`, etc. The TS
 * mirror is therefore a string-literal union, NOT an object with a
 * `kind` field.
 *
 * No `String` payload anywhere — OS error messages (which on some
 * kernels include path strings) are dropped at the
 * `from_io_error_kind` boundary in Rust.
 */
export type IoFailureKind =
  | "PermissionDenied"
  | "NotFound"
  | "NoSpace"
  | "Other";

/**
 * Single error type returned across the IPC boundary by the
 * `vault-unlock` Tauri plugin's commands (`unlock`, `lock`).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type VaultUnlockError =
  /**
   * `vault.meta` does not exist at the expected path. Frontend (B4a)
   * routes to vault-creation flow rather than showing the unlock
   * screen — first-run UX.
   */
  | { kind: "VaultNotFound" }
  /**
   * AEAD-tag failure on the password wrap-key. **By design this
   * single tag does NOT distinguish** "wrong password" from
   * "tampered password section of vault.meta" — see
   * `docs/spec/protocol.md` § 7.3:
   *
   * > Tag-verification failure means either the phrase was entered
   * > wrong or the `vault.meta` was tampered. The client MUST NOT
   * > distinguish these two cases to the user beyond "phrase or
   * > vault is invalid".
   *
   * B4a copy: "Password or vault is invalid."
   */
  | { kind: "InvalidCredentialOrVault" }
  /**
   * `vault.meta` is structurally malformed (bad magic, wrong length,
   * wrong protocol_version, invalid KDF block) OR the post-derivation
   * `items_key` wrap blob fails AEAD verification. Both share a
   * single user-facing CTA — the internal sub-stage is emitted via
   * Rust-side `tracing::error!(stage = "...")` for ops debugging
   * only and does NOT cross the IPC boundary as a distinguisher.
   *
   * B4a copy: "Vault file is unreadable. Restore from a backup."
   * **Not** "use recovery" — recovery also requires parsing
   * `vault.meta` (specifically `salt_recovery` + `nonce_recovery_wrap`),
   * so a corrupt header strands the phrase too. See `decisions.md`
   * 2026-05-02 (Phase 1 unlock error discipline).
   */
  | { kind: "InvalidVaultMeta" }
  /**
   * File-system IO failure while reading `vault.meta`. The bounded
   * [`IoFailureKind`] keeps OS error messages off the wire. Frontend
   * i18n maps each `io_error_kind` value to a user-facing message
   * (e.g., `"PermissionDenied"` → "Could not read vault. Check
   * permissions or try again.").
   */
  | { kind: "IoError"; detail: { io_error_kind: IoFailureKind } }
  /**
   * Another unlock attempt is already in progress — the unlock
   * permit (`Semaphore` capacity 1) is held. Returned by Rust-side
   * `Semaphore::try_acquire()` rather than queued (see
   * `decisions.md` 2026-05-02 Phase 1 unlock UI semantics —
   * recovery-flow.md § 3.3 reject-not-queue posture).
   *
   * **Not user-facing**: B4a holds an `inFlight` boolean locally
   * and disables Submit during the in-flight window. If the user
   * ever sees this, it indicates a UI-side disable bug.
   */
  | { kind: "UnlockInProgress" }
  /**
   * A vault-import run is holding THIS vault open as a read-only source
   * (myne-md/myne#464). The slot map is keyed by `VaultId`, so unlocking it
   * would have to evict a key context the import is actively reading through.
   *
   * **User-facing**, unlike `UnlockInProgress` one line above. That variant is
   * documented as not user-facing because the frontend disables Submit for its
   * whole window; this state has no such window. The user reaches it
   * deliberately (start an import, then try to unlock its source vault) and
   * resolves it themselves: finish or cancel the import, or wait for the import
   * slot's TTL.
   */
  | { kind: "VaultOpenAsImportSource" }
  /**
   * A vault import was asked for with NO vault unlocked to import into
   * (myne-md/myne#464).
   *
   * **Not user-facing.** The import flow is reachable only from the editor,
   * which exists only while a vault is unlocked, so seeing this means a router
   * bug. It is mirrored here because a variant the frontend cannot name is a
   * variant it silently falls through on, and because the host answers it as a
   * hard precondition rather than as a UI assumption: without it a second
   * vault's keys could be held with no session to bound them, which is outside
   * what `threat-model.md` A6's amendment describes.
   */
  | { kind: "NoActiveVaultToImportInto" }
  /**
   * The vault is already unlocked. Returned by the slot-peek guard
   * when an unlock attempt arrives with the slot occupied by
   * `Slot::Unlocked(_)`.
   *
   * **Not user-facing**: frontend routes the user to the editor
   * when the slot is occupied; if this surfaces, a router bug.
   */
  | { kind: "VaultAlreadyUnlocked" }
  /**
   * A recovery flow is in progress (`Slot::Recovering`) — the user
   * has successfully recovered with their phrase but has not yet
   * committed a new master password via `vault_complete_recovery`.
   * `vault_unlock` is structurally rejected during this window per
   * `docs/spec/recovery-flow.md` § 4.1's "non-dismissible mandatory
   * chained step" rule.
   *
   * **Not user-facing**: frontend routes the user to the password-
   * reset form when `vault_status` returns `Recovering`; if this
   * surfaces from `vault_unlock`, a router bug. Added by Task 3 of
   * `vault-recovery-from-phrase`.
   */
  | { kind: "VaultRecoveryInProgress" }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error
   * (panic in the blocking task, runtime shutdown). User-facing
   * CTA is "try again" — recoverable banner, not a credential error.
   */
  | { kind: "JoinFailure" }
  /**
   * The vault's declared Argon2id memory cost is more than **this client
   * build** can service, so the unlock was refused before any derivation
   * was attempted (phase3-web-client task 31).
   *
   * **Web-only in practice.** `HostCtx::max_kdf_memory_kib` is `None` on
   * desktop and mobile — their ceiling is the machine's, which the
   * allocator reports honestly — so this variant is unreachable there. The
   * web client declares 1 GiB, because on `wasm32` an over-large Argon2id
   * block is not a catchable allocation failure but an abort: the Worker
   * dies and the user gets no cause at all.
   *
   * **Not a protocol judgement and not a corrupt vault.** The parameters
   * are legal — `validate_kdf_params` accepts up to 4 GiB — and the vault
   * opens normally on desktop. That is why this is its own variant rather
   * than `InvalidVaultMeta`, whose CTA ("restore from a backup") would be
   * actively wrong advice here: nothing is damaged.
   *
   * Both figures are MiB and both are public — `required_mib` is read from
   * the unencrypted `vault.meta` KDF block (`protocol.md` §4.2 makes it
   * deliberately inspectable), `available_mib` is a property of the client
   * build — so the banner can name real numbers.
   */
  | {
      kind: "KdfMemoryExceedsHostCapability";
      detail: { required_mib: number; available_mib: number };
    }
  /**
   * The `vault.meta` magic is a newer major version this build does not
   * implement (`protocol.md` §10.5 anti-downgrade). Same "distinct advice, not
   * corrupted" reasoning as `KdfMemoryExceedsHostCapability`: the vault is fine,
   * this app is too old — the CTA is **update this app**, never "restore a
   * backup". This build handles `MYV1` + `NTV5`, so it reaches this only on a
   * hypothetical later major; an un-upgraded older build hits it on a migrated
   * `NTV5` vault. Never a silent half-parse.
   */
  | { kind: "VaultUpgradedUnsupported" };

/**
 * Type-narrowing helper. Use to access `e.detail.io_error_kind`
 * without a type assertion:
 *
 * ```ts
 * if (isIoError(e)) {
 *   switch (e.detail.io_error_kind) {
 *     case "PermissionDenied": ...
 *     case "NotFound":         ...
 *     case "NoSpace":          ...
 *     case "Other":            ...
 *   }
 * }
 * ```
 */
export function isIoError(
  e: VaultUnlockError,
): e is { kind: "IoError"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "IoError";
}
