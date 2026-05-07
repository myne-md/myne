// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/notes/error.rs              (NoteCreateError)
//
// Plan: derive `ts_rs::TS` on those enums, run `cargo test` to emit
// the file at this path, and have CI fail if `git diff --exit-code`
// shows drift between the committed file and the regenerated one.
//
// Until then: this file is the manual mirror. Every variant change in
// the Rust enum must be reflected here in the same change.

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_create` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 *
 * UI mapping is per the PRD's "Implementation Decisions" table; copy
 * lives in the editor / sidebar i18n catalog (Furkan B5).
 */
export type NoteCreateError =
  /**
   * Slot is `Empty` or `Recovering`. Frontend routes the user to the
   * lock screen via `vault_status` / `vault_slot_kind`; if this
   * surfaces from `note_create`, a router bug.
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * `<vault>/notes/<note_id>.myn` already exists. Backend-generated
   * UUIDv7 makes a real collision astronomically improbable; this
   * variant is the canary the `atomic_write(replace=false)` helper
   * guarantees per `src-tauri/CLAUDE.md` "Defensive guards".
   *
   * **Not user-facing in normal flow.** If this surfaces, the editor
   * should retry with a fresh `note_create` (which mints a new
   * UUIDv7) rather than show a user-visible error.
   */
  | { kind: "NoteAlreadyExists" }
  /**
   * Plaintext exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB). UI:
   * "Bu not 16 MiB sınırını aşıyor; attachment desteği Phase 1.5+'da
   * geliyor."
   */
  | { kind: "PlaintextTooLarge" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory
   * — defensive edge case for OS-level user manipulation of the vault
   * directory. UI: "Vault directory'nizde 'notes' adlı bir dosya var.
   * Lütfen kaldırın veya vault'u taşıyın."
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * File-system IO failure during `notes_dir` resolution or
   * `atomic_write`. The bounded {@link IoFailureKind} keeps OS error
   * messages off the wire. Frontend i18n maps each `io_error_kind`
   * value to a user-facing message.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error
   * (panic in the blocking task, runtime shutdown). Includes the
   * `unreachable!` panic path for `encode_new_note` AEAD seal failure
   * (impossible under v0.1 fixed parameters; if it ever fires, it's
   * caught here). User-facing CTA is "try again" — recoverable
   * banner, not a structural error.
   */
  | { kind: "JoinFailure" };

/**
 * Type-narrowing helper for the `Io` variant.
 *
 * ```ts
 * if (isCreateIoError(e)) {
 *   switch (e.detail.io_error_kind) {
 *     case "PermissionDenied": ...
 *     case "NotFound":         ...
 *     case "NoSpace":          ...
 *     case "Other":            ...
 *   }
 * }
 * ```
 */
export function isCreateIoError(
  e: NoteCreateError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
