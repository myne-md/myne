// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                       (IoFailureKind)
//   - core/src/plugins/snapshots/error.rs               (SnapshotError)
//   - core/src/plugins/snapshots/commands.rs            (SnapshotMeta)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `snapshots`
 * Tauri plugin's four commands (MYND-96).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-carrying
 * variants nest as `{"kind": "<Outer>", "detail": <inner>}`; unit variants are
 * `{"kind": "<VariantName>"}`. Closed set — adding a variant is an IPC contract
 * change requiring the Rust enum + this mirror to move together.
 */
export type SnapshotError =
  /** Slot is `Empty` or `Recovering` — the vault must be unlocked. */
  | { kind: "VaultNotUnlocked" }
  /** UI bug-canary; the backend always returns canonical v7 UUIDs. */
  | { kind: "InvalidNoteId" }
  /** The supplied snapshot id is not a valid UUIDv7. */
  | { kind: "InvalidSnapshotId" }
  /** No snapshot file matches `<note>__<snapshot>.myn`. */
  | { kind: "SnapshotNotFound" }
  /** AEAD/tamper failure decrypting the snapshot — non-distinguishing (§6.4). */
  | { kind: "CannotDecrypt" }
  /** `<vault>/notes` (or `snapshots`) resolved to a non-directory. */
  | { kind: "NotesDirNotADirectory" }
  /** Residual filesystem failure, reduced to a closed kind. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/**
 * Decrypt-free metadata for one snapshot, as returned by `snapshot_list`.
 * Field names mirror the Rust `SnapshotMeta` serde shape (snake_case).
 */
export interface SnapshotMeta {
  /** UUIDv7 string identifying the snapshot (its time component is the capture time). */
  snapshot_uuid: string;
  /** Capture time, ms since the Unix epoch, derived from the UUIDv7 (no decrypt). */
  captured_at_ms: number;
  /** On-disk size of the snapshot blob, bytes. */
  size_bytes: number;
}
