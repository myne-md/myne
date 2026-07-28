// IPC bindings for the `snapshots` Tauri plugin (MYND-96) — the read/management
// surface for encrypted per-note version history. Thin wrappers over the four
// `plugin:snapshots|*` commands; the heavy lifting (decrypt-free listing,
// in-memory preview decrypt, atomic undoable restore, retention prune) is all
// backend-side. The file-recovery UI (MYND-97) builds on these directly — the
// backend is real, so no mock layer is needed.
//
// All reject with a `SnapshotError` (see `src/types/snapshot-error.ts`).

import { invoke } from "../platform/core";
import type { SnapshotMeta } from "../types/snapshot-error";

/**
 * List a note's encrypted snapshots, newest-first. Decrypt-free — each entry
 * carries `snapshot_uuid`, `captured_at_ms`, and `size_bytes` derived from the
 * filename + stat. Returns `[]` for a note with no snapshots.
 */
export async function snapshotList(noteId: string): Promise<SnapshotMeta[]> {
  return await invoke<SnapshotMeta[]>("plugin:snapshots|snapshot_list", {
    noteId,
  });
}

/**
 * Decrypt a selected snapshot in memory and return its plaintext. Never writes
 * plaintext to disk. Rejects `SnapshotNotFound` if the snapshot is gone,
 * `CannotDecrypt` on tamper.
 */
export async function snapshotPreview(
  noteId: string,
  snapshotUuid: string,
): Promise<string> {
  return await invoke<string>("plugin:snapshots|snapshot_preview", {
    noteId,
    snapshotUuid,
  });
}

/**
 * Restore a selected snapshot. The backend atomically captures the current note
 * as the undo point first, then overwrites the live note — so a wrong restore
 * is itself recoverable.
 */
export async function snapshotRestore(
  noteId: string,
  snapshotUuid: string,
): Promise<void> {
  await invoke<void>("plugin:snapshots|snapshot_restore", {
    noteId,
    snapshotUuid,
  });
}

/**
 * Apply the retention policy to a note's snapshots now (manual cleanup of
 * out-of-window history; the eager write-path prune already runs on every
 * snapshot create). Resolves to the number of snapshots removed.
 */
export async function snapshotPrune(noteId: string): Promise<number> {
  return await invoke<number>("plugin:snapshots|snapshot_prune", { noteId });
}
