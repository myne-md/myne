// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                  (IoFailureKind)
//   - core/src/plugins/notes/error.rs              (NoteDeleteError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_delete` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type NoteDeleteError =
  /** Slot is `Empty` or `Recovering`, UI router should have caught this. */
  | { kind: "VaultNotUnlocked" }
  /** UI bug-canary; backend always returns canonical v7 UUIDs. */
  | { kind: "InvalidNoteId" }
  /**
   * `<vault>/notes/<note_id>.myn` does not exist. Strict at IPC,
   * idempotent at UI, second `noteDelete(id)` for the same id
   * returns this; UI folds to "note already gone".
   */
  | { kind: "NoteNotFound" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory,
   * defensive bug-canary. UI: render
   * `<FailClosedError reason="invalid-state" />`.
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * Residual filesystem failure on `remove_file` or Unix parent-dir
   * `sync_all`. `NotFound` / `NotADirectory` / `AlreadyExists` are
   * special-cased upstream.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };
