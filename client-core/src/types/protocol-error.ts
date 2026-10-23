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
 * Wire shape: `#[serde(tag = "kind")]`, `{"kind": "<VariantName>"}`.
 * No payload fields anywhere; all variants are unit (load-bearing
 * discipline, see `protocol/src/error.rs` doc comment).
 */
export type ProtocolError =
  | { kind: "InvalidPassword" }
  | { kind: "PasswordTooShort" }
  | { kind: "KdfFailure" }
  /**
   * AEAD failure, wrong password/phrase OR tampered vault. Spec
   * § 7.3 requires that the client NOT distinguish these cases to
   * the user beyond "phrase or vault is invalid".
   */
  | { kind: "AeadFailure" }
  | { kind: "InvalidVaultMeta" }
  | { kind: "AccountNumberInvalid" }
  | { kind: "Csprng" }
  /**
   * The plaintext handed to an encode path exceeds the family's cap.
   * Mirrors `ProtocolError::PlaintextTooLarge` (`protocol/src/error.rs`),
   * which the mirror had drifted past (myne#289).
   */
  | { kind: "PlaintextTooLarge" };

/**
 * Bounded categorization of file-system failures.
 *
 * No `String` field (path leakage prevention, see
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
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, payload-
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
   * `TOMBSTONE_RETENTION_SECS` ago, caller cannot tell which).
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
   * (panic in the blocking task, runtime shutdown, etc.). Internal,
   * frontend should surface a generic error.
   */
  | { kind: "JoinFailure" }
  /**
   * File-system error during `commit`. `detail.kind` discriminates
   * the bounded `IoErrorKind` enum.
   */
  | { kind: "Io"; detail: IoErrorKind }
  /**
   * Defensive belt+suspenders guard: a recognized vault artefact is
   * already present at the target path. Recognized artefacts are
   * `vault.meta`, `vault.meta.tmp` (mid-write crash leftover), or a
   * `notes/` directory containing one or more `*.myn` files (orphan
   * blobs from a partial-fail `vault_delete`). **Expected to NEVER
   * trigger in normal flow.** Surfaces as a defensive UI message; if
   * a real user sees it, either (a) the frontend `vault_status`
   * startup probe + state machine routing has been bypassed (a bug
   * upstream of `commit`), the alternative (silent overwrite) would
   * destroy the prior vault's `root_key`, recovery phrase derivation
   * salts, and any sealed `.myn` blobs irrecoverably; or (b) a prior
   * `vault_delete` partial-fail left orphan artefacts the user must
   * manually clean (v0.2 `vault_repair`, Plane MYND-159, handles
   * this in-app).
   *
   * Renamed from `VaultAlreadyExists` on 2026-05-26 per `decisions.md`
   * "vault_create defensive guard extension". See `app-state-machine`
   * PRD + grill Q12 (original variant) + MYND-105 PRD + grill Q7
   * (semantic broadening).
   */
  | { kind: "VaultArtifactsPresent" }
  /**
   * Another vault.meta-lifecycle operation holds the single
   * `auth_permits` mutex. As of MYND-159 (`vault_repair`), `commit` is
   * pulled into the same capacity-1 semaphore that serializes
   * `vault_unlock` / `vault_recover_*` / `vault_change_password` /
   * `vault_delete`, so a concurrent `vault_repair` sweep can never race a
   * fresh `commit` (TOCTOU). `try_acquire` (reject, never queue); the
   * permit releases before `commit` returns so the auto-unlock chain's
   * `vault_unlock` acquires cleanly. **Normally unreachable in the create
   * flow**, at creation time there is no vault to unlock / change /
   * delete; this only fires against a racing `vault_repair`. Shares the
   * variant name with `VaultDeleteError::VaultBusyAuth`.
   */
  | { kind: "VaultBusyAuth" }
  /**
   * The master password is below the project-wide `MIN_PASSWORD_LEN` floor,
   * measured in **Unicode scalars** (`chars().count()`), not UTF-16 code units.
   *
   * Mirrors `VaultCreationError::WeakNewPassword`, which the union had drifted
   * past (myne#289). The absence was not cosmetic: `mapAppErrorToUserMessage`
   * ends in `default: assertNever(error)`, which THROWS, inside the creation
   * flow's own catch, so a password of >= 12 UTF-16 units but < 12 scalars
   * (any password with a non-BMP character near the floor) stranded the user on
   * the exit-less "Encrypting…" screen with no error, no retry and no Cancel.
   *
   * The frontend length gate now counts scalars too, so this variant is
   * unreachable from the form; it stays mapped because a direct-IPC caller can
   * still produce it, and because an unmapped variant is a hang.
   */
  | { kind: "WeakNewPassword" }
  /**
   * A person identity is sealed on this device but its session is not installed,
   * and a vault is being created under it (myne-md/myne#911 task 5).
   *
   * An `NTV7` vault's roster is signed by the OWNER, so creation needs the
   * private half of the identity keypair rather than only its public half.
   * Refusing is what keeps "one phrase per person" true: the legacy birth would
   * mint a second recovery phrase, and a partial frame would seal a vault nobody
   * can recover. Retryable: unlocking the identity is one action.
   */
  | { kind: "PersonLocked" };

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
   *
   * `null` for a PERSON-BORN vault (myne-md/myne#911 task 5): the vault
   * phrase is retired there, so the backend mints none, returns none and
   * wraps none. The identity phrase is the only recovery credential and it
   * already exists on the device. The creation flow skips the kit and the
   * type-back in that case rather than rendering an empty phrase grid.
   */
  phrase: string[] | null;
  /**
   * Account-number display form: `"MY-XXXX-XXXX-XXXX-XXXX-XXXX"`
   * (27 ASCII bytes; the schematic `MY-XXXX-XXXX-XXXX-XXXX-X` shown
   * elsewhere in the spec is illustrative shorthand, the trailing
   * group is also 4 chars).
   */
  account_number: string;
  /**
   * Opaque UUIDv4 string. NOT a secret; the frontend holds it across
   * the confirmation challenge and replays it to `commit` / `cancel`.
   */
  session_token: string;
}
