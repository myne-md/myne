// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/notes/error.rs              (NoteListError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_list` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Success-side wire shape (for completeness): `note_list` returns
 * `string[]` on success — each element is a canonical lowercase-
 * hyphenated 36-char UUIDv7 (`NoteId`'s `Serialize` impl in Rust).
 *
 * Variant set is **closed and asymmetric** vs the other four notes
 * commands' error enums: list operates on **no specific note** and
 * performs **no decryption**, so `NoteNotFound`, `CannotDecrypt`,
 * `InvalidNoteId`, `PlaintextTooLarge`, `NoteAlreadyExists`,
 * `InvalidPlaintextEncoding` are all not applicable. The 4 retained
 * variants mirror the matching variants in the other four enums
 * byte-for-byte (review-fatigue unification per `decisions.md`
 * 2026-05-06 "Naming-discipline > scenario-optimization"). Adding a
 * variant is an IPC contract change that requires updating both the
 * Rust enum and this mirror in the same change.
 */
export type NoteListError =
  /** Slot is `Empty` or `Recovering` — UI router should have caught this. */
  | { kind: "VaultNotUnlocked" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory —
   * defensive bug-canary. UI: render
   * `<FailClosedError reason="invalid-state" />`.
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * Filesystem failure on `read_dir` or per-entry enumeration.
   * `NotADirectory` / `AlreadyExists` are special-cased upstream as
   * `NotesDirNotADirectory`; only `PermissionDenied` / `NoSpace` /
   * `Other` surface here.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `Io` variant. */
export function isListIoError(
  e: NoteListError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
