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
 * set is a superset of `NoteUpdateError`'s — the batch is N `note_update`
 * AEAD pipelines committed under one transaction, so every per-note failure
 * mode is reachable. A failure on ANY note aborts the WHOLE batch with the
 * vault left pre-rename; there is no per-item partial-success surface, and
 * the tag never names which note failed.
 *
 * The **one exception**, and the reason this file's summary used to be wrong
 * (myne#300): `CommittedPendingPublish` means the batch got past the commit
 * marker. There the vault is NOT left pre-rename — the rewrite completes at
 * the next vault open whatever the caller does. Callers must not roll back on
 * it; use `isBatchCommitted` rather than assuming a rejection means nothing
 * happened.
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
  /** Residual filesystem failure during resolution, a read, or the STAGE
   *  phase — the vault really is unchanged. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /**
   * The batch **committed** and publishing it did not finish (myne#300).
   *
   * The `.rename-journal` marker is durable and deliberately left on disk, so
   * the backend's roll-forward pass publishes the remaining blobs at the next
   * vault open. The rename HAPPENED; rolling the optimistic UI back shows the
   * user the old title for a change that is already on disk and reappears
   * after the next unlock. Until that pass runs the vault reads inconsistently
   * — an inbound note may still carry `[[Old Title]]`.
   */
  | { kind: "CommittedPendingPublish"; detail: { io_error_kind: IoFailureKind } }
  /** `tokio::task::spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" }
  | { kind: "LiveSessionOpen" };

/**
 * Did this rejection leave the vault CHANGED? True only for
 * `CommittedPendingPublish` (myne#300).
 *
 * Takes `unknown` because it is called from a `catch`, where the value is not
 * yet known to be a `NoteBatchError` at all — and answering "no" for anything
 * unrecognized is the safe default: it rolls back, which is what every caller
 * did unconditionally before this existed.
 */
export function isBatchCommitted(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { kind?: unknown }).kind === "CommittedPendingPublish"
  );
}
