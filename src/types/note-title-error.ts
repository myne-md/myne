// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs              (IoFailureKind)
//   - core/src/plugins/notes/error.rs          (NoteTitleError, NoteTitleBatchError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Per-item error returned by the `notes:note_titles_batch` Tauri command
 * for a single ID inside the batch. The batch outer Result carries
 * `NoteTitleBatchError` for preconditions that abort the whole call;
 * individual notes that fail decrypt or are race-deleted surface here
 * without aborting peers (2026-05-15 MYND-82 grill Q4 per-item Result).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * `InvalidNoteId` is **not** a per-item variant. The implementation maps
 * malformed `note_id` strings to `NoteNotFound` (no file exists under
 * the parsed path; the canonical ID set comes from `note_list`, so
 * anything else is a UI bug).
 */
export type NoteTitleError =
  /** AEAD-tag failure on the per-note `decode_note`. §6.4 non-distinguishing. */
  | { kind: "CannotDecrypt" }
  /**
   * `<vault>/notes/<note_id>.myn` does not exist — covers both the
   * `note_list` / `note_titles_batch` race (delete in between) AND
   * malformed `note_id` strings.
   */
  | { kind: "NoteNotFound" }
  /**
   * Per-file IO failure during the blob read. `NotFound` is special-
   * cased upstream as `NoteNotFound`.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** Per-item `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/**
 * Batch-level error returned by `note_titles_batch` when a precondition
 * fails and the whole call aborts before per-item decryption begins.
 */
export type NoteTitleBatchError =
  /** Slot is `Empty` or `Recovering` — UI router should have caught this. */
  | { kind: "VaultNotUnlocked" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory —
   * defensive bug-canary parallel to the other notes-error enums.
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * Input `ids.length` exceeded the per-call cap. The cap value is
   * carried in the payload so callers don't hard-code the limit.
   * Pinned by 2026-05-15 MYND-82 grill Q5 = 100.
   */
  | { kind: "BatchTooLarge"; detail: { cap: number } }
  /** Filesystem failure during `notes_dir` resolution. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** Batch-coordinator-level `spawn_blocking` panic. Reserved for forward-compat. */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the batch-level `BatchTooLarge` variant. */
export function isBatchTooLarge(
  e: NoteTitleBatchError,
): e is { kind: "BatchTooLarge"; detail: { cap: number } } {
  return e.kind === "BatchTooLarge";
}

/**
 * Wire shape of the per-item slice payload returned by
 * `note_titles_batch` for `Ok` results — the hybrid byte-range design
 * per the 2026-05-15 MYND-82 grill Q3. UI parses these slices via the
 * TS dialect module (js-yaml + first-H1 line strip).
 */
export type TitleSlice = {
  note_uuid: string;
  frontmatter_bytes: string | null;
  first_h1_line: string | null;
};
