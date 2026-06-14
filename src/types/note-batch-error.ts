// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/notes/error.rs              (NoteBatchError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * plugin's `note_write_batch_transactional` command — the §8.3 / WL-7
 * all-or-nothing multi-note rewrite that backs wikilink rename
 * auto-update (MYND-85).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`. The variant
 * set is **identical to `NoteUpdateError`** by design — the batch is N
 * `note_update` AEAD pipelines committed under one transaction, so every
 * per-note failure mode is reachable. A failure on ANY note aborts the
 * WHOLE batch with the vault left pre-rename; there is no per-item
 * partial-success surface, and the tag never names which note failed.
 *
 * Variant set is closed; adding a variant is an IPC contract change that
 * requires updating both the Rust enum and this mirror in the same change.
 */
export type NoteBatchError =
  /** Slot is `Empty` or `Recovering` — rename runs only while unlocked. */
  | { kind: "VaultNotUnlocked" }
  /** UI bug-canary; the orchestrator only ever passes canonical v7 UUIDs. */
  | { kind: "InvalidNoteId" }
  /** An inbound note was deleted between the rewrite plan and the commit. */
  | { kind: "NoteNotFound" }
  /** A rewritten body exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB). */
  | { kind: "PlaintextTooLarge" }
  /** AEAD-tag failure decoding an existing blob (non-distinguishing, §6.4). */
  | { kind: "CannotDecrypt" }
  /** `<vault>/notes` is a regular file, not a directory — bug-canary. */
  | { kind: "NotesDirNotADirectory" }
  /** Residual filesystem failure during resolution, a read, or the commit. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `Io` variant. */
export function isBatchIoError(
  e: NoteBatchError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
