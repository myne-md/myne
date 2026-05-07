// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/notes/error.rs              (NoteUpdateError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_update` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type NoteUpdateError =
  /** Slot is `Empty` or `Recovering` — UI router should have caught this. */
  | { kind: "VaultNotUnlocked" }
  /** UI bug-canary; backend always returns canonical v7 UUIDs. */
  | { kind: "InvalidNoteId" }
  /**
   * `<vault>/notes/<note_id>.myn` does not exist. Autosave-after-delete
   * race signal — UI folds to "kullanıcı sildi, autosave yetişemedi".
   * Distinct from `CannotDecrypt` (no credential leak; vault was
   * already unlocked).
   */
  | { kind: "NoteNotFound" }
  /** Plaintext exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB). */
  | { kind: "PlaintextTooLarge" }
  /**
   * AEAD-tag failure on the existing blob. Single non-distinguishing
   * tag per `protocol.md` §6.4; sub-cause flows through Rust-side
   * `tracing::debug!` only.
   */
  | { kind: "CannotDecrypt" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory —
   * defensive bug-canary. UI: render
   * `<FailClosedError reason="invalid-state" />`.
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * Residual filesystem failure. `NotFound` / `NotADirectory` /
   * `AlreadyExists` are special-cased upstream; only `PermissionDenied`
   * / `NoSpace` / `Other` surface here.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `Io` variant. */
export function isUpdateIoError(
  e: NoteUpdateError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
