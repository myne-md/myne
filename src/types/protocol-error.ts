// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - protocol/src/error.rs        (ProtocolError)
//   - src-tauri/src/plugins/vault_creation/error.rs  (AppError, IoErrorKind)
//
// Plan: derive `ts_rs::TS` on those enums, run `cargo test` to emit
// the file at this path, and have CI fail if `git diff --exit-code`
// shows drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enums must be reflected here in the same change.

/**
 * Failure modes emitted by the `protocol` Rust crate.
 *
 * Wire shape: `#[serde(tag = "kind")]` — `{"kind": "<VariantName>"}`.
 * No payload fields anywhere; all variants are unit (load-bearing
 * discipline — see `protocol/src/error.rs` doc comment).
 */
export type ProtocolError =
  | { kind: "InvalidPassword" }
  | { kind: "PasswordTooShort" }
  | { kind: "KdfFailure" }
  /**
   * AEAD failure — wrong password/phrase OR tampered vault. Spec
   * § 7.3 requires that the client NOT distinguish these cases to
   * the user beyond "phrase or vault is invalid".
   */
  | { kind: "AeadFailure" }
  | { kind: "InvalidVaultMeta" }
  | { kind: "AccountNumberInvalid" }
  | { kind: "Csprng" };

/**
 * Bounded categorization of file-system failures.
 *
 * No `String` field (path leakage prevention — see
 * `src-tauri/src/plugins/vault_creation/error.rs`). Frontend i18n
 * maps each variant to a user-facing message.
 */
export type IoErrorKind =
  | { kind: "PermissionDenied" }
  | { kind: "NoSpace" }
  | { kind: "NotFound" }
  | { kind: "Other" };

/**
 * Single error type returned across the IPC boundary by the
 * `vault-creation` Tauri plugin (`begin` / `commit` / `cancel`).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 */
export type AppError =
  /**
   * Protocol-layer failure bubbled up from the `protocol` Rust crate.
   * `detail` is the inner `ProtocolError` (also `tag = "kind"`-shaped).
   */
  | { kind: "Protocol"; detail: ProtocolError }
  /**
   * Session token not present in the live map (already committed,
   * already cancelled, never existed, or evicted longer than
   * `TOMBSTONE_RETENTION_SECS` ago — caller cannot tell which).
   */
  | { kind: "SessionNotFound" }
  /**
   * Session was evicted by the TTL background task (~10 minutes
   * after `begin`). Cleaner UX than `SessionNotFound` for the
   * "user walked away" case.
   */
  | { kind: "SessionExpired" }
  /**
   * Concurrent session cap (4) reached. Frontend should ask the user
   * to wait for an in-flight vault creation to finish or cancel.
   */
  | { kind: "TooManyConcurrentSessions" }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error
   * (panic in the blocking task, runtime shutdown, etc.). Internal —
   * frontend should surface a generic error.
   */
  | { kind: "JoinFailure" }
  /**
   * File-system error during `commit`. `detail.kind` discriminates
   * the bounded `IoErrorKind` enum.
   */
  | { kind: "Io"; detail: IoErrorKind }
  /**
   * Defensive belt+suspenders guard: `vault.meta` already exists at
   * the target path. **Expected to NEVER trigger in normal flow.**
   * Surfaces as a defensive UI message; if a real user sees it, the
   * frontend `vault_status` startup probe + state machine routing
   * has been bypassed and the bug is upstream of `commit`. The
   * alternative (silent overwrite) would destroy the prior vault's
   * `root_key`, recovery phrase derivation salts, and any sealed
   * `.myn` blobs irrecoverably. See `app-state-machine` PRD + grill
   * Q12.
   */
  | { kind: "VaultAlreadyExists" };

/**
 * Type-narrowing helper. `if (isProtocolError(e)) { e.detail.kind ... }`.
 */
export function isProtocolError(e: AppError): e is { kind: "Protocol"; detail: ProtocolError } {
  return e.kind === "Protocol";
}

/**
 * Type-narrowing helper. `if (isIoError(e)) { e.detail.kind ... }`.
 */
export function isIoError(e: AppError): e is { kind: "Io"; detail: IoErrorKind } {
  return e.kind === "Io";
}

/**
 * Result returned by the `vault-creation:begin` command.
 *
 * Mirrors `BeginResult` in `src-tauri/src/plugins/vault_creation/commands.rs`.
 */
export interface BeginResult {
  /**
   * 24-word BIP-39 English recovery phrase. Cloned from the
   * `RecoveryPhrase` master copy in the backend session; the master
   * stays Zeroized in Rust until `commit` consumes it.
   */
  phrase: string[];
  /**
   * Account-number display form: `"MY-XXXX-XXXX-XXXX-XXXX-XXXX"`
   * (27 ASCII bytes; the schematic `MY-XXXX-XXXX-XXXX-XXXX-X` shown
   * elsewhere in the spec is illustrative shorthand — the trailing
   * group is also 4 chars).
   */
  account_number: string;
  /**
   * Opaque UUIDv4 string. NOT a secret; the frontend holds it across
   * the confirmation challenge and replays it to `commit` / `cancel`.
   */
  session_token: string;
}
