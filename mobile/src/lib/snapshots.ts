// IPC bindings for the mobile `snapshots` plugin — per-note encrypted version
// history (shared core in `myne-core::plugins::snapshots`). Thin wrappers over
// the four `plugin:snapshots|*` commands. Mobile captures snapshots on note
// writes via `MobileHooks::capture_snapshot`, so this read/restore surface has
// real data. Mirrors the desktop `src/notes/snapshots.ts` arg convention.

import { invoke } from "../platform/core";
import type { ResolvedIdentity } from "@myne/resolved-identity";

/** One snapshot row — mirror of the Rust `SnapshotMeta` (derived from filename +
 *  stat, decrypt-free). */
export interface SnapshotMeta {
  snapshot_uuid: string;
  /** Capture time (UNIX ms) — the snapshot UUIDv7's embedded clock. */
  captured_at_ms: number;
  size_bytes: number;
  /**
   * Who made this revision, as the backend resolved it (`collab-provenance` task
   * 2/3). This binding dropped the field while the desktop's mirror carried it, so
   * the phone's version history could not say whose change a row was — one of the
   * reasons the two clients did not show the same history of the same note.
   */
  resolved_author: ResolvedIdentity;
}

/** A note's snapshots, newest-first. `[]` when none. Decrypt-free. */
export function snapshotList(noteId: string): Promise<SnapshotMeta[]> {
  return invoke<SnapshotMeta[]>("plugin:snapshots|snapshot_list", { noteId });
}

/** Decrypt one snapshot in memory → plaintext (never written to disk). */
export function snapshotPreview(noteId: string, snapshotUuid: string): Promise<string> {
  return invoke<string>("plugin:snapshots|snapshot_preview", { noteId, snapshotUuid });
}

/** Restore a snapshot — the backend captures the current note as an undo point
 *  first, then overwrites, so a wrong restore is itself recoverable. */
export function snapshotRestore(noteId: string, snapshotUuid: string): Promise<void> {
  return invoke<void>("plugin:snapshots|snapshot_restore", { noteId, snapshotUuid });
}

/** Apply the retention policy now; resolves to the number removed. */
export function snapshotPrune(noteId: string): Promise<number> {
  return invoke<number>("plugin:snapshots|snapshot_prune", { noteId });
}
